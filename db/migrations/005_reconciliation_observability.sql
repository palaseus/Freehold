-- Persist worker reports and expose narrowly scoped admin read functions.
BEGIN;
SET LOCAL ROLE freehold_owner;

CREATE TABLE freehold.reconciliation_runs (
 reconciliation_id uuid PRIMARY KEY,
 balanced boolean NOT NULL,
 report jsonb NOT NULL CHECK (jsonb_typeof(report)='object'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX reconciliation_runs_latest_idx ON freehold.reconciliation_runs(recorded_at DESC,reconciliation_id DESC);
CREATE INDEX audit_log_recent_idx ON freehold.audit_log(recorded_at DESC,id DESC);
REVOKE ALL ON TABLE freehold.reconciliation_runs FROM PUBLIC,freehold_app;

CREATE FUNCTION freehold.worker_record_reconciliation(p_report jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE rid uuid; outcome boolean; checked_at timestamptz;
BEGIN
 IF jsonb_typeof(p_report)<>'object' OR NOT (p_report ? 'reconciliationId') OR NOT (p_report ? 'balanced') THEN
  RAISE EXCEPTION 'INVALID_RECONCILIATION_REPORT' USING ERRCODE='22023';
 END IF;
 rid:=(p_report->>'reconciliationId')::uuid;
 outcome:=(p_report->>'balanced')::boolean;
 INSERT INTO freehold.reconciliation_runs(reconciliation_id,balanced,report) VALUES(rid,outcome,p_report)
 ON CONFLICT(reconciliation_id) DO NOTHING;
 SELECT recorded_at INTO checked_at FROM freehold.reconciliation_runs WHERE reconciliation_id=rid;
 RETURN p_report||jsonb_build_object('checkedAt',checked_at);
END $$;

CREATE FUNCTION freehold.admin_latest_reconciliation()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
 SELECT report||jsonb_build_object('checkedAt',recorded_at)
 FROM freehold.reconciliation_runs ORDER BY recorded_at DESC,reconciliation_id DESC LIMIT 1
$$;

CREATE FUNCTION freehold.admin_audit_events(p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'id',id,'eventType',event_type,'resourceId',resource_id,'operationId',operation_id,
  'correlationId',correlation_id,'actorId',actor_id,'serviceIdentity',service_identity,
  'outcome',outcome,'severity',metadata->>'severity','metadata',metadata,'recordedAt',recorded_at
 ) ORDER BY recorded_at DESC,id DESC),'[]'::jsonb)
 FROM (SELECT * FROM freehold.audit_log ORDER BY recorded_at DESC,id DESC LIMIT LEAST(GREATEST(p_limit,1),100)) recent
$$;

REVOKE ALL ON FUNCTION freehold.worker_record_reconciliation(jsonb),freehold.admin_latest_reconciliation(),freehold.admin_audit_events(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION freehold.worker_record_reconciliation(jsonb),freehold.admin_latest_reconciliation(),freehold.admin_audit_events(integer) TO freehold_app;
RESET ROLE;
COMMIT;
