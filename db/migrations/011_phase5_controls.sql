-- Phase 5: bound API sessions, transfer limits, statements, compliance cases, reporting.
-- Forward only. Financial posting still goes through the existing journal functions.
-- freehold_api must present a session secret that freehold_auth created. A stolen
-- API password cannot mint that secret. The auth password still can: keep it on
-- the authentication process only. Co-locating both passwords restores the old
-- boundary. Direct SELECT grants on ledger tables are unchanged.
CREATE ROLE freehold_auth LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
COMMENT ON ROLE freehold_auth IS 'Authentication process only. Can read password verifiers and bind session secrets. Cannot post or govern.';
COMMENT ON ROLE freehold_api IS 'Financial and governance API. p_actor is accepted only with a live session secret bound by freehold_auth. Direct table reads remain institution-wide.';

BEGIN;
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;

GRANT USAGE ON SCHEMA freehold TO freehold_auth;

CREATE TABLE freehold.api_sessions (
 id uuid PRIMARY KEY,
 principal_id uuid NOT NULL REFERENCES freehold.users(id),
 secret_hash bytea NOT NULL UNIQUE CHECK (octet_length(secret_hash)=32),
 auth_version bigint NOT NULL CHECK (auth_version>0),
 two_factor_verified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 CHECK (expires_at>created_at)
);
CREATE INDEX api_sessions_principal_idx ON freehold.api_sessions(principal_id, expires_at);

CREATE FUNCTION freehold._api_session_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SESSION_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF NEW.id<>OLD.id OR NEW.principal_id<>OLD.principal_id OR NEW.secret_hash<>OLD.secret_hash
    OR NEW.auth_version<>OLD.auth_version OR NEW.two_factor_verified_at IS DISTINCT FROM OLD.two_factor_verified_at
    OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
  RAISE EXCEPTION 'SESSION_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER api_sessions_guard BEFORE UPDATE OR DELETE ON freehold.api_sessions
 FOR EACH ROW EXECUTE FUNCTION freehold._api_session_guard();

