BEGIN;
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;
-- The deferred account check used to re-sum every historical entry while the
-- account row lock was still held. This migration keeps that check, but the
-- historical total is the last committed rollup. Only this transaction's
-- entries are summed again. The independent verifier still re-sums history.
-- Objects stay owned by freehold_owner. _check_account is SECURITY DEFINER and
-- must be able to maintain the rollup without a superuser owner.

CREATE TABLE freehold.account_rollups (
  account_id uuid PRIMARY KEY REFERENCES freehold.accounts(id),
  available_minor bigint NOT NULL,
  reserved_minor bigint NOT NULL,
  entry_count bigint NOT NULL CHECK (entry_count>=0),
  last_xid xid8,
  CHECK (available_minor>=0),
  CHECK (reserved_minor>=0)
);

INSERT INTO freehold.account_rollups(account_id,available_minor,reserved_minor,entry_count)
SELECT a.id,
  COALESCE((
    SELECT sum(CASE WHEN la.bucket='AVAILABLE' THEN CASE e.side WHEN 'CREDIT' THEN e.amount_minor ELSE -e.amount_minor END ELSE 0 END)
    FROM freehold.ledger_accounts la JOIN freehold.ledger_entries e ON e.ledger_account_id=la.id
    WHERE la.customer_account_id=a.id),0),
  COALESCE((
    SELECT sum(CASE WHEN la.bucket='RESERVED' THEN CASE e.side WHEN 'CREDIT' THEN e.amount_minor ELSE -e.amount_minor END ELSE 0 END)
    FROM freehold.ledger_accounts la JOIN freehold.ledger_entries e ON e.ledger_account_id=la.id
    WHERE la.customer_account_id=a.id),0),
  COALESCE((
    SELECT count(*) FROM freehold.ledger_accounts la JOIN freehold.ledger_entries e ON e.ledger_account_id=la.id
    WHERE la.customer_account_id=a.id),0)
FROM freehold.accounts a;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM freehold.accounts a JOIN freehold.account_rollups r ON r.account_id=a.id
    WHERE a.available_minor<>r.available_minor OR a.reserved_minor<>r.reserved_minor
  ) THEN
    RAISE EXCEPTION 'ROLLUP_BACKFILL_MISMATCH' USING ERRCODE='23514';
  END IF;
END $$;

CREATE INDEX ledger_journals_creation_xid_idx ON freehold.ledger_journals(creation_xid);
CREATE INDEX ledger_entries_journal_id_idx ON freehold.ledger_entries(journal_id);

CREATE OR REPLACE FUNCTION freehold._check_account(p_account uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE a freehold.accounts; r freehold.account_rollups;
 current_av bigint; current_rs bigint; current_count bigint; held numeric;
 expected_av bigint; expected_rs bigint; journal_ids uuid[];
BEGIN
 SELECT * INTO STRICT a FROM freehold.accounts WHERE id=p_account FOR UPDATE;
 SELECT * INTO r FROM freehold.account_rollups WHERE account_id=p_account FOR UPDATE;
 IF NOT FOUND THEN
  INSERT INTO freehold.account_rollups(account_id,available_minor,reserved_minor,entry_count)
  VALUES (p_account,0,0,0);
  SELECT * INTO STRICT r FROM freehold.account_rollups WHERE account_id=p_account FOR UPDATE;
 END IF;
 IF r.last_xid IS NOT DISTINCT FROM pg_current_xact_id() THEN
  expected_av := r.available_minor;
  expected_rs := r.reserved_minor;
 ELSE
  -- Resolve this transaction's journals first. A join that also filters by
  -- customer account lets the planner walk that account's whole history.
  SELECT COALESCE(array_agg(j.id), '{}'::uuid[]) INTO journal_ids
  FROM freehold.ledger_journals j WHERE j.creation_xid=pg_current_xact_id();
  SELECT COALESCE(sum(CASE WHEN la.bucket='AVAILABLE' THEN CASE e.side WHEN 'CREDIT' THEN e.amount_minor ELSE -e.amount_minor END ELSE 0 END),0)::bigint,
         COALESCE(sum(CASE WHEN la.bucket='RESERVED' THEN CASE e.side WHEN 'CREDIT' THEN e.amount_minor ELSE -e.amount_minor END ELSE 0 END),0)::bigint,
         count(e.id)::bigint
  INTO current_av,current_rs,current_count
  FROM freehold.ledger_entries e
  JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id
  WHERE e.journal_id = ANY(journal_ids) AND la.customer_account_id=p_account;
  expected_av := r.available_minor+current_av;
  expected_rs := r.reserved_minor+current_rs;
  UPDATE freehold.account_rollups
  SET available_minor=expected_av, reserved_minor=expected_rs, entry_count=r.entry_count+current_count, last_xid=pg_current_xact_id()
  WHERE account_id=p_account;
 END IF;
 SELECT coalesce(sum(amount_minor::numeric),0) INTO held FROM freehold.holds WHERE account_id=p_account AND state='ACTIVE';
 IF a.available_minor<0 OR a.reserved_minor<0 OR a.available_minor<>expected_av OR a.reserved_minor<>expected_rs OR a.reserved_minor::numeric<>held THEN
  RAISE EXCEPTION 'BALANCE_PROJECTION_OR_HOLD_MISMATCH: %',p_account USING ERRCODE='23514';
 END IF;
 IF (SELECT count(*) FROM freehold.ledger_accounts WHERE customer_account_id=p_account)<>2 THEN
  RAISE EXCEPTION 'MISSING_CUSTOMER_BUCKETS' USING ERRCODE='23514';
 END IF;
END $$;

-- Customer reads go through the bound session. Table SELECT let the API role
-- ignore the owner filter that application code remembered to add.
REVOKE SELECT ON freehold.accounts,freehold.ledger_accounts,freehold.ledger_journals,freehold.ledger_entries,
 freehold.transfers,freehold.holds,freehold.idempotency_requests FROM freehold_api;
REVOKE ALL ON TABLE freehold.account_rollups FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier,freehold_auth,freehold_scheduler,freehold_backup;

CREATE FUNCTION freehold.customer_account_list(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 RETURN COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'id',id,'currency',currency_code,'status',status,
    'availableMinor',available_minor::text,'reservedMinor',reserved_minor::text,
    'totalMinor',(available_minor+reserved_minor)::text) ORDER BY created_at,id)
  FROM freehold.accounts WHERE owner_user_id=p_actor),'[]'::jsonb);
