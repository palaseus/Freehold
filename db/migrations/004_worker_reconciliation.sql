-- Durable worker inbox, leased outbox claims, and read-only ledger reconciliation.
-- Worker code receives EXECUTE grants only; it never gets table DML privileges.
BEGIN;
SET LOCAL ROLE freehold_owner;

CREATE TABLE freehold.worker_inbox (
 event_id uuid PRIMARY KEY REFERENCES freehold.outbox_events(id),
 worker_id uuid NOT NULL,
 status text NOT NULL CHECK (status IN ('PROCESSING','PROCESSED')),
 claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_until timestamptz NOT NULL,
 attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
 processed_at timestamptz,
 CHECK ((status='PROCESSING' AND processed_at IS NULL) OR (status='PROCESSED' AND processed_at IS NOT NULL))
);
CREATE INDEX worker_inbox_lease_idx ON freehold.worker_inbox(status,lease_until);

CREATE FUNCTION freehold.worker_claim_outbox(p_worker_id uuid,p_limit integer DEFAULT 25,p_lease_seconds integer DEFAULT 30)
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
  ON CONFLICT(event_id) DO UPDATE SET worker_id=EXCLUDED.worker_id,status='PROCESSING',claimed_at=EXCLUDED.claimed_at,
   lease_until=EXCLUDED.lease_until,attempt_count=inbox_row.attempt_count+1,processed_at=NULL
  RETURNING inbox_row.attempt_count INTO new_attempt;
  UPDATE freehold.outbox_events o SET attempt_count=o.attempt_count+1 WHERE o.id=candidate.event_id;
  RETURN QUERY SELECT candidate.event_id,candidate.operation_id,candidate.aggregate_id,candidate.event_type,
   candidate.payload_version,candidate.payload,candidate.created_at,candidate.actor_id,new_attempt;
 END LOOP;
END $$;

CREATE FUNCTION freehold.worker_complete_outbox(p_worker_id uuid,p_event_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 UPDATE freehold.worker_inbox SET status='PROCESSED',processed_at=clock_timestamp(),lease_until=clock_timestamp()
 WHERE event_id=p_event_id AND worker_id=p_worker_id AND status='PROCESSING';
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE freehold.outbox_events SET dispatched_at=clock_timestamp()
 WHERE id=p_event_id AND dispatched_at IS NULL;
 RETURN FOUND;
END $$;

CREATE FUNCTION freehold.worker_reconcile()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE
 report_id uuid:=gen_random_uuid();
 debit_credit_ok boolean;
 totals jsonb;
 projection_count integer;
 projection_examples jsonb;
 hold_count integer;
 hold_examples jsonb;
 is_balanced boolean;
 report jsonb;
BEGIN
 WITH currency_totals AS (
  SELECT currency_code,
   COALESCE(sum(amount_minor) FILTER (WHERE side='DEBIT'),0) AS debits,
   COALESCE(sum(amount_minor) FILTER (WHERE side='CREDIT'),0) AS credits
  FROM freehold.ledger_entries GROUP BY currency_code
 )
 SELECT COALESCE(jsonb_agg(jsonb_build_object('currency',currency_code,'debits',debits::text,'credits',credits::text) ORDER BY currency_code),'[]'::jsonb),
  COALESCE(bool_and(debits=credits),true)
 INTO totals,debit_credit_ok FROM currency_totals;

 WITH differences AS (
  SELECT a.id AS account_id,la.bucket,
   CASE la.bucket WHEN 'AVAILABLE' THEN a.available_minor ELSE a.reserved_minor END AS projected_minor,
   COALESCE(sum(CASE e.side WHEN 'CREDIT' THEN e.amount_minor ELSE -e.amount_minor END),0) AS ledger_minor
  FROM freehold.accounts a
  JOIN freehold.ledger_accounts la ON la.customer_account_id=a.id AND la.bucket IN ('AVAILABLE','RESERVED')
  LEFT JOIN freehold.ledger_entries e ON e.ledger_account_id=la.id
  GROUP BY a.id,a.available_minor,a.reserved_minor,la.id,la.bucket
 ), mismatches AS (
  SELECT * FROM differences WHERE projected_minor::numeric<>ledger_minor
 )
 SELECT count(*)::integer,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('accountId',account_id,'bucket',bucket,
   'projectedMinor',projected_minor::text,'ledgerMinor',ledger_minor::text) ORDER BY account_id,bucket)
   FROM (SELECT * FROM mismatches ORDER BY account_id,bucket LIMIT 50) sample),'[]'::jsonb)
 INTO projection_count,projection_examples FROM mismatches;

 WITH differences AS (
  SELECT a.id AS account_id,a.reserved_minor AS projected_minor,
   COALESCE(sum(h.amount_minor) FILTER (WHERE h.state='ACTIVE'),0) AS active_holds_minor
  FROM freehold.accounts a LEFT JOIN freehold.holds h ON h.account_id=a.id
  GROUP BY a.id,a.reserved_minor
 ), mismatches AS (
  SELECT * FROM differences WHERE projected_minor::numeric<>active_holds_minor
 )
 SELECT count(*)::integer,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('accountId',account_id,
   'reservedMinor',projected_minor::text,'activeHoldsMinor',active_holds_minor::text) ORDER BY account_id)
   FROM (SELECT * FROM mismatches ORDER BY account_id LIMIT 50) sample),'[]'::jsonb)
 INTO hold_count,hold_examples FROM mismatches;

 is_balanced:=debit_credit_ok AND projection_count=0 AND hold_count=0;
 report:=jsonb_build_object('reconciliationId',report_id,'balanced',is_balanced,
  'debitsEqualCredits',debit_credit_ok,'totalsByCurrency',totals,
  'projectionMismatchCount',projection_count,'projectionMismatches',projection_examples,
  'activeHoldMismatchCount',hold_count,'activeHoldMismatches',hold_examples,
  'correlationId',report_id);
 IF NOT is_balanced THEN
  INSERT INTO freehold.audit_log(service_identity,event_type,resource_id,correlation_id,request_id,outcome,metadata)
  VALUES('freehold-reconciliation-worker','LEDGER_RECONCILIATION_MISMATCH',report_id,report_id,report_id,'REJECTED',
   jsonb_build_object('severity','HIGH','reconciliation',report));
  report:=report||jsonb_build_object('highSeverityAuditWritten',true);
 ELSE
  report:=report||jsonb_build_object('highSeverityAuditWritten',false);
 END IF;
 RETURN report;
END $$;

REVOKE ALL ON TABLE freehold.worker_inbox FROM PUBLIC,freehold_app;
REVOKE ALL ON FUNCTION freehold.worker_claim_outbox(uuid,integer,integer),
 freehold.worker_complete_outbox(uuid,uuid),freehold.worker_reconcile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION freehold.worker_claim_outbox(uuid,integer,integer),
 freehold.worker_complete_outbox(uuid,uuid),freehold.worker_reconcile() TO freehold_app;
RESET ROLE;
COMMIT;