CREATE FUNCTION freehold._require_bound_session(p_actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE secret text; u freehold.users; s freehold.api_sessions;
BEGIN
 -- session_user stays the login role inside SECURITY DEFINER functions.
 -- Superuser and the auth role are not this gate. freehold_api is.
 IF SESSION_USER IS DISTINCT FROM 'freehold_api' THEN RETURN; END IF;
 secret := current_setting('freehold.session_secret', true);
 IF secret IS NULL OR secret !~ '^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION 'SESSION_NOT_BOUND' USING ERRCODE='42501';
 END IF;
 SELECT * INTO u FROM freehold.users WHERE id=p_actor;
 IF NOT FOUND OR u.status<>'ACTIVE' THEN RAISE EXCEPTION 'SESSION_NOT_BOUND' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM freehold.api_sessions
  WHERE secret_hash=sha256(decode(secret,'hex')) AND principal_id=p_actor
    AND revoked_at IS NULL AND expires_at>clock_timestamp();
 IF NOT FOUND OR s.auth_version<>u.auth_version THEN RAISE EXCEPTION 'SESSION_NOT_BOUND' USING ERRCODE='42501'; END IF;
 IF u.totp_secret_encrypted IS NOT NULL AND s.two_factor_verified_at IS NULL THEN
  RAISE EXCEPTION 'SESSION_NOT_BOUND' USING ERRCODE='42501';
 END IF;
END $$;

CREATE FUNCTION freehold.auth_bind_session(p_actor uuid, p_auth_version bigint, p_secret bytea, p_two_factor timestamptz, p_ttl_seconds integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE u freehold.users; sid uuid := gen_random_uuid();
BEGIN
 IF p_secret IS NULL OR octet_length(p_secret)<>32 OR p_ttl_seconds IS NULL OR p_ttl_seconds<60 OR p_ttl_seconds>86400 THEN
  RAISE EXCEPTION 'INVALID_SESSION_BIND' USING ERRCODE='22023';
 END IF;
 IF p_two_factor IS NOT NULL AND p_two_factor>clock_timestamp()+interval '2 minutes' THEN
  RAISE EXCEPTION 'INVALID_SESSION_BIND' USING ERRCODE='22023';
 END IF;
 SELECT * INTO u FROM freehold.users WHERE id=p_actor AND status='ACTIVE' AND auth_version=p_auth_version;
 IF NOT FOUND THEN RAISE EXCEPTION 'SESSION_BIND_REJECTED' USING ERRCODE='42501'; END IF;
 IF u.totp_secret_encrypted IS NOT NULL AND p_two_factor IS NULL THEN
  RAISE EXCEPTION 'SESSION_BIND_REJECTED' USING ERRCODE='42501';
 END IF;
 INSERT INTO freehold.api_sessions(id,principal_id,secret_hash,auth_version,two_factor_verified_at,expires_at)
 VALUES (sid,p_actor,sha256(p_secret),p_auth_version,p_two_factor,clock_timestamp()+make_interval(secs => p_ttl_seconds));
 RETURN sid;
END $$;

CREATE FUNCTION freehold.auth_revoke_session(p_secret bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 IF p_secret IS NULL OR octet_length(p_secret)<>32 THEN RETURN; END IF;
 UPDATE freehold.api_sessions SET revoked_at=clock_timestamp()
  WHERE secret_hash=sha256(p_secret) AND revoked_at IS NULL;
END $$;

-- Capability and governance operation lists widen. Names are the PostgreSQL defaults.
ALTER TABLE freehold.governance_capabilities DROP CONSTRAINT governance_capabilities_capability_check;
ALTER TABLE freehold.governance_capabilities ADD CONSTRAINT governance_capabilities_capability_check
 CHECK (capability IN ('ACCOUNT_ADMIN','FINANCIAL_REVIEWER','SECURITY_ADMIN','AUDITOR','INSTITUTION_ADMIN','EMERGENCY_CONTROL','COMPLIANCE_OFFICER'));
ALTER TABLE freehold.governance_capability_history DROP CONSTRAINT governance_capability_history_capability_check;
ALTER TABLE freehold.governance_capability_history ADD CONSTRAINT governance_capability_history_capability_check
 CHECK (capability IN ('ACCOUNT_ADMIN','FINANCIAL_REVIEWER','SECURITY_ADMIN','AUDITOR','INSTITUTION_ADMIN','EMERGENCY_CONTROL','COMPLIANCE_OFFICER'));
ALTER TABLE freehold.governance_requests DROP CONSTRAINT governance_requests_operation_check;
ALTER TABLE freehold.governance_requests ADD CONSTRAINT governance_requests_operation_check
 CHECK (operation IN ('FREEZE_ACCOUNT','UNFREEZE_ACCOUNT','RESUME_WRITES','SET_RISK_POLICY'));

CREATE OR REPLACE FUNCTION freehold.governance_provision_capability(p_principal uuid,p_capability text,p_grantor text,p_enable boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE changed timestamptz:=clock_timestamp(); affected integer;
BEGIN
 IF p_capability NOT IN ('ACCOUNT_ADMIN','FINANCIAL_REVIEWER','SECURITY_ADMIN','AUDITOR','INSTITUTION_ADMIN','EMERGENCY_CONTROL','COMPLIANCE_OFFICER')
    OR p_grantor IS NULL OR length(btrim(p_grantor)) NOT BETWEEN 1 AND 200
    OR NOT EXISTS(SELECT 1 FROM freehold.users WHERE id=p_principal AND role='ADMIN' AND status='ACTIVE')
 THEN RAISE EXCEPTION 'INVALID_GOVERNANCE_PROVISIONING' USING ERRCODE='22023'; END IF;
 IF p_enable THEN
   INSERT INTO freehold.governance_capabilities(principal_id,capability,granted_at,granted_by) VALUES(p_principal,p_capability,changed,p_grantor)
   ON CONFLICT(principal_id,capability) DO UPDATE SET granted_at=EXCLUDED.granted_at,granted_by=EXCLUDED.granted_by,revoked_at=NULL,revoked_by=NULL;
   INSERT INTO freehold.governance_capability_history(principal_id,capability,event,changed_at,grantor_reference)
   VALUES(p_principal,p_capability,'GRANT',changed,p_grantor);
 ELSE
   UPDATE freehold.governance_capabilities SET revoked_at=changed,revoked_by=p_grantor
   WHERE principal_id=p_principal AND capability=p_capability AND revoked_at IS NULL;
   GET DIAGNOSTICS affected=ROW_COUNT;
   IF affected>0 THEN
     INSERT INTO freehold.governance_capability_history(principal_id,capability,event,changed_at,grantor_reference)
     VALUES(p_principal,p_capability,'REVOKE',changed,p_grantor);
   END IF;
 END IF;
 INSERT INTO freehold.governance_audit(event_type,executing_service,affected_resource,outcome,reason,metadata)
 VALUES('POLICY_CHANGE','deployment_migration',p_principal,CASE WHEN p_enable THEN 'CAPABILITY_GRANTED' ELSE 'CAPABILITY_REVOKED' END,
   p_grantor,jsonb_build_object('capability',p_capability));
END $$;

CREATE FUNCTION freehold._governance_actor_capability(p_operation text, p_role text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE
  WHEN p_operation='RESUME_WRITES' AND p_role='initiator' THEN 'EMERGENCY_CONTROL'
  WHEN p_operation='RESUME_WRITES' AND p_role='executor' THEN 'INSTITUTION_ADMIN'
  WHEN p_operation='SET_RISK_POLICY' THEN 'INSTITUTION_ADMIN'
  ELSE 'ACCOUNT_ADMIN' END
$$;

-- Risk policies. UTC calendar day is the only supported window origin.
CREATE TABLE freehold.risk_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 scope text NOT NULL CHECK (scope IN ('INSTITUTION','ACCOUNT')),
 account_id uuid REFERENCES freehold.accounts(id),
 currency_code text REFERENCES freehold.currencies(code),
 rule_code text NOT NULL CHECK (rule_code IN (
  'MAX_SINGLE_TRANSFER','DAILY_OUTGOING_LIMIT','ACCOUNT_TRANSFER_BLOCK','VELOCITY_OUTGOING_COUNT',
  'FAILED_TRANSFER_BURST','UNUSUAL_TRANSFER_SIZE','FROZEN_ACCOUNT_RETRY','IDEMPOTENCY_CONFLICT_BURST')),
 threshold_minor bigint CHECK (threshold_minor IS NULL OR threshold_minor>0),
 threshold_count integer CHECK (threshold_count IS NULL OR threshold_count>0),
 window_seconds integer CHECK (window_seconds IS NULL OR window_seconds BETWEEN 1 AND 31622400),
 size_multiple integer CHECK (size_multiple IS NULL OR size_multiple BETWEEN 2 AND 1000),
 timezone text NOT NULL DEFAULT 'UTC' CHECK (timezone='UTC'),
 enabled boolean NOT NULL,
 governance_request_id uuid NOT NULL REFERENCES freehold.governance_requests(id),
 identity_account uuid GENERATED ALWAYS AS (COALESCE(account_id,'00000000-0000-0000-0000-000000000000'::uuid)) STORED,
 identity_currency text GENERATED ALWAYS AS (COALESCE(currency_code,'')) STORED,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((scope='INSTITUTION' AND account_id IS NULL) OR (scope='ACCOUNT' AND account_id IS NOT NULL)),
 UNIQUE (scope, rule_code, identity_account, identity_currency)
);
CREATE TABLE freehold.risk_policy_changes (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 policy_id uuid NOT NULL REFERENCES freehold.risk_policies(id),
 governance_request_id uuid NOT NULL UNIQUE REFERENCES freehold.governance_requests(id),
 parameters jsonb NOT NULL CHECK (jsonb_typeof(parameters)='object'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER risk_policy_changes_immutable BEFORE UPDATE OR DELETE ON freehold.risk_policy_changes
 FOR EACH ROW EXECUTE FUNCTION freehold._governance_immutable();

CREATE TABLE freehold.risk_flags (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 rule_code text NOT NULL,
 severity text NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH')),
 account_id uuid REFERENCES freehold.accounts(id),
 actor_id uuid REFERENCES freehold.users(id),
 operation_id uuid,
 evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object'),
 status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','LINKED','DISMISSED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (account_id IS NOT NULL OR actor_id IS NOT NULL)
);
CREATE UNIQUE INDEX risk_flags_open_idx ON freehold.risk_flags(rule_code, COALESCE(account_id, actor_id))
 WHERE status='OPEN' AND rule_code IN ('FAILED_TRANSFER_BURST','FROZEN_ACCOUNT_RETRY','UNUSUAL_TRANSFER_SIZE','IDEMPOTENCY_CONFLICT_BURST');
CREATE INDEX risk_flags_recent_idx ON freehold.risk_flags(created_at DESC, id DESC);
CREATE TABLE freehold.risk_observations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id uuid NOT NULL REFERENCES freehold.users(id),
 kind text NOT NULL,
 key_hash bytea NOT NULL CHECK (octet_length(key_hash)=32),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER risk_observations_immutable BEFORE UPDATE OR DELETE ON freehold.risk_observations
 FOR EACH ROW EXECUTE FUNCTION freehold._governance_immutable();
CREATE FUNCTION freehold._risk_flag_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'RISK_FLAG_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF NEW.id<>OLD.id OR NEW.rule_code<>OLD.rule_code OR NEW.severity<>OLD.severity
    OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
    OR NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.evidence<>OLD.evidence OR NEW.created_at<>OLD.created_at
    OR NOT ((OLD.status='OPEN' AND NEW.status IN ('OPEN','LINKED','DISMISSED')) OR (OLD.status=NEW.status AND OLD.status<>'OPEN')) THEN
  RAISE EXCEPTION 'RISK_FLAG_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER risk_flags_guard BEFORE UPDATE OR DELETE ON freehold.risk_flags
 FOR EACH ROW EXECUTE FUNCTION freehold._risk_flag_guard();

CREATE INDEX transfers_source_completed_idx ON freehold.transfers(source_account_id, created_at) WHERE state='COMPLETED';
CREATE INDEX transfers_currency_completed_idx ON freehold.transfers(currency_code, created_at) WHERE state='COMPLETED';

CREATE FUNCTION freehold._open_risk_flag(p_rule text, p_severity text, p_account uuid, p_actor uuid, p_operation uuid, p_evidence jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 INSERT INTO freehold.risk_flags(rule_code,severity,account_id,actor_id,operation_id,evidence)
 VALUES (p_rule,p_severity,p_account,p_actor,p_operation,COALESCE(p_evidence,'{}'::jsonb));
EXCEPTION WHEN unique_violation THEN RETURN;
END $$;

-- Caller holds the source account FOR UPDATE before this runs. Institution-wide
-- daily and velocity policies are locked here, after the account lock.
CREATE FUNCTION freehold._apply_transfer_controls(p_actor uuid, p_source uuid, p_currency text, p_amount bigint, p_operation uuid, p_failure text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE pol freehold.risk_policies; spent numeric; n integer; prior_max bigint; prior_n integer;
 window_start timestamptz; day_start timestamptz; failure text := p_failure;
BEGIN
 PERFORM p.id FROM freehold.risk_policies p
  WHERE p.enabled AND p.scope='INSTITUTION' AND p.rule_code IN ('DAILY_OUTGOING_LIMIT','VELOCITY_OUTGOING_COUNT')
    AND (p.currency_code IS NULL OR p.currency_code=p_currency)
  ORDER BY p.id FOR UPDATE;
 day_start := date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
 IF failure IS NULL AND EXISTS (
   SELECT 1 FROM freehold.risk_policies p WHERE p.enabled AND p.rule_code='ACCOUNT_TRANSFER_BLOCK'
     AND (p.currency_code IS NULL OR p.currency_code=p_currency)
     AND ((p.scope='ACCOUNT' AND p.account_id=p_source) OR p.scope='INSTITUTION')) THEN
  failure := 'LIMIT_ACCOUNT_RESTRICTED';
 END IF;
 IF failure IS NULL AND EXISTS (
   SELECT 1 FROM freehold.risk_policies p WHERE p.enabled AND p.rule_code='MAX_SINGLE_TRANSFER' AND p.threshold_minor IS NOT NULL
     AND p.threshold_minor<p_amount AND (p.currency_code IS NULL OR p.currency_code=p_currency)
     AND ((p.scope='ACCOUNT' AND p.account_id=p_source) OR p.scope='INSTITUTION')) THEN
  failure := 'LIMIT_SINGLE_TRANSFER';
 END IF;
 FOR pol IN SELECT * FROM freehold.risk_policies p WHERE p.enabled AND p.rule_code='DAILY_OUTGOING_LIMIT' AND p.threshold_minor IS NOT NULL
   AND (p.currency_code IS NULL OR p.currency_code=p_currency)
   AND ((p.scope='ACCOUNT' AND p.account_id=p_source) OR p.scope='INSTITUTION') LOOP
  IF pol.scope='ACCOUNT' THEN
   SELECT COALESCE(sum(amount_minor::numeric),0) INTO spent FROM freehold.transfers
    WHERE source_account_id=p_source AND state='COMPLETED' AND created_at>=day_start
      AND (pol.currency_code IS NULL OR currency_code=pol.currency_code);
  ELSE
   SELECT COALESCE(sum(amount_minor::numeric),0) INTO spent FROM freehold.transfers
    WHERE state='COMPLETED' AND created_at>=day_start AND (pol.currency_code IS NULL OR currency_code=pol.currency_code);
  END IF;
  IF failure IS NULL AND spent+p_amount::numeric>pol.threshold_minor::numeric THEN failure := 'LIMIT_DAILY_OUTGOING'; END IF;
 END LOOP;
 FOR pol IN SELECT * FROM freehold.risk_policies p WHERE p.enabled AND p.rule_code='VELOCITY_OUTGOING_COUNT'
   AND p.threshold_count IS NOT NULL AND p.window_seconds IS NOT NULL
   AND (p.currency_code IS NULL OR p.currency_code=p_currency)
   AND ((p.scope='ACCOUNT' AND p.account_id=p_source) OR p.scope='INSTITUTION') LOOP
  window_start := clock_timestamp()-make_interval(secs => pol.window_seconds);
  IF pol.scope='ACCOUNT' THEN
   SELECT count(*) INTO n FROM freehold.transfers WHERE source_account_id=p_source AND state='COMPLETED' AND created_at>=window_start
     AND (pol.currency_code IS NULL OR currency_code=pol.currency_code);
  ELSE
   SELECT count(*) INTO n FROM freehold.transfers WHERE state='COMPLETED' AND created_at>=window_start
     AND (pol.currency_code IS NULL OR currency_code=pol.currency_code);
  END IF;
  IF failure IS NULL AND n+1>pol.threshold_count THEN failure := 'LIMIT_VELOCITY'; END IF;
 END LOOP;
 IF failure IS NOT NULL AND failure LIKE 'LIMIT_%' THEN
  PERFORM freehold._open_risk_flag(failure,'LOW',p_source,p_actor,p_operation,jsonb_build_object('amountMinor',p_amount::text,'currency',p_currency));
 END IF;
 FOR pol IN SELECT * FROM freehold.risk_policies p WHERE p.enabled AND p.rule_code='FAILED_TRANSFER_BURST'
   AND p.threshold_count IS NOT NULL AND p.window_seconds IS NOT NULL
   AND (p.scope='INSTITUTION' OR p.account_id=p_source) LOOP
  IF failure IS NOT NULL THEN
   window_start := clock_timestamp()-make_interval(secs => pol.window_seconds);
   SELECT count(*) INTO n FROM freehold.transfers WHERE source_account_id=p_source AND state='REJECTED' AND created_at>=window_start;
   IF n+1>=pol.threshold_count THEN
    PERFORM freehold._open_risk_flag('FAILED_TRANSFER_BURST',CASE WHEN n+1>=pol.threshold_count*2 THEN 'HIGH' ELSE 'MEDIUM' END,
     p_source,p_actor,NULL,jsonb_build_object('count',n+1,'windowSeconds',pol.window_seconds,'latestFailure',failure));
   END IF;
  END IF;
 END LOOP;
 IF failure='ACCOUNT_FROZEN' THEN
  FOR pol IN SELECT * FROM freehold.risk_policies p WHERE p.enabled AND p.rule_code='FROZEN_ACCOUNT_RETRY'
    AND p.threshold_count IS NOT NULL AND p.window_seconds IS NOT NULL AND (p.scope='INSTITUTION' OR p.account_id=p_source) LOOP
   window_start := clock_timestamp()-make_interval(secs => pol.window_seconds);
   SELECT count(*) INTO n FROM freehold.transfers WHERE source_account_id=p_source AND state='REJECTED' AND failure_code='ACCOUNT_FROZEN' AND created_at>=window_start;
   IF n+1>=pol.threshold_count THEN
    PERFORM freehold._open_risk_flag('FROZEN_ACCOUNT_RETRY','MEDIUM',p_source,p_actor,NULL,jsonb_build_object('count',n+1,'windowSeconds',pol.window_seconds));
   END IF;
  END LOOP;
 END IF;
 IF failure IS NULL THEN
  FOR pol IN SELECT * FROM freehold.risk_policies p WHERE p.enabled AND p.rule_code='UNUSUAL_TRANSFER_SIZE' AND p.size_multiple IS NOT NULL
    AND (p.scope='INSTITUTION' OR p.account_id=p_source) AND (p.currency_code IS NULL OR p.currency_code=p_currency) LOOP
   SELECT count(*)::int, max(amount_minor) INTO prior_n, prior_max FROM freehold.transfers
    WHERE source_account_id=p_source AND state='COMPLETED' AND (pol.currency_code IS NULL OR currency_code=pol.currency_code);
   IF prior_n>=COALESCE(pol.threshold_count,3) AND prior_max IS NOT NULL AND p_amount>prior_max*pol.size_multiple
      AND (pol.threshold_minor IS NULL OR p_amount>=pol.threshold_minor) THEN
    PERFORM freehold._open_risk_flag('UNUSUAL_TRANSFER_SIZE','LOW',p_source,p_actor,p_operation,
     jsonb_build_object('amountMinor',p_amount::text,'priorMaxMinor',prior_max::text,'multiple',pol.size_multiple,'sampleCount',prior_n));
   END IF;
  END LOOP;
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

CREATE OR REPLACE FUNCTION freehold.reserve_funds(p_actor uuid,p_account uuid,p_amount bigint,p_key text,p_purpose text,p_expires_at timestamptz DEFAULT NULL,p_correlation uuid DEFAULT gen_random_uuid())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
DECLARE r freehold.idempotency_requests; a freehold.accounts; currency text; enabled boolean;
 failure text; hold uuid:=gen_random_uuid(); journal uuid; debit uuid; credit uuid;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 PERFORM freehold._actor(p_actor);
 IF p_correlation IS NULL OR p_purpose IS NULL OR length(btrim(p_purpose)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'INVALID_RESERVATION' USING ERRCODE='22023'; END IF;
 r:=freehold._claim(p_actor,'RESERVE',p_key,jsonb_build_object('accountId',p_account,'amountMinor',p_amount::text,'purpose',p_purpose,'expiresAtEpoch',extract(epoch FROM p_expires_at)));
 IF r.response_body IS NOT NULL THEN RETURN r.response_body; END IF;
 PERFORM freehold._amount(p_amount);
 IF p_expires_at IS NOT NULL AND p_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'INVALID_EXPIRY' USING ERRCODE='22023'; END IF;
 SELECT currency_code INTO currency FROM freehold.accounts WHERE id=p_account;
 SELECT c.enabled INTO enabled FROM freehold.currencies c WHERE code=currency FOR SHARE;
 PERFORM id FROM freehold.accounts WHERE id=p_account ORDER BY id FOR UPDATE;
 SELECT * INTO a FROM freehold.accounts WHERE id=p_account;
 IF NOT FOUND OR a.owner_user_id<>p_actor THEN RAISE EXCEPTION 'ACCOUNT_NOT_AUTHORIZED' USING ERRCODE='42501'; END IF;
 failure:=CASE WHEN NOT enabled THEN 'CURRENCY_DISABLED' WHEN a.status='FROZEN' THEN 'ACCOUNT_FROZEN' WHEN a.status<>'ACTIVE' THEN 'ACCOUNT_CLOSED'
  WHEN a.available_minor<p_amount THEN 'INSUFFICIENT_FUNDS'
  WHEN a.reserved_minor::numeric+p_amount::numeric>9223372036854775807::numeric THEN 'BALANCE_LIMIT' END;
 IF failure IS NOT NULL THEN RETURN freehold._finish(r.operation_id,r.operation_id,p_correlation,jsonb_build_object('state','REJECTED','error',failure),422); END IF;
 INSERT INTO freehold.holds(id,account_id,currency_code,amount_minor,purpose,expires_at,creation_operation_id)
 VALUES(hold,p_account,currency,p_amount,p_purpose,p_expires_at,r.operation_id);
 SELECT id INTO STRICT debit FROM freehold.ledger_accounts WHERE customer_account_id=p_account AND bucket='AVAILABLE';
 SELECT id INTO STRICT credit FROM freehold.ledger_accounts WHERE customer_account_id=p_account AND bucket='RESERVED';
 journal:=freehold._post_pair(r.operation_id,p_actor,'RESERVE',p_correlation,debit,credit,p_amount,NULL,hold);
 RETURN freehold._finish(r.operation_id,hold,p_correlation,jsonb_build_object('holdId',hold,'journalId',journal,'state','COMPLETED','amountMinor',p_amount::text));
END $$;

CREATE OR REPLACE FUNCTION freehold.release_hold(p_actor uuid,p_hold uuid,p_key text,p_correlation uuid DEFAULT gen_random_uuid())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
DECLARE r freehold.idempotency_requests; a freehold.accounts; h freehold.holds; account uuid; journal uuid; debit uuid; credit uuid;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 PERFORM freehold._actor(p_actor);
 IF p_correlation IS NULL THEN RAISE EXCEPTION 'INVALID_CORRELATION' USING ERRCODE='22023'; END IF;
 r:=freehold._claim(p_actor,'RELEASE',p_key,jsonb_build_object('holdId',p_hold));
 IF r.response_body IS NOT NULL THEN RETURN r.response_body; END IF;
 SELECT account_id INTO account FROM freehold.holds WHERE id=p_hold;
 PERFORM id FROM freehold.accounts WHERE id=account ORDER BY id FOR UPDATE;
 SELECT * INTO a FROM freehold.accounts WHERE id=account;
 IF NOT FOUND OR a.owner_user_id<>p_actor THEN RAISE EXCEPTION 'HOLD_NOT_AUTHORIZED' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT h FROM freehold.holds WHERE id=p_hold FOR UPDATE;
 IF h.state<>'ACTIVE' THEN RETURN freehold._finish(r.operation_id,h.id,p_correlation,jsonb_build_object('holdId',h.id,'state','REJECTED','error','HOLD_ALREADY_RELEASED'),422); END IF;
 IF a.available_minor::numeric+h.amount_minor::numeric>9223372036854775807::numeric THEN
  RETURN freehold._finish(r.operation_id,h.id,p_correlation,jsonb_build_object('holdId',h.id,'state','REJECTED','error','BALANCE_LIMIT'),422);
 END IF;
 UPDATE freehold.holds SET state='RELEASED',release_operation_id=r.operation_id,released_at=clock_timestamp() WHERE id=h.id;
 SELECT id INTO STRICT debit FROM freehold.ledger_accounts WHERE customer_account_id=account AND bucket='RESERVED';
 SELECT id INTO STRICT credit FROM freehold.ledger_accounts WHERE customer_account_id=account AND bucket='AVAILABLE';
 journal:=freehold._post_pair(r.operation_id,p_actor,'RELEASE',p_correlation,debit,credit,h.amount_minor,NULL,h.id);
 RETURN freehold._finish(r.operation_id,h.id,p_correlation,jsonb_build_object('holdId',h.id,'journalId',journal,'state','COMPLETED','amountMinor',h.amount_minor::text));
END $$;

CREATE OR REPLACE FUNCTION freehold.sandbox_fund_account(p_actor uuid,p_account uuid,p_amount bigint,p_key text,p_reason text,p_correlation uuid DEFAULT gen_random_uuid())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
DECLARE r freehold.idempotency_requests; a freehold.accounts; currency text; enabled boolean; sandbox boolean;
 failure text; journal uuid; debit uuid; credit uuid;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 PERFORM freehold._actor(p_actor,true);
 IF p_correlation IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'ADMIN_REASON_REQUIRED' USING ERRCODE='22023'; END IF;
 r:=freehold._claim(p_actor,'SANDBOX_FUND',p_key,jsonb_build_object('accountId',p_account,'amountMinor',p_amount::text,'reason',p_reason));
 IF r.response_body IS NOT NULL THEN RETURN r.response_body; END IF;
 PERFORM freehold._amount(p_amount);
 SELECT sandbox_enabled INTO sandbox FROM freehold.ledger_settings WHERE singleton FOR SHARE;
 IF NOT sandbox THEN RETURN freehold._finish(r.operation_id,p_account,p_correlation,jsonb_build_object('state','REJECTED','error','SANDBOX_DISABLED'),422); END IF;
 SELECT currency_code INTO currency FROM freehold.accounts WHERE id=p_account;
 SELECT c.enabled INTO enabled FROM freehold.currencies c WHERE code=currency FOR SHARE;
 PERFORM id FROM freehold.accounts WHERE id=p_account ORDER BY id FOR UPDATE;
 SELECT * INTO a FROM freehold.accounts WHERE id=p_account;
 IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_ACCOUNT' USING ERRCODE='22023'; END IF;
 failure:=CASE WHEN NOT enabled THEN 'CURRENCY_DISABLED' WHEN a.status<>'ACTIVE' THEN 'ACCOUNT_NOT_ACTIVE'
  WHEN a.available_minor::numeric+p_amount::numeric>9223372036854775807::numeric THEN 'BALANCE_LIMIT' END;
 IF failure IS NOT NULL THEN RETURN freehold._finish(r.operation_id,p_account,p_correlation,jsonb_build_object('state','REJECTED','error',failure),422); END IF;
 INSERT INTO freehold.ledger_accounts(currency_code,bucket,accounting_class,normal_side)
 VALUES(currency,'SANDBOX_EQUITY','EQUITY','CREDIT') ON CONFLICT DO NOTHING;
 SELECT id INTO STRICT debit FROM freehold.ledger_accounts WHERE currency_code=currency AND bucket='SANDBOX_EQUITY' AND customer_account_id IS NULL;
 SELECT id INTO STRICT credit FROM freehold.ledger_accounts WHERE customer_account_id=p_account AND bucket='AVAILABLE';
 journal:=freehold._post_pair(r.operation_id,p_actor,'SANDBOX_FUND',p_correlation,debit,credit,p_amount);
 INSERT INTO freehold.admin_actions(actor_user_id,action_type,target_id,operation_id,reason,correlation_id,before_state,after_state)
 VALUES(p_actor,'SANDBOX_FUND',p_account,r.operation_id,p_reason,p_correlation,to_jsonb(a),jsonb_build_object('available_minor',a.available_minor+p_amount,'sandbox',true));
 RETURN freehold._finish(r.operation_id,p_account,p_correlation,jsonb_build_object('journalId',journal,'state','COMPLETED','sandbox',true,'amountMinor',p_amount::text));
END $$;

CREATE OR REPLACE FUNCTION freehold.create_account(p_actor uuid,p_currency text,p_key text,p_correlation uuid DEFAULT gen_random_uuid()) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
DECLARE r freehold.idempotency_requests; account uuid; enabled boolean;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 PERFORM freehold._actor(p_actor);
 IF p_correlation IS NULL OR p_currency IS NULL THEN RAISE EXCEPTION 'INVALID_ACCOUNT_REQUEST' USING ERRCODE='22023'; END IF;
 r:=freehold._claim(p_actor,'CREATE_ACCOUNT',p_key,jsonb_build_object('currency',p_currency));
 IF r.response_body IS NOT NULL THEN RETURN r.response_body; END IF;
 SELECT c.enabled INTO enabled FROM freehold.currencies c WHERE code=p_currency FOR SHARE;
 IF NOT FOUND OR NOT enabled THEN RAISE EXCEPTION 'CURRENCY_UNAVAILABLE' USING ERRCODE='22023'; END IF;
 INSERT INTO freehold.accounts(owner_user_id,currency_code) VALUES(p_actor,p_currency) ON CONFLICT (owner_user_id,currency_code) DO NOTHING;
 SELECT id INTO STRICT account FROM freehold.accounts WHERE owner_user_id=p_actor AND currency_code=p_currency;
 RETURN freehold._finish(r.operation_id,account,p_correlation,jsonb_build_object('accountId',account,'currency',p_currency,'state','COMPLETED'));
END $$;

CREATE FUNCTION freehold._risk_policy_canonical(p_parameters jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE scope text; rule text; account uuid; currency text; enabled boolean;
 minor text; count_value integer; window_value integer; multiple integer;
BEGIN
 IF jsonb_typeof(p_parameters)<>'object' THEN RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023'; END IF;
 scope:=p_parameters->>'scope'; rule:=p_parameters->>'ruleCode';
 IF scope NOT IN ('INSTITUTION','ACCOUNT') OR rule NOT IN (
  'MAX_SINGLE_TRANSFER','DAILY_OUTGOING_LIMIT','ACCOUNT_TRANSFER_BLOCK','VELOCITY_OUTGOING_COUNT',
  'FAILED_TRANSFER_BURST','UNUSUAL_TRANSFER_SIZE','FROZEN_ACCOUNT_RETRY','IDEMPOTENCY_CONFLICT_BURST') THEN
  RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023';
 END IF;
 IF p_parameters ? 'timezone' AND p_parameters->>'timezone' IS NOT NULL AND p_parameters->>'timezone'<>'UTC' THEN
  RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023';
 END IF;
 IF jsonb_typeof(p_parameters->'enabled')<>'boolean' THEN RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023'; END IF;
 enabled:=(p_parameters->>'enabled')::boolean;
 IF rule='IDEMPOTENCY_CONFLICT_BURST' AND scope<>'INSTITUTION' THEN RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023'; END IF;
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
 IF rule IN ('MAX_SINGLE_TRANSFER','DAILY_OUTGOING_LIMIT') AND minor IS NULL THEN RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023'; END IF;
 IF rule IN ('VELOCITY_OUTGOING_COUNT','FAILED_TRANSFER_BURST','FROZEN_ACCOUNT_RETRY','IDEMPOTENCY_CONFLICT_BURST')
    AND (count_value IS NULL OR count_value<1 OR window_value IS NULL OR window_value<1 OR window_value>31622400) THEN
  RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023';
 END IF;
 IF rule='UNUSUAL_TRANSFER_SIZE' AND (multiple IS NULL OR multiple<2 OR multiple>1000) THEN RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023'; END IF;
 IF rule<>'UNUSUAL_TRANSFER_SIZE' THEN multiple:=NULL; END IF;
 IF rule NOT IN ('VELOCITY_OUTGOING_COUNT','FAILED_TRANSFER_BURST','FROZEN_ACCOUNT_RETRY','IDEMPOTENCY_CONFLICT_BURST','UNUSUAL_TRANSFER_SIZE') THEN
  count_value:=NULL; window_value:=NULL;
 END IF;
 IF rule NOT IN ('MAX_SINGLE_TRANSFER','DAILY_OUTGOING_LIMIT','UNUSUAL_TRANSFER_SIZE') THEN minor:=NULL; END IF;
 IF rule='UNUSUAL_TRANSFER_SIZE' AND count_value IS NULL THEN count_value:=3; END IF;
 RETURN jsonb_build_object('accountId',account,'currencyCode',currency,'enabled',enabled,'ruleCode',rule,'scope',scope,
  'sizeMultiple',multiple,'thresholdCount',count_value,'thresholdMinor',minor,'timezone','UTC','windowSeconds',window_value);
EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'INVALID_RISK_POLICY' USING ERRCODE='22023';
END $$;

CREATE FUNCTION freehold._apply_risk_policy(p_request freehold.governance_requests) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE canonical jsonb; account uuid; policy uuid;
BEGIN
 canonical:=freehold._risk_policy_canonical(p_request.parameters);
 account:=NULLIF(canonical->>'accountId','')::uuid;
 IF account IS NOT NULL THEN PERFORM id FROM freehold.accounts WHERE id=account FOR UPDATE; END IF;
 INSERT INTO freehold.risk_policies(scope,account_id,currency_code,rule_code,threshold_minor,threshold_count,window_seconds,size_multiple,timezone,enabled,governance_request_id)
 VALUES (canonical->>'scope',account,NULLIF(canonical->>'currencyCode',''),canonical->>'ruleCode',
  NULLIF(canonical->>'thresholdMinor','')::bigint, NULLIF(canonical->>'thresholdCount','')::integer,
  NULLIF(canonical->>'windowSeconds','')::integer, NULLIF(canonical->>'sizeMultiple','')::integer,
  'UTC',(canonical->>'enabled')::boolean,p_request.id)
 ON CONFLICT (scope, rule_code, identity_account, identity_currency) DO UPDATE
  SET threshold_minor=EXCLUDED.threshold_minor, threshold_count=EXCLUDED.threshold_count, window_seconds=EXCLUDED.window_seconds,
      size_multiple=EXCLUDED.size_multiple, enabled=EXCLUDED.enabled, governance_request_id=EXCLUDED.governance_request_id
 RETURNING id INTO policy;
 INSERT INTO freehold.risk_policy_changes(policy_id,governance_request_id,parameters) VALUES(policy,p_request.id,canonical);
 RETURN jsonb_build_object('policyId',policy,'state','COMPLETED');
END $$;

CREATE FUNCTION freehold.governance_create_risk_policy_request(p_actor uuid, p_parameters jsonb, p_reason text, p_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
DECLARE canonical jsonb; digest bytea; existing freehold.governance_requests; req freehold.governance_requests; account uuid;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 IF NOT freehold._has_governance_capability(p_actor,'INSTITUTION_ADMIN') THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000 OR p_key IS NULL OR length(btrim(p_key)) NOT BETWEEN 1 AND 200 THEN
  RAISE EXCEPTION 'INVALID_GOVERNANCE_REQUEST' USING ERRCODE='22023';
 END IF;
 canonical:=freehold._risk_policy_canonical(p_parameters);
 digest:=sha256(convert_to('SET_RISK_POLICY:'||canonical::text||':'||p_reason,'UTF8'));
 SELECT * INTO existing FROM freehold.governance_requests WHERE initiator_id=p_actor AND request_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF existing.payload_hash<>digest THEN RAISE EXCEPTION 'GOVERNANCE_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('requestId',existing.id,'status',existing.status,'expiresAt',existing.expires_at,'operation',existing.operation,'parameters',existing.parameters);
 END IF;
 INSERT INTO freehold.governance_requests(request_key,initiator_id,operation,parameters,payload_hash,justification,required_capability)
 VALUES(p_key,p_actor,'SET_RISK_POLICY',canonical,digest,p_reason,'FINANCIAL_REVIEWER') RETURNING * INTO req;
 account:=NULLIF(canonical->>'accountId','')::uuid;
 PERFORM freehold._governance_audit(req.id,'REQUESTED',p_actor,account,'PENDING',p_reason,jsonb_build_object('operation','SET_RISK_POLICY','payloadHash',encode(digest,'hex')));
 RETURN jsonb_build_object('requestId',req.id,'status',req.status,'expiresAt',req.expires_at,'operation',req.operation,'parameters',req.parameters);
END $$;

CREATE OR REPLACE FUNCTION freehold.governance_execute(p_actor uuid,p_request uuid,p_key text,p_correlation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
DECLARE req freehold.governance_requests; op jsonb; frozen boolean; account uuid;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 SELECT * INTO req FROM freehold.governance_requests WHERE id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'GOVERNANCE_REQUEST_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF NOT freehold._has_governance_capability(p_actor, freehold._governance_actor_capability(req.operation,'executor'))
   THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 IF req.status IN ('APPROVED','EXECUTED','FAILED') AND
   (NOT freehold._has_governance_capability(req.initiator_id, freehold._governance_actor_capability(req.operation,'initiator'))
    OR EXISTS(SELECT 1 FROM freehold.governance_approval_requirements r WHERE r.request_id=p_request
      AND (SELECT count(*) FROM freehold.governance_decisions d WHERE d.request_id=r.request_id AND d.capability=r.capability AND d.decision='APPROVE'
        AND freehold._has_governance_capability(d.principal_id,d.capability))<r.required_count))
   THEN RAISE EXCEPTION 'GOVERNANCE_AUTHORIZATION_REVOKED' USING ERRCODE='42501'; END IF;
 IF req.status IN ('EXECUTED','FAILED') THEN RETURN req.result; END IF;
 IF req.status IN ('PENDING','APPROVED') AND req.expires_at<=clock_timestamp() THEN
   UPDATE freehold.governance_requests SET status='EXPIRED',decided_at=clock_timestamp() WHERE id=p_request;
   PERFORM freehold._governance_audit(p_request,'EXPIRED',NULL,NULL,'EXPIRED',NULL,'{}');
   RETURN jsonb_build_object('requestId',p_request,'status','EXPIRED');
 END IF;
 IF req.status<>'APPROVED' THEN RAISE EXCEPTION 'GOVERNANCE_NOT_APPROVED' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM freehold.governance_approval_requirements r WHERE r.request_id=p_request
   AND (SELECT count(*) FROM freehold.governance_decisions d WHERE d.request_id=r.request_id AND d.capability=r.capability AND d.decision='APPROVE'
     AND freehold._has_governance_capability(d.principal_id,d.capability))<r.required_count)
 THEN RAISE EXCEPTION 'GOVERNANCE_AUTHORIZATION_REVOKED' USING ERRCODE='42501'; END IF;
 PERFORM freehold._governance_audit(p_request,'EXECUTION_ATTEMPT',p_actor,NULL,'ATTEMPT',req.justification,'{}');
 IF req.operation IN ('FREEZE_ACCOUNT','UNFREEZE_ACCOUNT') THEN
   account:=(req.parameters->>'accountId')::uuid; frozen:=(req.parameters->>'frozen')::boolean;
   op:=freehold.set_account_frozen(req.initiator_id,account,frozen,p_key,req.justification,p_correlation);
 ELSIF req.operation='RESUME_WRITES' THEN
   UPDATE freehold.institutional_control SET writes_suspended=false,resumed_at=clock_timestamp(),suspension_reason=NULL,suspended_by=NULL,suspended_at=NULL WHERE singleton AND writes_suspended;
   op:=jsonb_build_object('status','COMPLETED','writesSuspended',false);
 ELSIF req.operation='SET_RISK_POLICY' THEN
   op:=freehold._apply_risk_policy(req);
 ELSE RAISE EXCEPTION 'GOVERNANCE_OPERATION_UNSUPPORTED' USING ERRCODE='55000';
 END IF;
 UPDATE freehold.governance_requests SET status=CASE WHEN op->>'state'='REJECTED' THEN 'FAILED' ELSE 'EXECUTED' END,
   executed_at=clock_timestamp(),executor_id=p_actor,result=jsonb_build_object('requestId',p_request,'operation',req.operation,'status',CASE WHEN op->>'state'='REJECTED' THEN 'FAILED' ELSE 'EXECUTED' END,'result',op),
   operation_id=CASE WHEN op ? 'operationId' THEN (op->>'operationId')::uuid END
 WHERE id=p_request RETURNING * INTO req;
 PERFORM freehold._governance_audit(p_request,CASE WHEN req.status='FAILED' THEN 'EXECUTION_FAILED' ELSE 'EXECUTED' END,p_actor,account,req.status,req.justification,'{}');
 RETURN req.result;
END $$;

CREATE OR REPLACE FUNCTION freehold.governance_cancel(p_actor uuid,p_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE req freehold.governance_requests;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 SELECT * INTO req FROM freehold.governance_requests WHERE id=p_request FOR UPDATE;
 IF NOT FOUND OR req.initiator_id<>p_actor THEN RAISE EXCEPTION 'GOVERNANCE_REQUEST_NOT_FOUND' USING ERRCODE='42501'; END IF;
 IF NOT freehold._has_governance_capability(p_actor, freehold._governance_actor_capability(req.operation,'initiator'))
 THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 IF req.status NOT IN ('PENDING','APPROVED') THEN RAISE EXCEPTION 'GOVERNANCE_REQUEST_TERMINAL' USING ERRCODE='55000'; END IF;
 UPDATE freehold.governance_requests SET status='CANCELLED',decided_at=clock_timestamp() WHERE id=p_request;
 PERFORM freehold._governance_audit(p_request,'CANCELLED',p_actor,NULL,'CANCELLED',req.justification,'{}');
 RETURN jsonb_build_object('requestId',p_request,'status','CANCELLED');
END $$;

CREATE OR REPLACE FUNCTION freehold.governance_create_account_request(p_actor uuid,p_account uuid,p_frozen boolean,p_reason text,p_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
DECLARE op text; params jsonb; digest bytea; existing freehold.governance_requests; req freehold.governance_requests;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 IF NOT freehold._has_governance_capability(p_actor,'ACCOUNT_ADMIN') THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_account IS NULL OR p_frozen IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000 OR p_key IS NULL OR length(btrim(p_key)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'INVALID_GOVERNANCE_REQUEST' USING ERRCODE='22023'; END IF;
 op:=CASE WHEN p_frozen THEN 'FREEZE_ACCOUNT' ELSE 'UNFREEZE_ACCOUNT' END;
 params:=jsonb_build_object('accountId',p_account,'frozen',p_frozen);
 digest:=sha256(convert_to(op||':'||params::text||':'||p_reason,'UTF8'));
 SELECT * INTO existing FROM freehold.governance_requests WHERE initiator_id=p_actor AND request_key=p_key FOR UPDATE;
 IF FOUND THEN
   IF existing.payload_hash<>digest THEN RAISE EXCEPTION 'GOVERNANCE_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
   RETURN jsonb_build_object('requestId',existing.id,'status',existing.status,'expiresAt',existing.expires_at,'operation',existing.operation,'parameters',existing.parameters);
 END IF;
 INSERT INTO freehold.governance_requests(request_key,initiator_id,operation,parameters,payload_hash,justification,required_capability)
 VALUES(p_key,p_actor,op,params,digest,p_reason,'FINANCIAL_REVIEWER') RETURNING * INTO req;
 PERFORM freehold._governance_audit(req.id,'REQUESTED',p_actor,p_account,'PENDING',p_reason,jsonb_build_object('operation',op,'payloadHash',encode(digest,'hex')));
 RETURN jsonb_build_object('requestId',req.id,'status',req.status,'expiresAt',req.expires_at,'operation',req.operation,'parameters',req.parameters);
END $$;

CREATE OR REPLACE FUNCTION freehold.governance_create_resume_request(p_actor uuid,p_reason text,p_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE req freehold.governance_requests;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 IF NOT freehold._has_governance_capability(p_actor,'EMERGENCY_CONTROL') THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000 OR p_key IS NULL OR length(btrim(p_key)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'INVALID_GOVERNANCE_REQUEST' USING ERRCODE='22023'; END IF;
 INSERT INTO freehold.governance_requests(request_key,initiator_id,operation,parameters,payload_hash,justification,required_capability)
 VALUES(p_key,p_actor,'RESUME_WRITES','{}'::jsonb,sha256(convert_to('RESUME_WRITES:{}:'||p_reason,'UTF8')),p_reason,'INSTITUTION_ADMIN')
 ON CONFLICT(initiator_id,request_key) DO UPDATE SET request_key=EXCLUDED.request_key
 RETURNING * INTO req;
 IF req.initiator_id<>p_actor OR req.operation<>'RESUME_WRITES' OR req.justification<>p_reason THEN RAISE EXCEPTION 'GOVERNANCE_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
 IF NOT EXISTS(SELECT 1 FROM freehold.governance_audit WHERE request_id=req.id AND event_type='REQUESTED') THEN
   PERFORM freehold._governance_audit(req.id,'REQUESTED',p_actor,NULL,'PENDING',p_reason,jsonb_build_object('operation','RESUME_WRITES'));
 END IF;
 RETURN jsonb_build_object('requestId',req.id,'status',req.status,'expiresAt',req.expires_at,'operation',req.operation);
END $$;

CREATE OR REPLACE FUNCTION freehold.governance_decide(p_actor uuid,p_request uuid,p_decision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
DECLARE req freehold.governance_requests; cap text; all_approved boolean;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 SELECT * INTO req FROM freehold.governance_requests WHERE id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'GOVERNANCE_REQUEST_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF p_actor=req.initiator_id THEN RAISE EXCEPTION 'GOVERNANCE_SELF_APPROVAL' USING ERRCODE='42501'; END IF;
 IF p_decision NOT IN ('APPROVE','REJECT') THEN RAISE EXCEPTION 'INVALID_GOVERNANCE_DECISION' USING ERRCODE='22023'; END IF;
 IF req.status IN ('PENDING','APPROVED') AND req.expires_at<=clock_timestamp() THEN
   UPDATE freehold.governance_requests SET status='EXPIRED',decided_at=clock_timestamp() WHERE id=p_request;
   PERFORM freehold._governance_audit(p_request,'EXPIRED',NULL,NULL,'EXPIRED',NULL,'{}');
   RETURN jsonb_build_object('requestId',p_request,'status','EXPIRED');
 END IF;
 IF req.status<>'PENDING' THEN RAISE EXCEPTION 'GOVERNANCE_REQUEST_TERMINAL' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM freehold.governance_decisions WHERE request_id=p_request AND principal_id=p_actor) THEN
   RAISE EXCEPTION 'GOVERNANCE_DECISION_ALREADY_RECORDED' USING ERRCODE='55000';
 END IF;
 SELECT r.capability INTO cap
 FROM freehold.governance_approval_requirements r
 WHERE r.request_id=p_request
   AND (p_decision='REJECT' OR (SELECT count(*) FROM freehold.governance_decisions d WHERE d.request_id=r.request_id AND d.capability=r.capability AND d.decision='APPROVE'
     AND freehold._has_governance_capability(d.principal_id,d.capability))<r.required_count)
   AND freehold._has_governance_capability(p_actor,r.capability)
 ORDER BY r.capability LIMIT 1;
 IF cap IS NULL THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 INSERT INTO freehold.governance_decisions(request_id,principal_id,capability,decision) VALUES(p_request,p_actor,cap,p_decision);
 IF p_decision='REJECT' THEN
   UPDATE freehold.governance_requests SET status='REJECTED',decided_at=clock_timestamp() WHERE id=p_request;
 ELSE
   SELECT NOT EXISTS(
     SELECT 1 FROM freehold.governance_approval_requirements r
     WHERE r.request_id=p_request AND (SELECT count(*) FROM freehold.governance_decisions d
       WHERE d.request_id=r.request_id AND d.capability=r.capability AND d.decision='APPROVE'
       AND freehold._has_governance_capability(d.principal_id,d.capability))<r.required_count
   ) INTO all_approved;
   IF all_approved THEN UPDATE freehold.governance_requests SET status='APPROVED',decided_at=clock_timestamp() WHERE id=p_request; END IF;
 END IF;
 PERFORM freehold._governance_audit(p_request,CASE WHEN p_decision='APPROVE' THEN 'APPROVED' ELSE 'REJECTED' END,p_actor,
   CASE WHEN req.operation IN ('FREEZE_ACCOUNT','UNFREEZE_ACCOUNT') THEN (req.parameters->>'accountId')::uuid END,p_decision,req.justification,jsonb_build_object('capability',cap));
 RETURN jsonb_build_object('requestId',p_request,'status',CASE WHEN p_decision='REJECT' THEN 'REJECTED' WHEN all_approved THEN 'APPROVED' ELSE 'PENDING' END);
END $$;

CREATE OR REPLACE FUNCTION freehold.governance_suspend_writes(p_actor uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 IF NOT freehold._has_governance_capability(p_actor,'EMERGENCY_CONTROL') THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'EMERGENCY_REASON_REQUIRED' USING ERRCODE='22023'; END IF;
 UPDATE freehold.institutional_control SET writes_suspended=true,suspension_reason=p_reason,suspended_by=p_actor,suspended_at=clock_timestamp(),resumed_at=NULL WHERE singleton;
 INSERT INTO freehold.governance_audit(event_type,requesting_principal,executing_service,outcome,reason,metadata)
 VALUES('EMERGENCY_SUSPEND',p_actor,'freehold_api','SUSPENDED',p_reason,'{}');
 RETURN freehold.governance_status(p_actor);
END $$;

CREATE OR REPLACE FUNCTION freehold.governance_status(p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE ctl freehold.institutional_control;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 IF NOT EXISTS(SELECT 1 FROM freehold.governance_capabilities c JOIN freehold.users u ON u.id=c.principal_id WHERE c.principal_id=p_actor AND c.revoked_at IS NULL AND u.status='ACTIVE' AND u.role='ADMIN') THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT * INTO ctl FROM freehold.institutional_control WHERE singleton;
 RETURN jsonb_build_object('writesSuspended',ctl.writes_suspended,'reason',ctl.suspension_reason,'suspendedAt',ctl.suspended_at,'resumedAt',ctl.resumed_at);
END $$;

CREATE OR REPLACE FUNCTION freehold.governance_overview(p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 IF NOT EXISTS(SELECT 1 FROM freehold.governance_capabilities c JOIN freehold.users u ON u.id=c.principal_id WHERE c.principal_id=p_actor AND c.revoked_at IS NULL AND u.status='ACTIVE' AND u.role='ADMIN') THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 WITH expired AS (UPDATE freehold.governance_requests SET status='EXPIRED',decided_at=clock_timestamp()
   WHERE status IN ('PENDING','APPROVED') AND expires_at<=clock_timestamp() RETURNING id)
 INSERT INTO freehold.governance_audit(request_id,event_type,outcome,metadata)
 SELECT id,'EXPIRED','EXPIRED','{}'::jsonb FROM expired;
 RETURN jsonb_build_object('status',freehold.governance_status(p_actor),
   'capabilities',(SELECT COALESCE(jsonb_agg(capability ORDER BY capability),'[]'::jsonb) FROM freehold.governance_capabilities WHERE principal_id=p_actor AND revoked_at IS NULL),
   'requests',(SELECT COALESCE(jsonb_agg(jsonb_build_object('requestId',r.id,'operation',r.operation,'parameters',r.parameters,'justification',r.justification,'status',r.status,'expiresAt',r.expires_at,'initiatorId',r.initiator_id,
     'approvalRequirements',(SELECT COALESCE(jsonb_agg(jsonb_build_object('capability',q.capability,'requiredCount',q.required_count,'approvedCount',(SELECT count(*) FROM freehold.governance_decisions d WHERE d.request_id=q.request_id AND d.capability=q.capability AND d.decision='APPROVE')) ORDER BY q.capability),'[]'::jsonb) FROM freehold.governance_approval_requirements q WHERE q.request_id=r.id),
     'approvals',(SELECT COALESCE(jsonb_agg(jsonb_build_object('principalId',d.principal_id,'capability',d.capability,'decision',d.decision,'decidedAt',d.decided_at)),'[]'::jsonb) FROM freehold.governance_decisions d WHERE d.request_id=r.id)) ORDER BY r.created_at DESC),'[]'::jsonb) FROM (SELECT * FROM freehold.governance_requests ORDER BY created_at DESC LIMIT 50) r),
   'audit',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',a.id,'requestId',a.request_id,'eventType',a.event_type,'requestingPrincipal',a.requesting_principal,'approvingPrincipal',a.approving_principal,'executingPrincipal',a.executing_principal,'executingService',a.executing_service,'affectedResource',a.affected_resource,'outcome',a.outcome,'reason',a.reason,'recordedAt',a.recorded_at) ORDER BY a.id DESC),'[]'::jsonb) FROM (SELECT * FROM freehold.governance_audit ORDER BY id DESC LIMIT 100) a),
   'monetaryAuthority',jsonb_build_object('issuanceEnabled',false,'externalBackingVerified',false,'sandboxFundingOnly',true));
END $$;

CREATE OR REPLACE FUNCTION freehold.governance_admin_list_accounts(p_actor uuid,p_query text,p_limit integer)
RETURNS TABLE(id uuid,"ownerEmail" text,currency text,status text,"availableMinor" text,"reservedMinor" text,"totalMinor" text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 IF NOT freehold._has_governance_capability(p_actor,'ACCOUNT_ADMIN') THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT * FROM freehold.admin_list_accounts(p_actor,p_query,p_limit);
END $$;

CREATE OR REPLACE FUNCTION freehold.governance_read_reconciliation(p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 IF NOT (freehold._has_governance_capability(p_actor,'AUDITOR') OR freehold._has_governance_capability(p_actor,'SECURITY_ADMIN') OR freehold._has_governance_capability(p_actor,'FINANCIAL_REVIEWER')) THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 RETURN freehold.admin_latest_reconciliation();
END $$;

CREATE OR REPLACE FUNCTION freehold.governance_read_audit(p_actor uuid,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 IF NOT (freehold._has_governance_capability(p_actor,'AUDITOR') OR freehold._has_governance_capability(p_actor,'SECURITY_ADMIN') OR freehold._has_governance_capability(p_actor,'FINANCIAL_REVIEWER') OR freehold._has_governance_capability(p_actor,'ACCOUNT_ADMIN')) THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 RETURN freehold.admin_audit_events(p_limit);
END $$;

CREATE FUNCTION freehold._ts_utc(p_time timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN p_time IS NULL THEN NULL ELSE to_char(p_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
$$;

-- Read-only. Opening and closing cover the whole window. Lines are a page.
CREATE FUNCTION freehold.account_statement(p_actor uuid,p_account uuid,p_from timestamptz,p_to timestamptz,p_limit integer,p_before_time timestamptz,p_before_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE a freehold.accounts; lim integer; email text; exponent smallint;
 open_av numeric; open_rs numeric; debit_av numeric; credit_av numeric; debit_rs numeric; credit_rs numeric;
 direct_av numeric; direct_rs numeric; lines jsonb; has_more boolean; next_time timestamptz; next_id uuid;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 IF p_account IS NULL THEN RAISE EXCEPTION 'ACCOUNT_NOT_AUTHORIZED' USING ERRCODE='42501'; END IF;
 PERFORM id FROM freehold.accounts WHERE id=p_account FOR SHARE;
 SELECT * INTO a FROM freehold.accounts WHERE id=p_account;
 IF NOT FOUND OR a.owner_user_id<>p_actor THEN RAISE EXCEPTION 'ACCOUNT_NOT_AUTHORIZED' USING ERRCODE='42501'; END IF;
 lim:=COALESCE(p_limit,100);
 IF p_from IS NULL OR p_to IS NULL OR p_from>=p_to OR (p_to-p_from)>interval '366 days' OR lim NOT BETWEEN 1 AND 500
    OR (p_before_time IS NULL)<>(p_before_id IS NULL) THEN
  RAISE EXCEPTION 'INVALID_STATEMENT_RANGE' USING ERRCODE='22023';
 END IF;
 SELECT email_normalized INTO email FROM freehold.users WHERE id=a.owner_user_id;
 SELECT minor_unit_exponent INTO exponent FROM freehold.currencies WHERE code=a.currency_code;
 SELECT
  COALESCE(sum(CASE WHEN la.bucket='AVAILABLE' AND e.side='CREDIT' THEN e.amount_minor::numeric WHEN la.bucket='AVAILABLE' THEN -e.amount_minor::numeric ELSE 0 END) FILTER (WHERE j.effective_at<p_from),0),
  COALESCE(sum(CASE WHEN la.bucket='RESERVED' AND e.side='CREDIT' THEN e.amount_minor::numeric WHEN la.bucket='RESERVED' THEN -e.amount_minor::numeric ELSE 0 END) FILTER (WHERE j.effective_at<p_from),0),
  COALESCE(sum(e.amount_minor::numeric) FILTER (WHERE la.bucket='AVAILABLE' AND e.side='DEBIT' AND j.effective_at>=p_from AND j.effective_at<p_to),0),
  COALESCE(sum(e.amount_minor::numeric) FILTER (WHERE la.bucket='AVAILABLE' AND e.side='CREDIT' AND j.effective_at>=p_from AND j.effective_at<p_to),0),
  COALESCE(sum(e.amount_minor::numeric) FILTER (WHERE la.bucket='RESERVED' AND e.side='DEBIT' AND j.effective_at>=p_from AND j.effective_at<p_to),0),
  COALESCE(sum(e.amount_minor::numeric) FILTER (WHERE la.bucket='RESERVED' AND e.side='CREDIT' AND j.effective_at>=p_from AND j.effective_at<p_to),0),
  COALESCE(sum(CASE WHEN la.bucket='AVAILABLE' AND e.side='CREDIT' THEN e.amount_minor::numeric WHEN la.bucket='AVAILABLE' THEN -e.amount_minor::numeric ELSE 0 END) FILTER (WHERE j.effective_at<p_to),0),
  COALESCE(sum(CASE WHEN la.bucket='RESERVED' AND e.side='CREDIT' THEN e.amount_minor::numeric WHEN la.bucket='RESERVED' THEN -e.amount_minor::numeric ELSE 0 END) FILTER (WHERE j.effective_at<p_to),0)
 INTO open_av,open_rs,debit_av,credit_av,debit_rs,credit_rs,direct_av,direct_rs
 FROM freehold.ledger_entries e
 JOIN freehold.ledger_journals j ON j.id=e.journal_id
 JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id
 WHERE la.customer_account_id=p_account;
 IF open_av+credit_av-debit_av<>direct_av OR open_rs+credit_rs-debit_rs<>direct_rs THEN
  RAISE EXCEPTION 'STATEMENT_RECONCILIATION_FAILED' USING ERRCODE='23514';
 END IF;
 WITH raw AS (
  SELECT e.id,j.effective_at,j.operation_id,j.id AS journal_id,j.kind,la.bucket,e.side,e.amount_minor,
   CASE WHEN j.kind='INTERNAL_TRANSFER' AND t.source_account_id=p_account THEN t.destination_account_id
        WHEN j.kind='INTERNAL_TRANSFER' THEN t.source_account_id END AS counterparty
  FROM freehold.ledger_entries e
  JOIN freehold.ledger_journals j ON j.id=e.journal_id
  JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id
  LEFT JOIN freehold.transfers t ON t.id=j.transfer_id
  WHERE la.customer_account_id=p_account AND j.effective_at>=p_from AND j.effective_at<p_to
    AND (p_before_time IS NULL OR (j.effective_at,e.id)>(p_before_time,p_before_id))
  ORDER BY j.effective_at,e.id
  LIMIT lim+1
 ), numbered AS (
  SELECT *,row_number() OVER (ORDER BY effective_at,id) AS rn,count(*) OVER () AS total FROM raw
 )
 SELECT COALESCE(jsonb_agg(jsonb_build_object(
   'entryId',id,'effectiveAt',freehold._ts_utc(effective_at),'operationId',operation_id,'journalId',journal_id,
   'kind',kind,'bucket',bucket,'side',side,'amountMinor',amount_minor::text,'counterpartyAccountId',counterparty
 ) ORDER BY effective_at,id) FILTER (WHERE rn<=lim),'[]'::jsonb),
  COALESCE(bool_or(total>lim),false),
  max(effective_at) FILTER (WHERE rn=lim AND total>lim),
  (SELECT n.id FROM numbered n WHERE n.rn=lim AND n.total>lim LIMIT 1)
 INTO lines,has_more,next_time,next_id
 FROM numbered;
 RETURN jsonb_build_object(
  'accountId',a.id,'ownerUserId',a.owner_user_id,'ownerEmail',email,'currency',a.currency_code,'minorUnitExponent',exponent,
  'from',freehold._ts_utc(p_from),'to',freehold._ts_utc(p_to),'generatedAt',freehold._ts_utc(clock_timestamp()),
  'openingAvailableMinor',open_av::text,'closingAvailableMinor',direct_av::text,
  'openingReservedMinor',open_rs::text,'closingReservedMinor',direct_rs::text,
  'debitAvailableMinor',debit_av::text,'creditAvailableMinor',credit_av::text,
  'debitReservedMinor',debit_rs::text,'creditReservedMinor',credit_rs::text,
  'lines',COALESCE(lines,'[]'::jsonb),
  'nextCursorTime',CASE WHEN has_more THEN freehold._ts_utc(next_time) END,
  'nextCursorId',CASE WHEN has_more THEN next_id END);
END $$;

CREATE FUNCTION freehold.account_applicable_limits(p_actor uuid,p_account uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE a freehold.accounts;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 SELECT * INTO a FROM freehold.accounts WHERE id=p_account;
 IF NOT FOUND OR a.owner_user_id<>p_actor THEN RAISE EXCEPTION 'ACCOUNT_NOT_AUTHORIZED' USING ERRCODE='42501'; END IF;
 RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'ruleCode',p.rule_code,'scope',p.scope,'currencyCode',p.currency_code,'enabled',p.enabled,
   'thresholdMinor',p.threshold_minor::text,'thresholdCount',p.threshold_count,'windowSeconds',p.window_seconds,'sizeMultiple',p.size_multiple,'timezone',p.timezone
  ) ORDER BY p.scope,p.rule_code,p.currency_code NULLS FIRST)
  FROM freehold.risk_policies p
  WHERE p.enabled AND (p.currency_code IS NULL OR p.currency_code=a.currency_code)
    AND ((p.scope='ACCOUNT' AND p.account_id=p_account) OR p.scope='INSTITUTION')),'[]'::jsonb);
END $$;

CREATE FUNCTION freehold.risk_note_conflict(p_actor uuid,p_operation text,p_key_hash bytea)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE pol freehold.risk_policies; n integer; window_start timestamptz;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 IF p_operation IS NULL OR length(p_operation) NOT BETWEEN 1 AND 40 OR p_key_hash IS NULL OR octet_length(p_key_hash)<>32 THEN
  RAISE EXCEPTION 'INVALID_RISK_OBSERVATION' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM freehold.risk_policies WHERE enabled AND rule_code='IDEMPOTENCY_CONFLICT_BURST' AND scope='INSTITUTION') THEN RETURN; END IF;
 INSERT INTO freehold.risk_observations(actor_id,kind,key_hash) VALUES(p_actor,p_operation,p_key_hash);
 FOR pol IN SELECT * FROM freehold.risk_policies WHERE enabled AND rule_code='IDEMPOTENCY_CONFLICT_BURST' AND scope='INSTITUTION' AND threshold_count IS NOT NULL AND window_seconds IS NOT NULL LOOP
  window_start:=clock_timestamp()-make_interval(secs => pol.window_seconds);
  SELECT count(*) INTO n FROM freehold.risk_observations WHERE actor_id=p_actor AND kind=p_operation AND observed_at>=window_start;
  IF n>=pol.threshold_count THEN
   PERFORM freehold._open_risk_flag('IDEMPOTENCY_CONFLICT_BURST','MEDIUM',NULL,p_actor,NULL,
    jsonb_build_object('count',n,'windowSeconds',pol.window_seconds,'operation',p_operation));
  END IF;
 END LOOP;
END $$;

CREATE FUNCTION freehold.risk_flags_list(p_actor uuid,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE lim integer:=LEAST(GREATEST(COALESCE(p_limit,50),1),200);
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 IF NOT (freehold._has_governance_capability(p_actor,'COMPLIANCE_OFFICER') OR freehold._has_governance_capability(p_actor,'AUDITOR')
   OR freehold._has_governance_capability(p_actor,'FINANCIAL_REVIEWER') OR freehold._has_governance_capability(p_actor,'INSTITUTION_ADMIN')
   OR freehold._has_governance_capability(p_actor,'SECURITY_ADMIN')) THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'id',f.id,'ruleCode',f.rule_code,'severity',f.severity,'accountId',f.account_id,'actorId',f.actor_id,
   'operationId',f.operation_id,'evidence',f.evidence,'status',f.status,'createdAt',freehold._ts_utc(f.created_at)
  ) ORDER BY f.created_at DESC,f.id DESC)
  FROM (SELECT * FROM freehold.risk_flags ORDER BY created_at DESC,id DESC LIMIT lim) f),'[]'::jsonb);
END $$;

CREATE FUNCTION freehold.risk_policies_list(p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 IF NOT (freehold._has_governance_capability(p_actor,'INSTITUTION_ADMIN') OR freehold._has_governance_capability(p_actor,'FINANCIAL_REVIEWER')
   OR freehold._has_governance_capability(p_actor,'AUDITOR')) THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'id',p.id,'scope',p.scope,'accountId',p.account_id,'currencyCode',p.currency_code,'ruleCode',p.rule_code,
   'thresholdMinor',p.threshold_minor::text,'thresholdCount',p.threshold_count,'windowSeconds',p.window_seconds,
   'sizeMultiple',p.size_multiple,'timezone',p.timezone,'enabled',p.enabled,'governanceRequestId',p.governance_request_id
  ) ORDER BY p.scope,p.rule_code,p.account_id NULLS FIRST,p.currency_code NULLS FIRST)
  FROM freehold.risk_policies p),'[]'::jsonb);
END $$;

CREATE TABLE freehold.compliance_cases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 2000),
 severity text NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH')),
 status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','UNDER_REVIEW','ESCALATED','RESOLVED','CLOSED')),
 subject_user_id uuid REFERENCES freehold.users(id),
 subject_account_id uuid REFERENCES freehold.accounts(id),
 assigned_reviewer_id uuid REFERENCES freehold.users(id),
 opened_by uuid NOT NULL REFERENCES freehold.users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (subject_user_id IS NOT NULL OR subject_account_id IS NOT NULL)
);
CREATE FUNCTION freehold._compliance_case_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'COMPLIANCE_CASE_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF NEW.id<>OLD.id OR NEW.summary<>OLD.summary OR NEW.severity<>OLD.severity
    OR NEW.subject_user_id IS DISTINCT FROM OLD.subject_user_id OR NEW.subject_account_id IS DISTINCT FROM OLD.subject_account_id
    OR NEW.opened_by<>OLD.opened_by OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'COMPLIANCE_CASE_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER compliance_cases_guard BEFORE UPDATE OR DELETE ON freehold.compliance_cases
 FOR EACH ROW EXECUTE FUNCTION freehold._compliance_case_guard();
CREATE TABLE freehold.compliance_case_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 case_id uuid NOT NULL REFERENCES freehold.compliance_cases(id),
 event_type text NOT NULL CHECK (event_type IN ('OPENED','STATUS','NOTE','ASSIGN','LINK')),
 actor_id uuid NOT NULL REFERENCES freehold.users(id),
 body text,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER compliance_case_events_immutable BEFORE UPDATE OR DELETE ON freehold.compliance_case_events
 FOR EACH ROW EXECUTE FUNCTION freehold._governance_immutable();
CREATE TABLE freehold.compliance_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 case_id uuid NOT NULL REFERENCES freehold.compliance_cases(id),
 link_type text NOT NULL CHECK (link_type IN ('ACCOUNT','USER','OPERATION','RISK_FLAG','EVIDENCE')),
 ref_id uuid NOT NULL,
 label text,
 linked_by uuid NOT NULL REFERENCES freehold.users(id),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (case_id,link_type,ref_id)
);
CREATE TRIGGER compliance_links_immutable BEFORE UPDATE OR DELETE ON freehold.compliance_links
 FOR EACH ROW EXECUTE FUNCTION freehold._governance_immutable();
CREATE INDEX compliance_cases_status_idx ON freehold.compliance_cases(status,updated_at DESC);

CREATE FUNCTION freehold._require_compliance_reader(p_actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 IF NOT (freehold._has_governance_capability(p_actor,'COMPLIANCE_OFFICER') OR freehold._has_governance_capability(p_actor,'AUDITOR')) THEN
  RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501';
 END IF;
END $$;

CREATE FUNCTION freehold._require_compliance_writer(p_actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 IF NOT freehold._has_governance_capability(p_actor,'COMPLIANCE_OFFICER') THEN
  RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501';
 END IF;
END $$;

CREATE FUNCTION freehold.compliance_open_case(p_actor uuid,p_summary text,p_severity text,p_subject_user uuid,p_subject_account uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE owner uuid; cid uuid;
BEGIN
 PERFORM freehold._require_compliance_writer(p_actor);
 IF p_summary IS NULL OR length(btrim(p_summary)) NOT BETWEEN 1 AND 2000 OR p_severity NOT IN ('LOW','MEDIUM','HIGH')
    OR (p_subject_user IS NULL AND p_subject_account IS NULL) THEN
  RAISE EXCEPTION 'INVALID_COMPLIANCE_CASE' USING ERRCODE='22023';
 END IF;
 IF p_subject_user IS NOT NULL AND NOT EXISTS(SELECT 1 FROM freehold.users WHERE id=p_subject_user) THEN
  RAISE EXCEPTION 'INVALID_COMPLIANCE_CASE' USING ERRCODE='22023';
 END IF;
 IF p_subject_account IS NOT NULL THEN
  SELECT owner_user_id INTO owner FROM freehold.accounts WHERE id=p_subject_account;
  IF NOT FOUND OR (p_subject_user IS NOT NULL AND owner<>p_subject_user) THEN RAISE EXCEPTION 'INVALID_COMPLIANCE_CASE' USING ERRCODE='22023'; END IF;
 END IF;
 INSERT INTO freehold.compliance_cases(summary,severity,subject_user_id,subject_account_id,opened_by)
 VALUES(btrim(p_summary),p_severity,p_subject_user,p_subject_account,p_actor) RETURNING id INTO cid;
 INSERT INTO freehold.compliance_case_events(case_id,event_type,actor_id,metadata)
 VALUES(cid,'OPENED',p_actor,jsonb_build_object('severity',p_severity));
 RETURN jsonb_build_object('caseId',cid,'status','OPEN');
END $$;

CREATE FUNCTION freehold.compliance_transition(p_actor uuid,p_case uuid,p_status text,p_reviewer uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE c freehold.compliance_cases; legal boolean;
BEGIN
 PERFORM freehold._require_compliance_writer(p_actor);
 SELECT * INTO c FROM freehold.compliance_cases WHERE id=p_case FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'COMPLIANCE_CASE_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF p_status NOT IN ('OPEN','UNDER_REVIEW','ESCALATED','RESOLVED','CLOSED') THEN RAISE EXCEPTION 'COMPLIANCE_TRANSITION_INVALID' USING ERRCODE='55000'; END IF;
 legal:=(c.status='OPEN' AND p_status IN ('UNDER_REVIEW','ESCALATED','CLOSED'))
   OR (c.status='UNDER_REVIEW' AND p_status IN ('ESCALATED','RESOLVED','OPEN'))
   OR (c.status='ESCALATED' AND p_status IN ('UNDER_REVIEW','RESOLVED'))
   OR (c.status='RESOLVED' AND p_status='CLOSED');
 IF p_status=c.status THEN legal:=false; END IF;
 IF p_reviewer IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM freehold.users u JOIN freehold.governance_capabilities g ON g.principal_id=u.id
   WHERE u.id=p_reviewer AND u.status='ACTIVE' AND u.role='ADMIN' AND g.capability='COMPLIANCE_OFFICER' AND g.revoked_at IS NULL) THEN
  RAISE EXCEPTION 'COMPLIANCE_REVIEWER_INVALID' USING ERRCODE='22023';
 END IF;
 IF NOT legal AND (p_reviewer IS NULL OR p_reviewer IS NOT DISTINCT FROM c.assigned_reviewer_id OR c.status='CLOSED') THEN
  RAISE EXCEPTION 'COMPLIANCE_TRANSITION_INVALID' USING ERRCODE='55000';
 END IF;
 IF legal THEN
  UPDATE freehold.compliance_cases SET status=p_status,updated_at=clock_timestamp() WHERE id=p_case;
  INSERT INTO freehold.compliance_case_events(case_id,event_type,actor_id,metadata)
  VALUES(p_case,'STATUS',p_actor,jsonb_build_object('from',c.status,'to',p_status));
 END IF;
 IF p_reviewer IS NOT NULL AND p_reviewer IS DISTINCT FROM c.assigned_reviewer_id AND c.status<>'CLOSED' AND (NOT legal OR p_status<>'CLOSED') THEN
  UPDATE freehold.compliance_cases SET assigned_reviewer_id=p_reviewer,updated_at=clock_timestamp() WHERE id=p_case;
  INSERT INTO freehold.compliance_case_events(case_id,event_type,actor_id,metadata)
  VALUES(p_case,'ASSIGN',p_actor,jsonb_build_object('reviewerId',p_reviewer));
 END IF;
 RETURN jsonb_build_object('caseId',p_case,'status',CASE WHEN legal THEN p_status ELSE c.status END,'assignedReviewerId',COALESCE(p_reviewer,c.assigned_reviewer_id));
END $$;

CREATE FUNCTION freehold.compliance_add_note(p_actor uuid,p_case uuid,p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE c freehold.compliance_cases; eid bigint;
BEGIN
 PERFORM freehold._require_compliance_writer(p_actor);
 IF p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'INVALID_COMPLIANCE_NOTE' USING ERRCODE='22023'; END IF;
 SELECT * INTO c FROM freehold.compliance_cases WHERE id=p_case;
 IF NOT FOUND THEN RAISE EXCEPTION 'COMPLIANCE_CASE_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF c.status='CLOSED' THEN RAISE EXCEPTION 'COMPLIANCE_CASE_CLOSED' USING ERRCODE='55000'; END IF;
 INSERT INTO freehold.compliance_case_events(case_id,event_type,actor_id,body) VALUES(p_case,'NOTE',p_actor,btrim(p_note)) RETURNING id INTO eid;
 UPDATE freehold.compliance_cases SET updated_at=clock_timestamp() WHERE id=p_case;
 RETURN jsonb_build_object('caseId',p_case,'eventId',eid);
END $$;

CREATE FUNCTION freehold.compliance_link(p_actor uuid,p_case uuid,p_type text,p_ref uuid,p_label text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE c freehold.compliance_cases; lid uuid;
BEGIN
 PERFORM freehold._require_compliance_writer(p_actor);
 SELECT * INTO c FROM freehold.compliance_cases WHERE id=p_case;
 IF NOT FOUND THEN RAISE EXCEPTION 'COMPLIANCE_CASE_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF c.status='CLOSED' THEN RAISE EXCEPTION 'COMPLIANCE_CASE_CLOSED' USING ERRCODE='55000'; END IF;
 IF p_type NOT IN ('ACCOUNT','USER','OPERATION','RISK_FLAG','EVIDENCE') OR p_ref IS NULL THEN RAISE EXCEPTION 'INVALID_COMPLIANCE_LINK' USING ERRCODE='22023'; END IF;
 IF p_type='EVIDENCE' AND (p_label IS NULL OR length(btrim(p_label)) NOT BETWEEN 1 AND 200) THEN RAISE EXCEPTION 'INVALID_COMPLIANCE_LINK' USING ERRCODE='22023'; END IF;
 IF p_type='ACCOUNT' AND NOT EXISTS(SELECT 1 FROM freehold.accounts WHERE id=p_ref) THEN RAISE EXCEPTION 'INVALID_COMPLIANCE_LINK' USING ERRCODE='22023'; END IF;
 IF p_type='USER' AND NOT EXISTS(SELECT 1 FROM freehold.users WHERE id=p_ref) THEN RAISE EXCEPTION 'INVALID_COMPLIANCE_LINK' USING ERRCODE='22023'; END IF;
 IF p_type='OPERATION' AND NOT EXISTS(SELECT 1 FROM freehold.idempotency_requests WHERE operation_id=p_ref) THEN RAISE EXCEPTION 'INVALID_COMPLIANCE_LINK' USING ERRCODE='22023'; END IF;
 IF p_type='RISK_FLAG' AND NOT EXISTS(SELECT 1 FROM freehold.risk_flags WHERE id=p_ref) THEN RAISE EXCEPTION 'INVALID_COMPLIANCE_LINK' USING ERRCODE='22023'; END IF;
 INSERT INTO freehold.compliance_links(case_id,link_type,ref_id,label,linked_by)
 VALUES(p_case,p_type,p_ref,CASE WHEN p_type='EVIDENCE' THEN btrim(p_label) END,p_actor)
 ON CONFLICT (case_id,link_type,ref_id) DO NOTHING RETURNING id INTO lid;
 IF p_type='RISK_FLAG' THEN UPDATE freehold.risk_flags SET status='LINKED' WHERE id=p_ref AND status='OPEN'; END IF;
 INSERT INTO freehold.compliance_case_events(case_id,event_type,actor_id,metadata)
 VALUES(p_case,'LINK',p_actor,jsonb_build_object('linkType',p_type,'refId',p_ref));
 UPDATE freehold.compliance_cases SET updated_at=clock_timestamp() WHERE id=p_case;
 RETURN jsonb_build_object('caseId',p_case,'linkId',lid,'linkType',p_type,'refId',p_ref);
END $$;

CREATE FUNCTION freehold.compliance_list(p_actor uuid,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE lim integer:=LEAST(GREATEST(COALESCE(p_limit,50),1),100);
BEGIN
 PERFORM freehold._require_compliance_reader(p_actor);
 RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'caseId',c.id,'summary',c.summary,'severity',c.severity,'status',c.status,
   'subjectUserId',c.subject_user_id,'subjectAccountId',c.subject_account_id,'assignedReviewerId',c.assigned_reviewer_id,
   'openedBy',c.opened_by,'createdAt',freehold._ts_utc(c.created_at),'updatedAt',freehold._ts_utc(c.updated_at)
  ) ORDER BY c.updated_at DESC,c.id DESC)
  FROM (SELECT * FROM freehold.compliance_cases ORDER BY updated_at DESC,id DESC LIMIT lim) c),'[]'::jsonb);
END $$;

CREATE FUNCTION freehold.compliance_get(p_actor uuid,p_case uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE c freehold.compliance_cases;
BEGIN
 PERFORM freehold._require_compliance_reader(p_actor);
 SELECT * INTO c FROM freehold.compliance_cases WHERE id=p_case;
 IF NOT FOUND THEN RAISE EXCEPTION 'COMPLIANCE_CASE_NOT_FOUND' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object(
  'caseId',c.id,'summary',c.summary,'severity',c.severity,'status',c.status,
  'subjectUserId',c.subject_user_id,'subjectAccountId',c.subject_account_id,'assignedReviewerId',c.assigned_reviewer_id,
  'openedBy',c.opened_by,'createdAt',freehold._ts_utc(c.created_at),'updatedAt',freehold._ts_utc(c.updated_at),
  'events',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'eventType',e.event_type,'actorId',e.actor_id,'body',e.body,'metadata',e.metadata,'recordedAt',freehold._ts_utc(e.recorded_at)) ORDER BY e.id)
    FROM freehold.compliance_case_events e WHERE e.case_id=c.id),'[]'::jsonb),
  'links',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',l.id,'linkType',l.link_type,'refId',l.ref_id,'label',l.label,'linkedBy',l.linked_by,'recordedAt',freehold._ts_utc(l.recorded_at)) ORDER BY l.recorded_at)
    FROM freehold.compliance_links l WHERE l.case_id=c.id),'[]'::jsonb));
END $$;

CREATE FUNCTION freehold.worker_backlog_status()
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
 SELECT jsonb_build_object('count',count(*),
  'oldestAgeSeconds',CASE WHEN count(*)=0 THEN NULL ELSE floor(extract(epoch FROM clock_timestamp()-min(created_at)))::bigint END)
 FROM freehold.outbox_events WHERE dispatched_at IS NULL
$$;

CREATE FUNCTION freehold.institutional_report(p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE control freehold.institutional_control; recon jsonb; backlog jsonb;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 IF NOT (freehold._has_governance_capability(p_actor,'AUDITOR') OR freehold._has_governance_capability(p_actor,'FINANCIAL_REVIEWER')
   OR freehold._has_governance_capability(p_actor,'INSTITUTION_ADMIN') OR freehold._has_governance_capability(p_actor,'COMPLIANCE_OFFICER')) THEN
  RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501';
 END IF;
 SELECT * INTO control FROM freehold.institutional_control WHERE singleton;
 recon:=freehold.admin_latest_reconciliation();
 SELECT freehold.worker_backlog_status() INTO backlog;
 RETURN jsonb_build_object(
  'generatedAt',freehold._ts_utc(clock_timestamp()),
  'database','CONNECTED',
  'issuanceEnabled',false,
  'externalAssets',jsonb_build_object('status','UNAVAILABLE','reason','No independently attested external asset register is connected. Sandbox funding is not an asset.'),
  'reportingNote','Currencies are not summed. Sandbox funding issued is an internal equity contra, not reserve assets. No funding ratio is computed.',
  'financialIntegrity',jsonb_build_object(
    'independentVerification',jsonb_build_object('status','UNAVAILABLE','reason','Verifier output is external evidence and is not stored in PostgreSQL.'),
    'reconciliation',recon,
    'writesSuspended',control.writes_suspended,
    'suspensionReason',control.suspension_reason),
  'systemHealth',jsonb_build_object(
    'workerProcess','UNAVAILABLE',
    'outboxBacklogCount',(backlog->>'count')::bigint,
    'outboxOldestAgeSeconds',backlog->'oldestAgeSeconds',
    'recoveryTest',jsonb_build_object('status','UNAVAILABLE','reason','Recovery drills are external evidence and are not stored in PostgreSQL.')),
  'governance',jsonb_build_object(
    'pending',(SELECT count(*) FROM freehold.governance_requests WHERE status='PENDING'),
    'expiringWithin4Hours',(SELECT count(*) FROM freehold.governance_requests WHERE status IN ('PENDING','APPROVED') AND expires_at>clock_timestamp() AND expires_at<=clock_timestamp()+interval '4 hours'),
    'recentExecutions',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'requestId',a.request_id,'outcome',a.outcome,'recordedAt',freehold._ts_utc(a.recorded_at)) ORDER BY a.id DESC)
      FROM (SELECT * FROM freehold.governance_audit WHERE event_type='EXECUTED' ORDER BY id DESC LIMIT 20) a),'[]'::jsonb),
    'recentAuthorizationFailures',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'actorId',a.requesting_principal,'action',a.metadata->>'action','failureCode',a.metadata->>'failureCode','recordedAt',freehold._ts_utc(a.recorded_at)) ORDER BY a.id DESC)
      FROM (SELECT * FROM freehold.governance_audit WHERE event_type='AUTHORIZATION_FAILURE' ORDER BY id DESC LIMIT 20) a),'[]'::jsonb)),
  'risk',jsonb_build_object(
    'openFlags',(SELECT count(*) FROM freehold.risk_flags WHERE status='OPEN'),
    'openCases',(SELECT count(*) FROM freehold.compliance_cases WHERE status IN ('OPEN','UNDER_REVIEW','ESCALATED')),
    'limitRejections24h',(SELECT count(*) FROM freehold.transfers WHERE failure_code LIKE 'LIMIT\_%' ESCAPE '\' AND created_at>=clock_timestamp()-interval '24 hours'),
    'highSeverityOpenFlags',(SELECT count(*) FROM freehold.risk_flags WHERE status='OPEN' AND severity='HIGH')),
  'liabilities',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'currency',c.code,'exponent',c.minor_unit_exponent,
      'customerLiabilityMinor',COALESCE(s.liability,0)::text,
      'sandboxFundingIssuedMinor',COALESCE(s.sandbox,0)::text) ORDER BY c.code)
    FROM freehold.currencies c
    LEFT JOIN (
      SELECT la.currency_code,
        sum(CASE WHEN la.accounting_class='LIABILITY' AND e.side='CREDIT' THEN e.amount_minor::numeric WHEN la.accounting_class='LIABILITY' THEN -e.amount_minor::numeric ELSE 0 END) AS liability,
        sum(CASE WHEN la.bucket='SANDBOX_EQUITY' AND e.side='DEBIT' THEN e.amount_minor::numeric WHEN la.bucket='SANDBOX_EQUITY' THEN -e.amount_minor::numeric ELSE 0 END) AS sandbox
      FROM freehold.ledger_entries e JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id
      GROUP BY la.currency_code) s ON s.currency_code=c.code
    WHERE s.currency_code IS NOT NULL OR EXISTS(SELECT 1 FROM freehold.accounts a WHERE a.currency_code=c.code)),'[]'::jsonb),
  'accounts',COALESCE((SELECT jsonb_agg(jsonb_build_object('currency',currency_code,'status',status,'count',count) ORDER BY currency_code,status)
    FROM (SELECT currency_code,status,count(*) AS count FROM freehold.accounts GROUP BY currency_code,status) s),'[]'::jsonb),
  'transfers',COALESCE((SELECT jsonb_agg(jsonb_build_object('currency',t.currency_code,'state',t.state,'count',t.count,'amountMinor',t.amount_minor::text,'exponent',c.minor_unit_exponent) ORDER BY t.currency_code,t.state)
    FROM (SELECT currency_code,state,count(*) AS count,sum(amount_minor::numeric) AS amount_minor FROM freehold.transfers GROUP BY currency_code,state) t
    JOIN freehold.currencies c ON c.code=t.currency_code),'[]'::jsonb),
  'activeHolds',COALESCE((SELECT jsonb_agg(jsonb_build_object('currency',h.currency_code,'count',h.count,'amountMinor',h.amount_minor::text,'exponent',c.minor_unit_exponent) ORDER BY h.currency_code)
    FROM (SELECT currency_code,count(*) AS count,sum(amount_minor::numeric) AS amount_minor FROM freehold.holds WHERE state='ACTIVE' GROUP BY currency_code) h
    JOIN freehold.currencies c ON c.code=h.currency_code),'[]'::jsonb));
