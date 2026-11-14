-- Forward-only repair for deployments that already applied migrations 001-005.
-- Migrations run as the deployment identity. Runtime passwords are provisioned
-- by scripts/migrate.mjs from deployment-only environment variables.
BEGIN;

-- Role DDL is performed by the deployment identity before assuming the schema
-- owner, which intentionally has no CREATEROLE privilege.
CREATE ROLE freehold_api LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE freehold_worker LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
COMMENT ON ROLE freehold_api IS 'Trusted authenticated API process only. p_actor is supplied by this process; PostgreSQL does not authenticate HTTP users.';
COMMENT ON ROLE freehold_worker IS 'Outbox lease, acknowledgment, and database-computed reconciliation only; no financial posting authority.';
COMMENT ON ROLE freehold_app IS 'Legacy inert privilege group; no runtime login may inherit it.';
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='freehold_runtime') THEN
  EXECUTE 'REVOKE freehold_app FROM freehold_runtime';
  EXECUTE 'ALTER ROLE freehold_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
 END IF;
END $$;
ALTER ROLE freehold_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;

-- Keep the old group inert. Existing freehold_runtime logins are disabled and
-- removed from it; no service should use this shared identity after migration.
REVOKE ALL ON ALL TABLES IN SCHEMA freehold FROM PUBLIC, freehold_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA freehold FROM PUBLIC, freehold_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA freehold FROM PUBLIC, freehold_app;
-- Existing RETURNS TABLE output variable event_id conflicts with the unqualified
-- ON CONFLICT target in migration 004. A named constraint is unambiguous.
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
   AND (inbox.event_id IS NULL OR (inbox.status='PROCESSING' AND inbox.lease_until<=clock_timestamp()))
  ORDER BY o.created_at,o.id
  LIMIT p_limit
  FOR UPDATE OF o SKIP LOCKED
 LOOP
  INSERT INTO freehold.worker_inbox AS inbox_row(event_id,worker_id,status,claimed_at,lease_until,attempt_count)
  VALUES(candidate.event_id,p_worker_id,'PROCESSING',clock_timestamp(),clock_timestamp()+make_interval(secs=>p_lease_seconds),1)
  ON CONFLICT ON CONSTRAINT worker_inbox_pkey DO UPDATE SET worker_id=EXCLUDED.worker_id,status='PROCESSING',claimed_at=EXCLUDED.claimed_at,
   lease_until=EXCLUDED.lease_until,attempt_count=inbox_row.attempt_count+1,processed_at=NULL
  RETURNING inbox_row.attempt_count INTO new_attempt;
  UPDATE freehold.outbox_events o SET attempt_count=o.attempt_count+1 WHERE o.id=candidate.event_id;
  RETURN QUERY SELECT candidate.event_id,candidate.operation_id,candidate.aggregate_id,candidate.event_type,
   candidate.payload_version,candidate.payload,candidate.created_at,candidate.actor_id,new_attempt;
 END LOOP;
END $$;

-- Compute, audit, and persist from one REPEATABLE READ worker transaction.
-- The caller cannot submit report JSON; the report comes from worker_reconcile.
CREATE FUNCTION freehold.worker_reconcile_and_record()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE report jsonb; rid uuid; checked_at timestamptz;
BEGIN
 report:=freehold.worker_reconcile();
 rid:=(report->>'reconciliationId')::uuid;
 INSERT INTO freehold.reconciliation_runs(reconciliation_id,balanced,report)
 VALUES(rid,(report->>'balanced')::boolean,report);
 SELECT recorded_at INTO STRICT checked_at FROM freehold.reconciliation_runs WHERE reconciliation_id=rid;
 RETURN report||jsonb_build_object('checkedAt',checked_at);
END $$;

