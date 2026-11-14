-- Phase 6: auth/register separation, worker deferral, scheduler, account controls, GL catalog.
-- Forward only. Customer liability postings stay on the existing journal functions.
-- Institutional asset balances are not invented. Manual journals stay ungranted.
CREATE ROLE freehold_scheduler LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE freehold_backup LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION NOBYPASSRLS;
COMMENT ON ROLE freehold_scheduler IS 'Standing-instruction runner. Calls scheduler_run_due only. Cannot bind sessions or claim the outbox.';
COMMENT ON ROLE freehold_backup IS 'Replication login for base backup and WAL archive. No application table DML and no financial functions.';
COMMENT ON ROLE freehold_auth IS 'Authentication process only. Password verification, registration, and session bind/revoke. No financial posting.';
COMMENT ON ROLE freehold_api IS 'Financial API. Cannot bind, find, or revoke authentication sessions and cannot register users.';

BEGIN;
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;

GRANT USAGE ON SCHEMA freehold TO freehold_scheduler, freehold_backup;

-- Outbox availability and quarantine. Pending work is dispatched_at IS NULL AND quarantined_at IS NULL.
ALTER TABLE freehold.outbox_events
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN quarantined_at timestamptz,
  ADD COLUMN quarantine_reason text;
ALTER TABLE freehold.outbox_events DROP CONSTRAINT IF EXISTS outbox_events_quarantine_check;
ALTER TABLE freehold.outbox_events ADD CONSTRAINT outbox_events_quarantine_check
  CHECK ((quarantined_at IS NULL AND quarantine_reason IS NULL) OR (quarantined_at IS NOT NULL AND quarantine_reason IS NOT NULL AND dispatched_at IS NULL));
CREATE INDEX outbox_available_idx ON freehold.outbox_events(available_at, created_at, id)
  WHERE dispatched_at IS NULL AND quarantined_at IS NULL;

DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='freehold.worker_inbox'::regclass AND contype='c' LOOP
    EXECUTE format('ALTER TABLE freehold.worker_inbox DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE freehold.worker_inbox ADD CONSTRAINT worker_inbox_status_check CHECK (status IN ('PROCESSING','PROCESSED','QUARANTINED'));
ALTER TABLE freehold.worker_inbox ADD CONSTRAINT worker_inbox_attempt_check CHECK (attempt_count > 0);
ALTER TABLE freehold.worker_inbox ADD CONSTRAINT worker_inbox_terminal_check CHECK (
  (status='PROCESSING' AND processed_at IS NULL) OR
  (status='PROCESSED' AND processed_at IS NOT NULL) OR
  (status='QUARANTINED' AND processed_at IS NULL));

CREATE TABLE freehold.worker_heartbeats (
  worker_id uuid PRIMARY KEY,
  seen_at timestamptz NOT NULL,
  last_error text
);

CREATE OR REPLACE FUNCTION freehold.worker_claim_outbox(p_worker_id uuid,p_limit integer DEFAULT 25,p_lease_seconds integer DEFAULT 30)
RETURNS TABLE(event_id uuid,operation_id uuid,aggregate_id uuid,event_type text,payload_version integer,payload jsonb,
 created_at timestamptz,actor_id uuid,attempt_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE candidate record; new_attempt integer;
BEGIN
 IF p_worker_id IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
  RAISE EXCEPTION 'INVALID_WORKER_CLAIM' USING ERRCODE='22023';
 END IF;
 FOR candidate IN
  SELECT o.id AS event_id,o.operation_id,o.aggregate_id,o.event_type,o.payload_version,o.payload,o.created_at,i.actor_id
  FROM freehold.outbox_events o
  JOIN freehold.idempotency_requests i ON i.operation_id=o.operation_id
  LEFT JOIN freehold.worker_inbox inbox ON inbox.event_id=o.id
  WHERE o.dispatched_at IS NULL
   AND o.quarantined_at IS NULL
   AND o.available_at<=clock_timestamp()
   AND (inbox.event_id IS NULL OR (inbox.status='PROCESSING' AND inbox.lease_until<=clock_timestamp()))
  ORDER BY o.available_at,o.created_at,o.id
  LIMIT p_limit
  FOR UPDATE OF o SKIP LOCKED
 LOOP
  new_attempt := NULL;
  INSERT INTO freehold.worker_inbox AS inbox_row(event_id,worker_id,status,claimed_at,lease_until,attempt_count)
  VALUES(candidate.event_id,p_worker_id,'PROCESSING',clock_timestamp(),clock_timestamp()+make_interval(secs=>p_lease_seconds),1)
  ON CONFLICT ON CONSTRAINT worker_inbox_pkey DO UPDATE SET worker_id=EXCLUDED.worker_id,status='PROCESSING',claimed_at=EXCLUDED.claimed_at,
   lease_until=EXCLUDED.lease_until,attempt_count=inbox_row.attempt_count+1,processed_at=NULL
   WHERE inbox_row.status IS DISTINCT FROM 'QUARANTINED'
  RETURNING inbox_row.attempt_count INTO new_attempt;
  IF new_attempt IS NULL THEN CONTINUE; END IF;
  UPDATE freehold.outbox_events o SET attempt_count=o.attempt_count+1 WHERE o.id=candidate.event_id;
  RETURN QUERY SELECT candidate.event_id,candidate.operation_id,candidate.aggregate_id,candidate.event_type,
   candidate.payload_version,candidate.payload,candidate.created_at,candidate.actor_id,new_attempt;
 END LOOP;
END $$;

-- Owning worker only. Attempt 8 quarantines. Earlier attempts push available_at and the lease together
-- so another worker cannot reclaim the event during backoff. Delivery stays at-least-once.
CREATE FUNCTION freehold.worker_defer_outbox(p_worker_id uuid, p_event_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE inbox freehold.worker_inbox; delay_seconds integer;
BEGIN
 IF p_worker_id IS NULL OR p_event_id IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 200 THEN
  RAISE EXCEPTION 'INVALID_WORKER_DEFER' USING ERRCODE='22023';
 END IF;
 SELECT * INTO inbox FROM freehold.worker_inbox
  WHERE event_id=p_event_id AND worker_id=p_worker_id AND status='PROCESSING' AND lease_until>clock_timestamp()
  FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('deferred',false,'reason','NOT_OWNED'); END IF;
 IF inbox.attempt_count>=8 THEN
  UPDATE freehold.worker_inbox SET status='QUARANTINED', lease_until=clock_timestamp() WHERE event_id=p_event_id;
  UPDATE freehold.outbox_events SET quarantined_at=clock_timestamp(), quarantine_reason=left(btrim(p_reason),200)
   WHERE id=p_event_id AND dispatched_at IS NULL AND quarantined_at IS NULL;
  RETURN jsonb_build_object('deferred',true,'quarantined',true,'attemptCount',inbox.attempt_count);
 END IF;
 delay_seconds := least(3600, power(2, inbox.attempt_count)::integer);
 UPDATE freehold.worker_inbox SET lease_until=clock_timestamp()+make_interval(secs=>delay_seconds) WHERE event_id=p_event_id;
 UPDATE freehold.outbox_events SET available_at=clock_timestamp()+make_interval(secs=>delay_seconds)
  WHERE id=p_event_id AND quarantined_at IS NULL AND dispatched_at IS NULL;
 RETURN jsonb_build_object('deferred',true,'quarantined',false,'attemptCount',inbox.attempt_count,'delaySeconds',delay_seconds);
END $$;

CREATE OR REPLACE FUNCTION freehold.worker_backlog_status()
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
 SELECT jsonb_build_object(
  'count', count(*) FILTER (WHERE quarantined_at IS NULL),
  'oldestAgeSeconds', CASE WHEN count(*) FILTER (WHERE quarantined_at IS NULL)=0 THEN NULL
    ELSE floor(extract(epoch FROM clock_timestamp()-min(created_at) FILTER (WHERE quarantined_at IS NULL)))::bigint END,
  'quarantinedCount', count(*) FILTER (WHERE quarantined_at IS NOT NULL))
 FROM freehold.outbox_events WHERE dispatched_at IS NULL
$$;

CREATE FUNCTION freehold.worker_record_heartbeat(p_worker_id uuid, p_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 IF p_worker_id IS NULL THEN RAISE EXCEPTION 'INVALID_WORKER_HEARTBEAT' USING ERRCODE='22023'; END IF;
 IF p_note IS NOT NULL AND length(p_note)>200 THEN RAISE EXCEPTION 'INVALID_WORKER_HEARTBEAT' USING ERRCODE='22023'; END IF;
 INSERT INTO freehold.worker_heartbeats(worker_id,seen_at,last_error) VALUES (p_worker_id,clock_timestamp(),p_note)
 ON CONFLICT (worker_id) DO UPDATE SET seen_at=EXCLUDED.seen_at, last_error=EXCLUDED.last_error;
END $$;

-- Institutional step-up is a dual-controlled risk policy. Customer thresholds cannot raise it.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid='freehold.risk_policies'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%MAX_SINGLE_TRANSFER%' LOOP
    EXECUTE format('ALTER TABLE freehold.risk_policies DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE freehold.risk_policies ADD CONSTRAINT risk_policies_rule_code_check CHECK (rule_code IN (
 'MAX_SINGLE_TRANSFER','DAILY_OUTGOING_LIMIT','ACCOUNT_TRANSFER_BLOCK','VELOCITY_OUTGOING_COUNT',
 'FAILED_TRANSFER_BURST','UNUSUAL_TRANSFER_SIZE','FROZEN_ACCOUNT_RETRY','IDEMPOTENCY_CONFLICT_BURST','HIGH_VALUE_STEP_UP'));

CREATE OR REPLACE FUNCTION freehold._risk_policy_canonical(p_parameters jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE scope text; rule text; account uuid; currency text; enabled boolean;
 minor text; count_value integer; window_value integer; multiple integer;
BEGIN
 IF jsonb_typeof(p_parameters)<>'object' THEN RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023'; END IF;
 scope:=p_parameters->>'scope'; rule:=p_parameters->>'ruleCode';
 IF scope NOT IN ('INSTITUTION','ACCOUNT') OR rule NOT IN (
  'MAX_SINGLE_TRANSFER','DAILY_OUTGOING_LIMIT','ACCOUNT_TRANSFER_BLOCK','VELOCITY_OUTGOING_COUNT',
  'FAILED_TRANSFER_BURST','UNUSUAL_TRANSFER_SIZE','FROZEN_ACCOUNT_RETRY','IDEMPOTENCY_CONFLICT_BURST','HIGH_VALUE_STEP_UP') THEN
  RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023';
 END IF;
 IF p_parameters ? 'timezone' AND p_parameters->>'timezone' IS NOT NULL AND p_parameters->>'timezone'<>'UTC' THEN
  RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023';
 END IF;
 IF jsonb_typeof(p_parameters->'enabled')<>'boolean' THEN RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023'; END IF;
 enabled:=(p_parameters->>'enabled')::boolean;
 IF rule='IDEMPOTENCY_CONFLICT_BURST' AND scope<>'INSTITUTION' THEN RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023'; END IF;
 IF rule='HIGH_VALUE_STEP_UP' AND scope<>'INSTITUTION' THEN RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023'; END IF;
 IF scope='ACCOUNT' THEN
  IF p_parameters->>'accountId' IS NULL THEN RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023'; END IF;
  account:=(p_parameters->>'accountId')::uuid;
  IF NOT EXISTS(SELECT 1 FROM freehold.accounts WHERE id=account) THEN RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023'; END IF;
 ELSE account:=NULL; END IF;
 currency:=NULLIF(p_parameters->>'currencyCode','');
 IF currency IS NOT NULL AND NOT EXISTS(SELECT 1 FROM freehold.currencies WHERE code=currency) THEN
  RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023';
 END IF;
 minor:=p_parameters->>'thresholdMinor';
 IF minor IS NOT NULL AND minor!~'^[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023'; END IF;
 IF minor IS NOT NULL AND minor::numeric>9223372036854775807::numeric THEN RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023'; END IF;
 count_value:=NULLIF(p_parameters->>'thresholdCount','')::integer;
 window_value:=NULLIF(p_parameters->>'windowSeconds','')::integer;
 multiple:=NULLIF(p_parameters->>'sizeMultiple','')::integer;
 IF rule IN ('MAX_SINGLE_TRANSFER','DAILY_OUTGOING_LIMIT','HIGH_VALUE_STEP_UP') AND minor IS NULL THEN RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023'; END IF;
 IF rule IN ('VELOCITY_OUTGOING_COUNT','FAILED_TRANSFER_BURST','FROZEN_ACCOUNT_RETRY','IDEMPOTENCY_CONFLICT_BURST')
    AND (count_value IS NULL OR count_value<1 OR window_value IS NULL OR window_value<1 OR window_value>31622400) THEN
  RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023';
 END IF;
 IF rule='UNUSUAL_TRANSFER_SIZE' AND (multiple IS NULL OR multiple<2 OR multiple>1000) THEN RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023'; END IF;
 IF rule<>'UNUSUAL_TRANSFER_SIZE' THEN multiple:=NULL; END IF;
 IF rule NOT IN ('VELOCITY_OUTGOING_COUNT','FAILED_TRANSFER_BURST','FROZEN_ACCOUNT_RETRY','IDEMPOTENCY_CONFLICT_BURST','UNUSUAL_TRANSFER_SIZE') THEN
  count_value:=NULL; window_value:=NULL;
 END IF;
 IF rule NOT IN ('MAX_SINGLE_TRANSFER','DAILY_OUTGOING_LIMIT','UNUSUAL_TRANSFER_SIZE','HIGH_VALUE_STEP_UP') THEN minor:=NULL; END IF;
 IF rule='UNUSUAL_TRANSFER_SIZE' AND count_value IS NULL THEN count_value:=3; END IF;
 RETURN jsonb_build_object('accountId',account,'currencyCode',currency,'enabled',enabled,'ruleCode',rule,'scope',scope,
  'sizeMultiple',multiple,'thresholdCount',count_value,'thresholdMinor',minor,'timezone','UTC','windowSeconds',window_value);
EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023';
END $$;

CREATE TABLE freehold.account_controls (
 account_id uuid PRIMARY KEY REFERENCES freehold.accounts(id),
 outgoing_enabled boolean NOT NULL DEFAULT true,
 per_transfer_limit_minor bigint CHECK (per_transfer_limit_minor IS NULL OR per_transfer_limit_minor>0),
 daily_limit_minor bigint CHECK (daily_limit_minor IS NULL OR daily_limit_minor>0),
 monthly_limit_minor bigint CHECK (monthly_limit_minor IS NULL OR monthly_limit_minor>0),
 new_destination_review_seconds integer CHECK (new_destination_review_seconds IS NULL OR new_destination_review_seconds BETWEEN 0 AND 31622400),
 step_up_threshold_minor bigint CHECK (step_up_threshold_minor IS NULL OR step_up_threshold_minor>0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE freehold.trusted_destinations (
 account_id uuid NOT NULL REFERENCES freehold.accounts(id),
 destination_account_id uuid NOT NULL REFERENCES freehold.accounts(id),
 trusted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (account_id, destination_account_id),
 CHECK (account_id<>destination_account_id)
);

-- Adds rejections only. A null customer cap does not clear an institutional cap already applied.
CREATE FUNCTION freehold._apply_account_controls(p_actor uuid, p_source uuid, p_destination uuid, p_currency text, p_amount bigint, p_operation uuid, p_failure text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE ctl freehold.account_controls; spent numeric; month_start timestamptz; day_start timestamptz;
 inst_step bigint; effective_step bigint; enrolled boolean; secret text; verified timestamptz; failure text := p_failure;
BEGIN
 SELECT * INTO ctl FROM freehold.account_controls WHERE account_id=p_source;
 day_start := date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
 month_start := date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
 IF failure IS NULL AND ctl.account_id IS NOT NULL AND NOT ctl.outgoing_enabled THEN failure := 'LIMIT_OUTGOING_DISABLED'; END IF;
 IF failure IS NULL AND ctl.per_transfer_limit_minor IS NOT NULL AND p_amount>ctl.per_transfer_limit_minor THEN failure := 'LIMIT_SINGLE_TRANSFER'; END IF;
 IF failure IS NULL AND ctl.daily_limit_minor IS NOT NULL THEN
  SELECT COALESCE(sum(amount_minor::numeric),0) INTO spent FROM freehold.transfers
   WHERE source_account_id=p_source AND state='COMPLETED' AND currency_code=p_currency AND created_at>=day_start;
  IF spent+p_amount::numeric>ctl.daily_limit_minor::numeric THEN failure := 'LIMIT_DAILY_OUTGOING'; END IF;
 END IF;
 IF failure IS NULL AND ctl.monthly_limit_minor IS NOT NULL THEN
  SELECT COALESCE(sum(amount_minor::numeric),0) INTO spent FROM freehold.transfers
   WHERE source_account_id=p_source AND state='COMPLETED' AND currency_code=p_currency AND created_at>=month_start;
  IF spent+p_amount::numeric>ctl.monthly_limit_minor::numeric THEN failure := 'LIMIT_MONTHLY_OUTGOING'; END IF;
 END IF;
 IF failure IS NULL AND ctl.new_destination_review_seconds IS NOT NULL THEN
  IF NOT EXISTS (SELECT 1 FROM freehold.trusted_destinations t WHERE t.account_id=p_source AND t.destination_account_id=p_destination
    AND t.trusted_at+make_interval(secs=>ctl.new_destination_review_seconds)<=clock_timestamp()) THEN
   failure := 'LIMIT_NEW_DESTINATION';
  END IF;
 END IF;
 SELECT min(p.threshold_minor) INTO inst_step FROM freehold.risk_policies p
  WHERE p.enabled AND p.rule_code='HIGH_VALUE_STEP_UP' AND p.scope='INSTITUTION' AND p.threshold_minor IS NOT NULL
    AND (p.currency_code IS NULL OR p.currency_code=p_currency);
 effective_step := CASE
  WHEN inst_step IS NULL THEN ctl.step_up_threshold_minor
  WHEN ctl.step_up_threshold_minor IS NULL THEN inst_step
  ELSE least(inst_step, ctl.step_up_threshold_minor) END;
 IF failure IS NULL AND effective_step IS NOT NULL AND p_amount>=effective_step THEN
  IF SESSION_USER='freehold_scheduler' THEN
   failure := 'LIMIT_STEP_UP_REQUIRED';
  ELSE
   SELECT u.totp_secret_encrypted IS NOT NULL INTO enrolled FROM freehold.users u WHERE u.id=p_actor;
   secret := current_setting('freehold.session_secret', true);
   SELECT s.two_factor_verified_at INTO verified FROM freehold.api_sessions s
    WHERE secret IS NOT NULL AND secret ~ '^[0-9a-f]{64}$' AND s.secret_hash=sha256(decode(secret,'hex'))
      AND s.principal_id=p_actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp();
   IF NOT COALESCE(enrolled,false) THEN failure := 'STEP_UP_UNAVAILABLE';
   ELSIF verified IS NULL OR verified<clock_timestamp()-interval '5 minutes' THEN failure := 'LIMIT_STEP_UP_REQUIRED';
   END IF;
  END IF;
 END IF;
 IF failure IS NOT NULL AND failure LIKE 'LIMIT_%' THEN
  PERFORM freehold._open_risk_flag(failure,'LOW',p_source,p_actor,p_operation,jsonb_build_object('amountMinor',p_amount::text,'currency',p_currency));
 END IF;
 RETURN failure;
END $$;

CREATE OR REPLACE FUNCTION freehold.execute_internal_transfer(p_actor uuid,p_source uuid,p_destination uuid,p_currency text,p_amount bigint,p_key text,p_correlation uuid DEFAULT gen_random_uuid())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
DECLARE r freehold.idempotency_requests; src freehold.accounts; dst freehold.accounts;
 enabled boolean; failure text; transfer uuid:=gen_random_uuid(); journal uuid; debit uuid; credit uuid;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 PERFORM freehold._actor(p_actor);
 IF p_source IS NULL OR p_destination IS NULL OR p_source=p_destination OR p_currency IS NULL OR p_correlation IS NULL THEN
  RAISE EXCEPTION 'INVALID_TRANSFER' USING ERRCODE='22023';
 END IF;
 r:=freehold._claim(p_actor,'TRANSFER',p_key,jsonb_build_object('sourceAccountId',p_source,'destinationAccountId',p_destination,'currency',p_currency,'amountMinor',p_amount::text));
 IF r.response_body IS NOT NULL THEN RETURN r.response_body; END IF;
 PERFORM freehold._amount(p_amount);
 SELECT c.enabled INTO enabled FROM freehold.currencies c WHERE code=p_currency FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_CURRENCY' USING ERRCODE='22023'; END IF;
 PERFORM id FROM freehold.accounts WHERE id IN (p_source,p_destination) ORDER BY id FOR UPDATE;
 SELECT * INTO src FROM freehold.accounts WHERE id=p_source;
 IF NOT FOUND OR src.owner_user_id<>p_actor THEN RAISE EXCEPTION 'SOURCE_NOT_AUTHORIZED' USING ERRCODE='42501'; END IF;
 IF src.currency_code<>p_currency THEN RAISE EXCEPTION 'CURRENCY_MISMATCH' USING ERRCODE='22023'; END IF;
 SELECT * INTO dst FROM freehold.accounts WHERE id=p_destination;
 IF NOT FOUND THEN
  RETURN freehold._finish_with_metadata(r.operation_id,r.operation_id,p_correlation,
   jsonb_build_object('state','REJECTED','error','DESTINATION_UNAVAILABLE'),422,
   jsonb_build_object('internalFailureCode','DESTINATION_NOT_FOUND'));
 END IF;
 IF dst.currency_code<>p_currency OR dst.status<>'ACTIVE' THEN
  failure:=CASE WHEN dst.currency_code<>p_currency THEN 'DESTINATION_CURRENCY_MISMATCH'
   WHEN dst.status='FROZEN' THEN 'DESTINATION_FROZEN' ELSE 'DESTINATION_CLOSED' END;
  RETURN freehold._finish_with_metadata(r.operation_id,r.operation_id,p_correlation,
   jsonb_build_object('state','REJECTED','error','DESTINATION_UNAVAILABLE'),422,
   jsonb_build_object('internalFailureCode',failure));
 END IF;
 IF dst.available_minor::numeric+p_amount::numeric>9223372036854775807::numeric THEN
  RETURN freehold._finish_with_metadata(r.operation_id,r.operation_id,p_correlation,
   jsonb_build_object('state','REJECTED','error','DESTINATION_UNAVAILABLE'),422,
   jsonb_build_object('internalFailureCode','DESTINATION_BALANCE_LIMIT'));
 END IF;
 failure:=CASE WHEN NOT enabled THEN 'CURRENCY_DISABLED'
  WHEN src.status='FROZEN' THEN 'ACCOUNT_FROZEN'
  WHEN src.status<>'ACTIVE' THEN 'ACCOUNT_CLOSED'
  WHEN src.available_minor<p_amount THEN 'INSUFFICIENT_FUNDS' END;
 failure:=freehold._apply_transfer_controls(p_actor,p_source,p_currency,p_amount,r.operation_id,failure);
 failure:=freehold._apply_account_controls(p_actor,p_source,p_destination,p_currency,p_amount,r.operation_id,failure);
 INSERT INTO freehold.transfers(id,operation_id,initiator_user_id,source_account_id,destination_account_id,currency_code,amount_minor,state,idempotency_key,request_hash,correlation_id,failure_code)
 VALUES(transfer,r.operation_id,p_actor,p_source,p_destination,p_currency,p_amount,CASE WHEN failure IS NULL THEN 'COMPLETED' ELSE 'REJECTED' END,p_key,r.request_hash,p_correlation,failure);
 IF failure IS NOT NULL THEN
  RETURN freehold._finish(r.operation_id,transfer,p_correlation,jsonb_build_object('transferId',transfer,'state','REJECTED','error',failure),422);
 END IF;
 SELECT id INTO STRICT debit FROM freehold.ledger_accounts WHERE customer_account_id=p_source AND bucket='AVAILABLE';
 SELECT id INTO STRICT credit FROM freehold.ledger_accounts WHERE customer_account_id=p_destination AND bucket='AVAILABLE';
 journal:=freehold._post_pair(r.operation_id,p_actor,'INTERNAL_TRANSFER',p_correlation,debit,credit,p_amount,transfer);
 RETURN freehold._finish(r.operation_id,transfer,p_correlation,jsonb_build_object('transferId',transfer,'journalId',journal,'state','COMPLETED','currency',p_currency,'amountMinor',p_amount::text));
END $$;

CREATE FUNCTION freehold._institutional_cap(p_account uuid, p_rule text)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
 SELECT min(p.threshold_minor) FROM freehold.risk_policies p
  JOIN freehold.accounts a ON a.id=p_account
  WHERE p.enabled AND p.rule_code=p_rule AND p.threshold_minor IS NOT NULL
    AND (p.currency_code IS NULL OR p.currency_code=a.currency_code)
    AND ((p.scope='INSTITUTION' AND p.account_id IS NULL) OR (p.scope='ACCOUNT' AND p.account_id=p_account))
$$;

CREATE FUNCTION freehold.account_controls_get(p_actor uuid, p_account uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE a freehold.accounts; ctl freehold.account_controls;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 SELECT * INTO a FROM freehold.accounts WHERE id=p_account;
 IF NOT FOUND OR a.owner_user_id<>p_actor THEN RAISE EXCEPTION 'SOURCE_NOT_AUTHORIZED' USING ERRCODE='42501'; END IF;
 SELECT * INTO ctl FROM freehold.account_controls WHERE account_id=p_account;
 RETURN jsonb_build_object(
  'accountId',p_account,'currency',a.currency_code,
  'outgoingEnabled',COALESCE(ctl.outgoing_enabled,true),
  'perTransferLimitMinor',ctl.per_transfer_limit_minor::text,
  'dailyLimitMinor',ctl.daily_limit_minor::text,
  'monthlyLimitMinor',ctl.monthly_limit_minor::text,
  'newDestinationReviewSeconds',ctl.new_destination_review_seconds,
  'stepUpThresholdMinor',ctl.step_up_threshold_minor::text,
  'institutionalSingleTransferMinor',freehold._institutional_cap(p_account,'MAX_SINGLE_TRANSFER')::text,
  'institutionalDailyMinor',freehold._institutional_cap(p_account,'DAILY_OUTGOING_LIMIT')::text,
  'institutionalStepUpMinor',freehold._institutional_cap(p_account,'HIGH_VALUE_STEP_UP')::text,
  'institutionalTransferBlocked',EXISTS(SELECT 1 FROM freehold.risk_policies p WHERE p.enabled AND p.rule_code='ACCOUNT_TRANSFER_BLOCK'
    AND (p.currency_code IS NULL OR p.currency_code=a.currency_code)
    AND ((p.scope='ACCOUNT' AND p.account_id=p_account) OR p.scope='INSTITUTION')),
  'trustedDestinations',COALESCE((SELECT jsonb_agg(jsonb_build_object('destinationAccountId',t.destination_account_id,'trustedAt',freehold._ts_utc(t.trusted_at)) ORDER BY t.trusted_at)
    FROM freehold.trusted_destinations t WHERE t.account_id=p_account),'[]'::jsonb));
END $$;

CREATE FUNCTION freehold.account_controls_set(p_actor uuid, p_account uuid, p_patch jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE a freehold.accounts; ctl freehold.account_controls; outgoing boolean; per_limit bigint; daily_limit bigint; monthly_limit bigint; review integer; step_up bigint;
 inst_single bigint; inst_daily bigint; inst_step bigint; raw text;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 IF jsonb_typeof(p_patch)<>'object' THEN RAISE EXCEPTION 'INVALID_ACCOUNT_CONTROL' USING ERRCODE='22023'; END IF;
 SELECT * INTO a FROM freehold.accounts WHERE id=p_account FOR UPDATE;
 IF NOT FOUND OR a.owner_user_id<>p_actor THEN RAISE EXCEPTION 'SOURCE_NOT_AUTHORIZED' USING ERRCODE='42501'; END IF;
 SELECT * INTO ctl FROM freehold.account_controls WHERE account_id=p_account;
 IF p_patch ? 'outgoingEnabled' AND jsonb_typeof(p_patch->'outgoingEnabled')<>'boolean' THEN RAISE EXCEPTION 'INVALID_ACCOUNT_CONTROL' USING ERRCODE='22023'; END IF;
 outgoing := CASE WHEN p_patch ? 'outgoingEnabled' THEN (p_patch->>'outgoingEnabled')::boolean ELSE COALESCE(ctl.outgoing_enabled,true) END;
 per_limit := ctl.per_transfer_limit_minor; daily_limit := ctl.daily_limit_minor; monthly_limit := ctl.monthly_limit_minor;
 review := ctl.new_destination_review_seconds; step_up := ctl.step_up_threshold_minor;
 IF p_patch ? 'perTransferLimitMinor' THEN
  raw := p_patch->>'perTransferLimitMinor';
  IF raw IS NOT NULL AND raw<>'' AND raw!~'^[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'INVALID_ACCOUNT_CONTROL' USING ERRCODE='22023'; END IF;
  per_limit := NULLIF(raw,'')::bigint;
 END IF;
 IF p_patch ? 'dailyLimitMinor' THEN
  raw := p_patch->>'dailyLimitMinor';
  IF raw IS NOT NULL AND raw<>'' AND raw!~'^[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'INVALID_ACCOUNT_CONTROL' USING ERRCODE='22023'; END IF;
  daily_limit := NULLIF(raw,'')::bigint;
 END IF;
 IF p_patch ? 'monthlyLimitMinor' THEN
  raw := p_patch->>'monthlyLimitMinor';
  IF raw IS NOT NULL AND raw<>'' AND raw!~'^[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'INVALID_ACCOUNT_CONTROL' USING ERRCODE='22023'; END IF;
  monthly_limit := NULLIF(raw,'')::bigint;
 END IF;
 IF p_patch ? 'stepUpThresholdMinor' THEN
  raw := p_patch->>'stepUpThresholdMinor';
  IF raw IS NOT NULL AND raw<>'' AND raw!~'^[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'INVALID_ACCOUNT_CONTROL' USING ERRCODE='22023'; END IF;
  step_up := NULLIF(raw,'')::bigint;
 END IF;
 IF p_patch ? 'newDestinationReviewSeconds' THEN
  raw := p_patch->>'newDestinationReviewSeconds';
  IF raw IS NULL OR raw='' THEN review := NULL;
  ELSIF raw!~'^[0-9]+$' THEN RAISE EXCEPTION 'INVALID_ACCOUNT_CONTROL' USING ERRCODE='22023';
  ELSE
   review := raw::integer;
   IF review<0 OR review>31622400 THEN RAISE EXCEPTION 'INVALID_ACCOUNT_CONTROL' USING ERRCODE='22023'; END IF;
  END IF;
 END IF;
 inst_single := freehold._institutional_cap(p_account,'MAX_SINGLE_TRANSFER');
 inst_daily := freehold._institutional_cap(p_account,'DAILY_OUTGOING_LIMIT');
 inst_step := freehold._institutional_cap(p_account,'HIGH_VALUE_STEP_UP');
 IF inst_single IS NOT NULL AND per_limit IS NOT NULL AND per_limit>inst_single THEN RAISE EXCEPTION 'INVALID_ACCOUNT_CONTROL' USING ERRCODE='22023'; END IF;
 IF inst_daily IS NOT NULL AND daily_limit IS NOT NULL AND daily_limit>inst_daily THEN RAISE EXCEPTION 'INVALID_ACCOUNT_CONTROL' USING ERRCODE='22023'; END IF;
 IF inst_step IS NOT NULL AND step_up IS NOT NULL AND step_up>inst_step THEN RAISE EXCEPTION 'INVALID_ACCOUNT_CONTROL' USING ERRCODE='22023'; END IF;
 INSERT INTO freehold.account_controls(account_id,outgoing_enabled,per_transfer_limit_minor,daily_limit_minor,monthly_limit_minor,new_destination_review_seconds,step_up_threshold_minor,updated_at)
 VALUES (p_account,outgoing,per_limit,daily_limit,monthly_limit,review,step_up,clock_timestamp())
 ON CONFLICT (account_id) DO UPDATE SET outgoing_enabled=EXCLUDED.outgoing_enabled, per_transfer_limit_minor=EXCLUDED.per_transfer_limit_minor,
  daily_limit_minor=EXCLUDED.daily_limit_minor, monthly_limit_minor=EXCLUDED.monthly_limit_minor,
  new_destination_review_seconds=EXCLUDED.new_destination_review_seconds, step_up_threshold_minor=EXCLUDED.step_up_threshold_minor,
  updated_at=clock_timestamp();
 RETURN freehold.account_controls_get(p_actor,p_account);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
 RAISE EXCEPTION 'INVALID_ACCOUNT_CONTROL' USING ERRCODE='22023';
END $$;

CREATE FUNCTION freehold.trusted_destination_add(p_actor uuid, p_account uuid, p_destination uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE src freehold.accounts; dst freehold.accounts;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 SELECT * INTO src FROM freehold.accounts WHERE id=p_account;
 IF NOT FOUND OR src.owner_user_id<>p_actor THEN RAISE EXCEPTION 'SOURCE_NOT_AUTHORIZED' USING ERRCODE='42501'; END IF;
 SELECT * INTO dst FROM freehold.accounts WHERE id=p_destination AND status='ACTIVE' AND currency_code=src.currency_code;
 IF NOT FOUND OR p_destination=p_account THEN RAISE EXCEPTION 'INVALID_ACCOUNT_CONTROL' USING ERRCODE='22023'; END IF;
 INSERT INTO freehold.trusted_destinations(account_id,destination_account_id,trusted_at)
 VALUES (p_account,p_destination,clock_timestamp())
 ON CONFLICT (account_id,destination_account_id) DO NOTHING;
 RETURN freehold.account_controls_get(p_actor,p_account);
END $$;

-- UTC calendar only. MONTHLY uses PostgreSQL month arithmetic in the UTC session zone.
-- A missed window runs once when the worker returns, then advances. It does not burst-catch-up.
CREATE TABLE freehold.scheduled_transfers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL REFERENCES freehold.users(id),
 source_account_id uuid NOT NULL REFERENCES freehold.accounts(id),
 destination_account_id uuid NOT NULL REFERENCES freehold.accounts(id),
 currency_code text NOT NULL REFERENCES freehold.currencies(code),
 amount_minor bigint NOT NULL CHECK (amount_minor>0),
 cadence text NOT NULL CHECK (cadence IN ('ONCE','DAILY','WEEKLY','MONTHLY')),
 timezone text NOT NULL DEFAULT 'UTC' CHECK (timezone='UTC'),
 next_execution_at timestamptz NOT NULL,
 status text NOT NULL CHECK (status IN ('ACTIVE','CANCELLED','COMPLETED','FAILED')),
 request_key text NOT NULL,
 request_hash bytea NOT NULL CHECK (octet_length(request_hash)=32),
 attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 cancelled_at timestamptz,
 last_execution_at timestamptz,
 last_status text,
 last_error text,
 UNIQUE (owner_user_id, request_key)
);
CREATE INDEX scheduled_transfers_due_idx ON freehold.scheduled_transfers(next_execution_at,id) WHERE status='ACTIVE';
CREATE TABLE freehold.scheduled_transfer_executions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 instruction_id uuid NOT NULL REFERENCES freehold.scheduled_transfers(id),
 scheduled_for timestamptz NOT NULL,
 operation_id uuid,
 outcome text NOT NULL,
 error_code text,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (instruction_id, scheduled_for)
);

CREATE FUNCTION freehold._schedule_slot(p_at timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

CREATE FUNCTION freehold._advance_schedule(p_at timestamptz, p_cadence text)
RETURNS timestamptz LANGUAGE plpgsql STABLE SET timezone='UTC' AS $$
DECLARE nxt timestamptz := p_at; guard integer := 0;
BEGIN
 IF p_cadence NOT IN ('DAILY','WEEKLY','MONTHLY') THEN RETURN p_at; END IF;
 LOOP
  nxt := CASE p_cadence WHEN 'DAILY' THEN nxt+interval '1 day' WHEN 'WEEKLY' THEN nxt+interval '7 days' ELSE nxt+interval '1 month' END;
  guard := guard+1;
  EXIT WHEN nxt>clock_timestamp() OR guard>36;
 END LOOP;
 RETURN nxt;
END $$;

CREATE FUNCTION freehold.scheduled_transfer_create(p_actor uuid,p_source uuid,p_destination uuid,p_currency text,p_amount bigint,p_cadence text,p_next timestamptz,p_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE src freehold.accounts; dst freehold.accounts; digest bytea; existing freehold.scheduled_transfers; created freehold.scheduled_transfers;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 PERFORM freehold._actor(p_actor);
 IF p_key IS NULL OR length(btrim(p_key)) NOT BETWEEN 1 AND 200 OR p_cadence NOT IN ('ONCE','DAILY','WEEKLY','MONTHLY') OR p_next IS NULL THEN
  RAISE EXCEPTION 'INVALID_SCHEDULE' USING ERRCODE='22023';
 END IF;
 IF p_next<=clock_timestamp()+interval '30 seconds' OR p_next>clock_timestamp()+interval '2 years' THEN
  RAISE EXCEPTION 'INVALID_SCHEDULE' USING ERRCODE='22023';
 END IF;
 PERFORM freehold._amount(p_amount);
 SELECT * INTO src FROM freehold.accounts WHERE id=p_source;
 IF NOT FOUND OR src.owner_user_id<>p_actor OR src.currency_code<>p_currency THEN RAISE EXCEPTION 'SOURCE_NOT_AUTHORIZED' USING ERRCODE='42501'; END IF;
 SELECT * INTO dst FROM freehold.accounts WHERE id=p_destination AND currency_code=p_currency AND status='ACTIVE';
 IF NOT FOUND OR p_source=p_destination THEN RAISE EXCEPTION 'INVALID_SCHEDULE' USING ERRCODE='22023'; END IF;
 digest := sha256(convert_to(p_source::text||':'||p_destination::text||':'||p_currency||':'||p_amount::text||':'||p_cadence||':'||freehold._schedule_slot(p_next),'UTF8'));
 SELECT * INTO existing FROM freehold.scheduled_transfers WHERE owner_user_id=p_actor AND request_key=p_key;
 IF FOUND THEN
  IF existing.request_hash<>digest THEN RAISE EXCEPTION 'INVALID_SCHEDULE' USING ERRCODE='22023'; END IF;
  created := existing;
 ELSE
  INSERT INTO freehold.scheduled_transfers(owner_user_id,source_account_id,destination_account_id,currency_code,amount_minor,cadence,next_execution_at,status,request_key,request_hash)
  VALUES (p_actor,p_source,p_destination,p_currency,p_amount,p_cadence,p_next,'ACTIVE',p_key,digest) RETURNING * INTO created;
 END IF;
 RETURN jsonb_build_object('instructionId',created.id,'status',created.status,'cadence',created.cadence,'timezone','UTC',
  'nextExecutionAt',freehold._ts_utc(created.next_execution_at),'amountMinor',created.amount_minor::text,'currency',created.currency_code,
  'sourceAccountId',created.source_account_id,'destinationAccountId',created.destination_account_id);
END $$;

CREATE FUNCTION freehold.scheduled_transfer_cancel(p_actor uuid, p_instruction uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE row freehold.scheduled_transfers;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 SELECT * INTO row FROM freehold.scheduled_transfers WHERE id=p_instruction FOR UPDATE;
 IF NOT FOUND OR row.owner_user_id<>p_actor THEN RAISE EXCEPTION 'INVALID_SCHEDULE' USING ERRCODE='22023'; END IF;
 IF row.status='ACTIVE' THEN
  UPDATE freehold.scheduled_transfers SET status='CANCELLED', cancelled_at=clock_timestamp(), last_status='CANCELLED' WHERE id=p_instruction RETURNING * INTO row;
 ELSIF row.status NOT IN ('CANCELLED') THEN
  RAISE EXCEPTION 'INVALID_SCHEDULE' USING ERRCODE='22023';
 END IF;
 RETURN jsonb_build_object('instructionId',row.id,'status',row.status,'cancelledAt',freehold._ts_utc(row.cancelled_at),'nextExecutionAt',freehold._ts_utc(row.next_execution_at));
END $$;

CREATE FUNCTION freehold.scheduled_transfer_list(p_actor uuid, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE lim integer := least(GREATEST(COALESCE(p_limit,50),1),100);
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'instructionId',s.id,'status',s.status,'cadence',s.cadence,'timezone','UTC','currency',s.currency_code,
   'amountMinor',s.amount_minor::text,'sourceAccountId',s.source_account_id,'destinationAccountId',s.destination_account_id,
   'nextExecutionAt',freehold._ts_utc(s.next_execution_at),'lastExecutionAt',freehold._ts_utc(s.last_execution_at),
   'lastStatus',s.last_status,'lastError',s.last_error,'attemptCount',s.attempt_count,
   'executions',COALESCE((SELECT jsonb_agg(jsonb_build_object('scheduledFor',freehold._ts_utc(e.scheduled_for),'outcome',e.outcome,'errorCode',e.error_code,'operationId',e.operation_id,'recordedAt',freehold._ts_utc(e.recorded_at)) ORDER BY e.recorded_at DESC)
     FROM (SELECT * FROM freehold.scheduled_transfer_executions e WHERE e.instruction_id=s.id ORDER BY e.recorded_at DESC LIMIT 20) e),'[]'::jsonb)
  ) ORDER BY s.created_at DESC) FROM (SELECT * FROM freehold.scheduled_transfers WHERE owner_user_id=p_actor ORDER BY created_at DESC LIMIT lim) s),'[]'::jsonb);
END $$;

-- Does not reserve funds. Calls the posting function as the instruction owner.
-- SESSION_USER is freehold_scheduler, so the API session gate does not apply; ownership, freeze,
-- suspension, idempotency, and insufficient funds still do. Step-up cannot be satisfied here.
CREATE FUNCTION freehold.scheduler_run_due(p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET timezone='UTC' SET lock_timeout='5s' AS $$
DECLARE lim integer; rec freehold.scheduled_transfers; slot timestamptz; key text; result jsonb; outcome text; err text; op uuid; results jsonb := '[]'::jsonb;
BEGIN
 IF SESSION_USER IS DISTINCT FROM 'freehold_scheduler' THEN RAISE EXCEPTION 'SCHEDULER_ROLE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'INVALID_SCHEDULE' USING ERRCODE='22023'; END IF;
 lim := p_limit;
 FOR rec IN SELECT * FROM freehold.scheduled_transfers WHERE status='ACTIVE' AND next_execution_at<=clock_timestamp() ORDER BY next_execution_at,id LIMIT lim FOR UPDATE SKIP LOCKED LOOP
  BEGIN
   slot := rec.next_execution_at;
   key := 'sched:'||rec.id::text||':'||freehold._schedule_slot(slot);
   result := freehold.execute_internal_transfer(rec.owner_user_id,rec.source_account_id,rec.destination_account_id,rec.currency_code,rec.amount_minor,key,gen_random_uuid());
   outcome := result->>'state';
   err := result->>'error';
   op := NULLIF(result->>'operationId','')::uuid;
   INSERT INTO freehold.scheduled_transfer_executions(instruction_id,scheduled_for,operation_id,outcome,error_code)
   VALUES (rec.id,slot,op,COALESCE(outcome,'UNKNOWN'),err) ON CONFLICT (instruction_id,scheduled_for) DO NOTHING;
   IF outcome='COMPLETED' AND rec.cadence='ONCE' THEN
    UPDATE freehold.scheduled_transfers SET status='COMPLETED', last_execution_at=clock_timestamp(), last_status='COMPLETED', last_error=NULL WHERE id=rec.id;
   ELSIF outcome='COMPLETED' THEN
    UPDATE freehold.scheduled_transfers SET next_execution_at=freehold._advance_schedule(slot,rec.cadence), last_execution_at=clock_timestamp(), last_status='COMPLETED', last_error=NULL, attempt_count=0 WHERE id=rec.id;
   ELSIF rec.cadence='ONCE' AND rec.attempt_count+1>=3 THEN
    UPDATE freehold.scheduled_transfers SET status='FAILED', attempt_count=attempt_count+1, last_execution_at=clock_timestamp(), last_status='FAILED', last_error=err WHERE id=rec.id;
   ELSIF rec.cadence='ONCE' THEN
    UPDATE freehold.scheduled_transfers SET attempt_count=attempt_count+1, next_execution_at=clock_timestamp()+interval '1 hour', last_execution_at=clock_timestamp(), last_status='FAILED', last_error=err WHERE id=rec.id;
   ELSE
    UPDATE freehold.scheduled_transfers SET next_execution_at=freehold._advance_schedule(slot,rec.cadence), last_execution_at=clock_timestamp(), last_status='FAILED', last_error=err WHERE id=rec.id;
   END IF;
   results := results || jsonb_build_array(jsonb_build_object('instructionId',rec.id,'outcome',outcome,'error',err,'operationId',op));
  EXCEPTION WHEN OTHERS THEN
   UPDATE freehold.scheduled_transfers SET last_status='FAILED', last_error=left(SQLERRM,200), last_execution_at=clock_timestamp(),
     next_execution_at=GREATEST(next_execution_at, clock_timestamp()+interval '1 minute')
    WHERE id=rec.id AND status='ACTIVE';
   results := results || jsonb_build_array(jsonb_build_object('instructionId',rec.id,'outcome','FAILED','error',SQLERRM));
  END;
 END LOOP;
 RETURN jsonb_build_object('processed',jsonb_array_length(results),'results',results);
END $$;

-- Presentation catalog only. Balances are computed from ledger_entries or reported NOT_AVAILABLE.
-- These rows are not ledger_accounts, so customer-liability class checks stay intact.
CREATE TABLE freehold.gl_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 code text NOT NULL UNIQUE,
 classification text NOT NULL CHECK (classification IN (
  'CUSTOMER_LIABILITY','INSTITUTIONAL_ASSET','INSTITUTIONAL_LIABILITY','EQUITY','REVENUE','EXPENSE','SUSPENSE','SETTLEMENT_CLEARING')),
 currency_code text NOT NULL REFERENCES freehold.currencies(code),
 posting_enabled boolean NOT NULL DEFAULT false CHECK (posting_enabled=false),
 UNIQUE (classification, currency_code)
);
CREATE FUNCTION freehold._gl_seed_currency() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 INSERT INTO freehold.gl_accounts(code,classification,currency_code,posting_enabled)
 SELECT NEW.code||'_'||v.classification, v.classification, NEW.code, false
 FROM (VALUES ('CUSTOMER_LIABILITY'),('INSTITUTIONAL_ASSET'),('INSTITUTIONAL_LIABILITY'),('EQUITY'),('REVENUE'),('EXPENSE'),('SUSPENSE'),('SETTLEMENT_CLEARING')) AS v(classification)
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER currencies_seed_gl AFTER INSERT ON freehold.currencies
 FOR EACH ROW EXECUTE FUNCTION freehold._gl_seed_currency();
INSERT INTO freehold.gl_accounts(code,classification,currency_code,posting_enabled)
SELECT c.code||'_'||v.classification, v.classification, c.code, false
FROM freehold.currencies c
CROSS JOIN (VALUES ('CUSTOMER_LIABILITY'),('INSTITUTIONAL_ASSET'),('INSTITUTIONAL_LIABILITY'),('EQUITY'),('REVENUE'),('EXPENSE'),('SUSPENSE'),('SETTLEMENT_CLEARING')) AS v(classification)
ON CONFLICT DO NOTHING;

CREATE FUNCTION freehold.institutional_manual_journal()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'MANUAL_JOURNAL_DISABLED' USING ERRCODE='55000';
END $$;

CREATE FUNCTION freehold._gl_reader(p_actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 IF NOT (freehold._has_governance_capability(p_actor,'AUDITOR') OR freehold._has_governance_capability(p_actor,'FINANCIAL_REVIEWER')
   OR freehold._has_governance_capability(p_actor,'INSTITUTION_ADMIN') OR freehold._has_governance_capability(p_actor,'COMPLIANCE_OFFICER')) THEN
  RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501';
 END IF;
END $$;

CREATE FUNCTION freehold.gl_report(p_actor uuid, p_kind text, p_currency text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE kind text := p_kind; currency text := NULLIF(p_currency,'');
BEGIN
 PERFORM freehold._gl_reader(p_actor);
 IF kind NOT IN ('TRIAL_BALANCE','ACTIVITY','BALANCE_SHEET','INCOME_STATEMENT','CUSTOMER_RECONCILIATION','SUSPENSE','JOURNAL_EXPORT') THEN
  RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE='22023';
 END IF;
 IF currency IS NOT NULL AND NOT EXISTS(SELECT 1 FROM freehold.currencies WHERE code=currency) THEN
  RAISE EXCEPTION 'INVALID_CURRENCY' USING ERRCODE='22023';
 END IF;
 IF kind='TRIAL_BALANCE' THEN
  RETURN jsonb_build_object('kind','TRIAL_BALANCE','filingStatus','NOT_A_REGULATORY_FILING','generatedAt',freehold._ts_utc(clock_timestamp()),
   'note','Recorded lines are customer liabilities and sandbox equity only. Other classifications are NOT_AVAILABLE and are excluded from the totals.',
   'byCurrency',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'currency',c.code,'exponent',c.minor_unit_exponent,
      'customerLiabilityMinor',COALESCE(s.liability,0)::text,
      'sandboxEquityDebitMinor',COALESCE(s.sandbox,0)::text,
      'recordedBalanced',COALESCE(s.liability,0)=COALESCE(s.sandbox,0),
      'unavailable',jsonb_build_array('INSTITUTIONAL_ASSET','INSTITUTIONAL_LIABILITY','EQUITY','REVENUE','EXPENSE','SUSPENSE','SETTLEMENT_CLEARING'))
     ORDER BY c.code)
    FROM freehold.currencies c
    LEFT JOIN (
      SELECT la.currency_code,
        sum(CASE WHEN la.accounting_class='LIABILITY' AND la.customer_account_id IS NOT NULL AND e.side='CREDIT' THEN e.amount_minor::numeric
                 WHEN la.accounting_class='LIABILITY' AND la.customer_account_id IS NOT NULL THEN -e.amount_minor::numeric ELSE 0 END) AS liability,
        sum(CASE WHEN la.bucket='SANDBOX_EQUITY' AND e.side='DEBIT' THEN e.amount_minor::numeric WHEN la.bucket='SANDBOX_EQUITY' THEN -e.amount_minor::numeric ELSE 0 END) AS sandbox
      FROM freehold.ledger_entries e JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id
      GROUP BY la.currency_code) s ON s.currency_code=c.code
    WHERE currency IS NULL OR c.code=currency),'[]'::jsonb));
 END IF;
 IF kind='CUSTOMER_RECONCILIATION' THEN
  RETURN jsonb_build_object('kind','CUSTOMER_RECONCILIATION','filingStatus','NOT_A_REGULATORY_FILING','generatedAt',freehold._ts_utc(clock_timestamp()),
   'externalAssets',jsonb_build_object('status','NOT_AVAILABLE','reason','No external asset register is connected. Sandbox funding is not an asset.'),
   'lines',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'currency',x.currency_code,
      'ledgerLiabilityMinor',x.ledger_minor::text,
      'projectionMinor',x.projection_minor::text,
      'differenceMinor',(x.ledger_minor-x.projection_minor)::text,
      'status',CASE WHEN x.ledger_minor=x.projection_minor THEN 'RECONCILED' ELSE 'MISMATCH' END) ORDER BY x.currency_code)
    FROM (
      SELECT a.currency_code,
        COALESCE((SELECT sum(CASE WHEN e.side='CREDIT' THEN e.amount_minor::numeric ELSE -e.amount_minor::numeric END)
          FROM freehold.ledger_entries e JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id
          WHERE la.customer_account_id IS NOT NULL AND la.accounting_class='LIABILITY' AND la.currency_code=a.currency_code),0) AS ledger_minor,
        COALESCE(sum(a.available_minor::numeric+a.reserved_minor::numeric),0) AS projection_minor
      FROM freehold.accounts a WHERE currency IS NULL OR a.currency_code=currency GROUP BY a.currency_code) x),'[]'::jsonb));
 END IF;
 IF kind='BALANCE_SHEET' THEN
  RETURN jsonb_build_object('kind','BALANCE_SHEET','filingStatus','NOT_A_REGULATORY_FILING','generatedAt',freehold._ts_utc(clock_timestamp()),
   'assets',jsonb_build_object('status','NOT_AVAILABLE','reason','No institutional asset accounts have a connected balance source.'),
   'liabilities',jsonb_build_object('customerLiabilities','RECORDED','otherInstitutionalLiabilities','NOT_AVAILABLE'),
   'equity',jsonb_build_object('sandboxEquityContra','RECORDED','otherEquity','NOT_AVAILABLE'),
   'equation','NOT_AVAILABLE',
   'note','The accounting equation is not presented as balanced while assets are NOT_AVAILABLE.');
 END IF;
 IF kind='INCOME_STATEMENT' THEN
  RETURN jsonb_build_object('kind','INCOME_STATEMENT','filingStatus','NOT_A_REGULATORY_FILING','generatedAt',freehold._ts_utc(clock_timestamp()),
   'revenue',jsonb_build_object('status','NOT_AVAILABLE','reason','No revenue subledger is posted.'),
   'expenses',jsonb_build_object('status','NOT_AVAILABLE','reason','No expense subledger is posted.'),
   'netIncome',jsonb_build_object('status','NOT_AVAILABLE','reason','Revenue and expenses are not recorded.'));
 END IF;
 IF kind='SUSPENSE' THEN
  RETURN jsonb_build_object('kind','SUSPENSE','filingStatus','NOT_A_REGULATORY_FILING','generatedAt',freehold._ts_utc(clock_timestamp()),
   'lines',COALESCE((SELECT jsonb_agg(jsonb_build_object('currency',g.currency_code,'classification','SUSPENSE','journalCount',0,
     'balanceStatus','RECORDED_ZERO','balanceMinor','0',
     'note','No suspense journals have been posted. This zero is a count, not an estimate.') ORDER BY g.currency_code)
    FROM freehold.gl_accounts g WHERE g.classification='SUSPENSE' AND (currency IS NULL OR g.currency_code=currency)),'[]'::jsonb));
 END IF;
 IF kind='ACTIVITY' THEN
  RETURN jsonb_build_object('kind','ACTIVITY','filingStatus','NOT_A_REGULATORY_FILING','generatedAt',freehold._ts_utc(clock_timestamp()),
   'manualJournal','DISABLED',
   'lines',COALESCE((SELECT jsonb_agg(jsonb_build_object('currency',la.currency_code,'classification',
      CASE WHEN la.customer_account_id IS NOT NULL THEN 'CUSTOMER_LIABILITY' WHEN la.bucket='SANDBOX_EQUITY' THEN 'SANDBOX_EQUITY' ELSE la.accounting_class END,
      'debitMinor',COALESCE(sum(e.amount_minor::numeric) FILTER (WHERE e.side='DEBIT'),0)::text,
      'creditMinor',COALESCE(sum(e.amount_minor::numeric) FILTER (WHERE e.side='CREDIT'),0)::text,
      'status','RECORDED') ORDER BY la.currency_code)
    FROM freehold.ledger_entries e JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id
    WHERE currency IS NULL OR la.currency_code=currency
    GROUP BY la.currency_code, CASE WHEN la.customer_account_id IS NOT NULL THEN 'CUSTOMER_LIABILITY' WHEN la.bucket='SANDBOX_EQUITY' THEN 'SANDBOX_EQUITY' ELSE la.accounting_class END),'[]'::jsonb));
 END IF;
 RETURN jsonb_build_object('kind','JOURNAL_EXPORT','filingStatus','NOT_A_REGULATORY_FILING','generatedAt',freehold._ts_utc(clock_timestamp()),
  'manualJournal','DISABLED',
  'entries',COALESCE((SELECT jsonb_agg(jsonb_build_object('journalId',j.id,'kind',j.kind,'currency',e.currency_code,'side',e.side,'amountMinor',e.amount_minor::text,'recordedAt',freehold._ts_utc(j.recorded_at)) ORDER BY j.recorded_at DESC, e.line_no)
    FROM (SELECT * FROM freehold.ledger_journals ORDER BY recorded_at DESC LIMIT 100) j
    JOIN freehold.ledger_entries e ON e.journal_id=j.id
    WHERE currency IS NULL OR e.currency_code=currency),'[]'::jsonb));
END $$;

CREATE FUNCTION freehold.operations_health(p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE backlog jsonb; seen timestamptz; worker_state text;
BEGIN
 PERFORM freehold._gl_reader(p_actor);
 backlog := freehold.worker_backlog_status();
 SELECT max(seen_at) INTO seen FROM freehold.worker_heartbeats;
 worker_state := CASE WHEN seen IS NULL THEN 'UNAVAILABLE' WHEN seen<clock_timestamp()-interval '120 seconds' THEN 'STALE' ELSE 'RUNNING' END;
 RETURN jsonb_build_object(
  'generatedAt',freehold._ts_utc(clock_timestamp()),
  'database','CONNECTED',
  'workerProcess',worker_state,
  'workerLastSeenAt',freehold._ts_utc(seen),
  'outboxBacklogCount',(backlog->>'count')::bigint,
  'outboxOldestAgeSeconds',backlog->'oldestAgeSeconds',
  'outboxQuarantinedCount',(backlog->>'quarantinedCount')::bigint,
  'backupHealth',jsonb_build_object('status','UNAVAILABLE','reason','Backup evidence is not stored in this database.'),
  'latestVerifier',jsonb_build_object('status','UNAVAILABLE','reason','Verifier output is external evidence and is not stored in this database.'));
END $$;

REVOKE EXECUTE ON FUNCTION freehold.register_user(text,text,bytea) FROM freehold_api;
GRANT EXECUTE ON FUNCTION freehold.register_user(text,text,bytea) TO freehold_auth;

REVOKE ALL ON FUNCTION
 freehold.worker_defer_outbox(uuid,uuid,text),
 freehold.worker_record_heartbeat(uuid,text),
 freehold.worker_backlog_status(),
 freehold._apply_account_controls(uuid,uuid,uuid,text,bigint,uuid,text),
 freehold._institutional_cap(uuid,text),
 freehold.account_controls_get(uuid,uuid),
 freehold.account_controls_set(uuid,uuid,jsonb),
 freehold.trusted_destination_add(uuid,uuid,uuid),
 freehold.scheduled_transfer_create(uuid,uuid,uuid,text,bigint,text,timestamptz,text),
 freehold.scheduled_transfer_cancel(uuid,uuid),
 freehold.scheduled_transfer_list(uuid,integer),
 freehold._schedule_slot(timestamptz),
 freehold._advance_schedule(timestamptz,text),
 freehold.scheduler_run_due(integer),
 freehold._gl_seed_currency(),
 freehold.institutional_manual_journal(),
 freehold._gl_reader(uuid),
 freehold.gl_report(uuid,text,text),
 freehold.operations_health(uuid)
 FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier,freehold_auth,freehold_scheduler,freehold_backup;

GRANT EXECUTE ON FUNCTION
 freehold.account_controls_get(uuid,uuid),
 freehold.account_controls_set(uuid,uuid,jsonb),
 freehold.trusted_destination_add(uuid,uuid,uuid),
 freehold.scheduled_transfer_create(uuid,uuid,uuid,text,bigint,text,timestamptz,text),
 freehold.scheduled_transfer_cancel(uuid,uuid),
 freehold.scheduled_transfer_list(uuid,integer),
 freehold.gl_report(uuid,text,text),
 freehold.operations_health(uuid)
 TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.worker_defer_outbox(uuid,uuid,text), freehold.worker_record_heartbeat(uuid,text), freehold.worker_backlog_status() TO freehold_worker;
GRANT EXECUTE ON FUNCTION freehold.scheduler_run_due(integer) TO freehold_scheduler;

REVOKE ALL ON TABLE freehold.worker_heartbeats, freehold.account_controls, freehold.trusted_destinations,
 freehold.scheduled_transfers, freehold.scheduled_transfer_executions, freehold.gl_accounts
 FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier,freehold_auth,freehold_scheduler,freehold_backup;
GRANT SELECT (id,code,classification,currency_code,posting_enabled) ON freehold.gl_accounts TO freehold_verifier;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA freehold FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE freehold_owner IN SCHEMA freehold REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC,freehold_scheduler,freehold_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE freehold_owner IN SCHEMA freehold REVOKE ALL ON TABLES FROM PUBLIC,freehold_scheduler,freehold_backup;

RESET ROLE;
COMMIT;