END $$;

REVOKE ALL ON TABLE freehold.api_sessions,freehold.risk_policies,freehold.risk_policy_changes,freehold.risk_flags,freehold.risk_observations,
 freehold.compliance_cases,freehold.compliance_case_events,freehold.compliance_links
 FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier,freehold_auth;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA freehold FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier,freehold_auth;
GRANT SELECT (id,scope,account_id,currency_code,rule_code,threshold_minor,threshold_count,window_seconds,size_multiple,timezone,enabled,governance_request_id)
 ON freehold.risk_policies TO freehold_verifier;
GRANT SELECT (id,policy_id,governance_request_id,parameters,recorded_at) ON freehold.risk_policy_changes TO freehold_verifier;

REVOKE ALL ON FUNCTION
 freehold._ts_utc(timestamptz),
 freehold.account_statement(uuid,uuid,timestamptz,timestamptz,integer,timestamptz,uuid),
 freehold.account_applicable_limits(uuid,uuid),
 freehold.risk_note_conflict(uuid,text,bytea),
 freehold.risk_flags_list(uuid,integer),
 freehold.risk_policies_list(uuid),
 freehold._compliance_case_guard(),
 freehold._require_compliance_reader(uuid),
 freehold._require_compliance_writer(uuid),
 freehold.compliance_open_case(uuid,text,text,uuid,uuid),
 freehold.compliance_transition(uuid,uuid,text,uuid),
 freehold.compliance_add_note(uuid,uuid,text),
 freehold.compliance_link(uuid,uuid,text,uuid,text),
 freehold.compliance_list(uuid,integer),
 freehold.compliance_get(uuid,uuid),
 freehold.worker_backlog_status(),
 freehold.institutional_report(uuid),
 freehold.auth_bind_session(uuid,bigint,bytea,timestamptz,integer),
 freehold.auth_revoke_session(bytea),
 freehold.auth_find_credentials(text)
 FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier,freehold_auth;