-- Record only the externally safe rejection while retaining the exact reason
-- in the institution audit record. Missing destinations cannot have a transfer
-- row because the transfer FK deliberately requires a real account.
CREATE FUNCTION freehold._finish_with_metadata(p_operation uuid,p_resource uuid,p_correlation uuid,p_body jsonb,
 p_status integer,p_metadata jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE r freehold.idempotency_requests; result jsonb;
BEGIN
 result:=p_body||jsonb_build_object('operationId',p_operation,'correlationId',p_correlation);
 UPDATE freehold.idempotency_requests SET resource_id=p_resource,response_status=p_status,response_body=result,completed_at=clock_timestamp()
 WHERE operation_id=p_operation AND response_body IS NULL RETURNING * INTO STRICT r;
 INSERT INTO freehold.audit_log(actor_id,event_type,resource_id,operation_id,correlation_id,request_id,outcome,metadata)
 VALUES(r.actor_id,r.operation,p_resource,p_operation,p_correlation,p_correlation,result->>'state',result||COALESCE(p_metadata,'{}'::jsonb));
 INSERT INTO freehold.outbox_events(aggregate_id,operation_id,event_type,payload)
 VALUES(p_resource,p_operation,r.operation||'.'||(result->>'state'),result);
 RETURN result;
END $$;

-- Normalize destination-specific validation to avoid disclosing existence,
-- currency, or status. Source/account and currency diagnostics remain unchanged.
CREATE OR REPLACE FUNCTION freehold.execute_internal_transfer(p_actor uuid,p_source uuid,p_destination uuid,p_currency text,p_amount bigint,p_key text,p_correlation uuid DEFAULT gen_random_uuid())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
DECLARE r freehold.idempotency_requests; src freehold.accounts; dst freehold.accounts;
 enabled boolean; failure text; transfer uuid:=gen_random_uuid(); journal uuid; debit uuid; credit uuid;
BEGIN
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

-- Remove the arbitrary report-ingestion RPC. API remains read-only through the
-- two admin functions below; only the worker can call compute-and-record.
DROP FUNCTION freehold.worker_record_reconciliation(jsonb);

REVOKE ALL ON ALL TABLES IN SCHEMA freehold FROM PUBLIC,freehold_app,freehold_api,freehold_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA freehold FROM PUBLIC,freehold_app,freehold_api,freehold_worker;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA freehold FROM PUBLIC,freehold_app,freehold_api,freehold_worker;
GRANT USAGE ON SCHEMA freehold TO freehold_api,freehold_worker;

GRANT SELECT ON freehold.currencies,freehold.accounts,freehold.ledger_accounts,
 freehold.ledger_journals,freehold.ledger_entries,freehold.transfers,freehold.holds,
 freehold.idempotency_requests TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.auth_find_credentials(text),freehold.auth_get_user(uuid),freehold.auth_lock_user(uuid),
 freehold.register_user(text,text,bytea),freehold.demo_bootstrap_admin(text,text,text,bytea),freehold.auth_user_email(uuid),
 freehold.admin_list_accounts(uuid,text,integer),freehold.admin_latest_reconciliation(),freehold.admin_audit_events(integer),
 freehold.execute_internal_transfer(uuid,uuid,uuid,text,bigint,text,uuid),
 freehold.reserve_funds(uuid,uuid,bigint,text,text,timestamptz,uuid),
 freehold.release_hold(uuid,uuid,text,uuid),
 freehold.sandbox_fund_account(uuid,uuid,bigint,text,text,uuid),
 freehold.create_account(uuid,text,text,uuid),
 freehold.set_account_frozen(uuid,uuid,boolean,text,text,uuid) TO freehold_api;

GRANT EXECUTE ON FUNCTION freehold.worker_claim_outbox(uuid,integer,integer),
 freehold.worker_complete_outbox(uuid,uuid),freehold.worker_reconcile_and_record() TO freehold_worker;

ALTER DEFAULT PRIVILEGES FOR ROLE freehold_owner IN SCHEMA freehold REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC,freehold_app,freehold_api,freehold_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE freehold_owner IN SCHEMA freehold REVOKE ALL ON TABLES FROM PUBLIC,freehold_app,freehold_api,freehold_worker;

RESET ROLE;
COMMIT;