END $$;

CREATE FUNCTION freehold.customer_account_get(p_actor uuid,p_account uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE row jsonb;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 SELECT jsonb_build_object(
  'id',id,'currency',currency_code,'status',status,
  'availableMinor',available_minor::text,'reservedMinor',reserved_minor::text,
  'totalMinor',(available_minor+reserved_minor)::text)
 INTO row FROM freehold.accounts WHERE id=p_account AND owner_user_id=p_actor;
 RETURN row;
END $$;

CREATE FUNCTION freehold.customer_account_owns(p_actor uuid,p_account uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 RETURN EXISTS(SELECT 1 FROM freehold.accounts WHERE id=p_account AND owner_user_id=p_actor);
END $$;

CREATE FUNCTION freehold.customer_account_activity(p_actor uuid,p_account uuid,p_before timestamptz,p_before_id uuid,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 IF p_limit IS NULL OR p_limit<1 OR p_limit>101 THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM freehold.accounts WHERE id=p_account AND owner_user_id=p_actor) THEN
  RAISE EXCEPTION 'ACCOUNT_NOT_AUTHORIZED' USING ERRCODE='42501';
 END IF;
 RETURN COALESCE((
  SELECT jsonb_agg(item ORDER BY sort_time DESC, sort_id DESC) FROM (
   SELECT jsonb_build_object(
    'id',e.id,'journalId',j.id,'kind',j.kind,'direction',e.side,
    'amountMinor',e.amount_minor::text,'currency',e.currency_code,
    'effectiveAt',to_char(j.effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'recordedAt',to_char(j.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'cursorTime',to_char(j.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'correlationId',j.correlation_id,
    'counterpartyAccountId',CASE WHEN j.kind='INTERNAL_TRANSFER' THEN CASE WHEN t.source_account_id=p_account THEN t.destination_account_id ELSE t.source_account_id END END
   ) AS item,
   j.recorded_at AS sort_time,
   e.id AS sort_id
   FROM freehold.ledger_entries e
   JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id
   JOIN freehold.ledger_journals j ON j.id=e.journal_id
   LEFT JOIN freehold.transfers t ON t.id=j.transfer_id
   WHERE la.customer_account_id=p_account
     AND (p_before IS NULL OR (j.recorded_at,e.id)<(p_before,p_before_id))
   ORDER BY j.recorded_at DESC,e.id DESC
   LIMIT p_limit) page),'[]'::jsonb);
END $$;

CREATE FUNCTION freehold.customer_idempotency_get(p_actor uuid,p_operation text,p_key text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE status integer; body jsonb;
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 IF p_operation IS NULL OR p_key IS NULL THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE='22023'; END IF;
 SELECT response_status,response_body INTO status,body FROM freehold.idempotency_requests
  WHERE actor_id=p_actor AND operation=p_operation AND key=p_key AND response_body IS NOT NULL;
 IF status IS NULL THEN RETURN jsonb_build_object('found',false); END IF;
 RETURN jsonb_build_object('found',true,'status',status,'result',body);
END $$;

CREATE FUNCTION freehold.customer_operation_result(p_actor uuid,p_operation uuid)
RETURNS TABLE(response_status integer,response_body jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 PERFORM freehold._require_bound_session(p_actor);
 RETURN QUERY SELECT r.response_status,r.response_body FROM freehold.idempotency_requests r
  WHERE r.operation_id=p_operation AND r.actor_id=p_actor;
END $$;

REVOKE ALL ON FUNCTION
 freehold.customer_account_list(uuid),
 freehold.customer_account_get(uuid,uuid),
 freehold.customer_account_owns(uuid,uuid),
 freehold.customer_account_activity(uuid,uuid,timestamptz,uuid,integer),
 freehold.customer_idempotency_get(uuid,text,text),
 freehold.customer_operation_result(uuid,uuid)
 FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier,freehold_auth,freehold_scheduler,freehold_backup;
GRANT EXECUTE ON FUNCTION
 freehold.customer_account_list(uuid),
 freehold.customer_account_get(uuid,uuid),
 freehold.customer_account_owns(uuid,uuid),
 freehold.customer_account_activity(uuid,uuid,timestamptz,uuid,integer),
 freehold.customer_idempotency_get(uuid,text,text),
 freehold.customer_operation_result(uuid,uuid)
 TO freehold_api;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA freehold FROM PUBLIC;
RESET ROLE;
COMMIT;