GRANT EXECUTE ON FUNCTION
 freehold.account_statement(uuid,uuid,timestamptz,timestamptz,integer,timestamptz,uuid),
 freehold.account_applicable_limits(uuid,uuid),
 freehold.risk_note_conflict(uuid,text,bytea),
 freehold.risk_flags_list(uuid,integer),
 freehold.risk_policies_list(uuid),
 freehold.compliance_open_case(uuid,text,text,uuid,uuid),
 freehold.compliance_transition(uuid,uuid,text,uuid),
 freehold.compliance_add_note(uuid,uuid,text),
 freehold.compliance_link(uuid,uuid,text,uuid,text),
 freehold.compliance_list(uuid,integer),
 freehold.compliance_get(uuid,uuid),
 freehold.institutional_report(uuid),
 freehold.governance_create_risk_policy_request(uuid,jsonb,text,text)
 TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.worker_backlog_status() TO freehold_worker;
GRANT EXECUTE ON FUNCTION freehold.auth_find_credentials(text),
 freehold.auth_bind_session(uuid,bigint,bytea,timestamptz,integer),
 freehold.auth_revoke_session(bytea) TO freehold_auth;
REVOKE ALL ON FUNCTION freehold.auth_find_credentials(text) FROM freehold_api;
-- PostgreSQL's default function ACL grants EXECUTE to PUBLIC, and
-- ALTER DEFAULT PRIVILEGES REVOKE does not materialize a denial on this server.
-- A blanket revoke leaves the explicit runtime grants above intact.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA freehold FROM PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE freehold_owner IN SCHEMA freehold REVOKE ALL ON TABLES FROM freehold_auth;
ALTER DEFAULT PRIVILEGES FOR ROLE freehold_owner IN SCHEMA freehold REVOKE EXECUTE ON FUNCTIONS FROM freehold_auth;
ALTER DEFAULT PRIVILEGES FOR ROLE freehold_owner IN SCHEMA freehold REVOKE ALL ON SEQUENCES FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier,freehold_auth;

RESET ROLE;
COMMIT;
