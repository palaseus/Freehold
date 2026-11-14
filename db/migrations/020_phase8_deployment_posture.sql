-- Read-only operational facts for the institutional console.
-- No customer balances, emails, secrets, or journal lines.
-- The verifier is not granted EXECUTE. Algorithm 1.3.0 stays a table scan.
BEGIN;
GRANT USAGE ON SCHEMA freehold_deploy TO freehold_owner;
GRANT SELECT ON TABLE freehold_deploy.migrations TO freehold_owner;
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;

CREATE FUNCTION freehold.deployment_posture(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, freehold, pg_temp
AS $$
DECLARE
  backlog jsonb;
  recon jsonb;
BEGIN
  PERFORM freehold._gl_reader(p_actor);
  backlog := freehold.worker_backlog_status();
  SELECT jsonb_build_object(
    'balanced', r.balanced,
    'recordedAt', freehold._ts_utc(r.recorded_at),
    'debitsEqualCredits', r.report->>'debitsEqualCredits',
    'projectionMismatchCount', r.report->>'projectionMismatchCount',
    'activeHoldMismatchCount', r.report->>'activeHoldMismatchCount'
  ) INTO recon
  FROM freehold.reconciliation_runs r
  ORDER BY r.recorded_at DESC, r.reconciliation_id DESC
  LIMIT 1;
  RETURN jsonb_build_object(
    'activeMigration', (SELECT m.name FROM freehold_deploy.migrations m ORDER BY m.name DESC LIMIT 1),
    'archiveMode', current_setting('archive_mode'),
    'walLevel', current_setting('wal_level'),
    'sandboxEnabled', (SELECT sandbox_enabled FROM freehold.ledger_settings WHERE singleton),
    'demoEnabled', (SELECT enabled FROM freehold.demo_settings WHERE singleton),
    'writesSuspended', (SELECT writes_suspended FROM freehold.institutional_control WHERE singleton),
    'workerHeartbeatAt', freehold._ts_utc((SELECT max(seen_at) FROM freehold.worker_heartbeats)),
    'schedulerHeartbeatAt', freehold._ts_utc((SELECT max(seen_at) FROM freehold.scheduler_heartbeats)),
    'workerHeartbeatAgeSeconds', (SELECT CASE WHEN max(seen_at) IS NULL THEN NULL ELSE floor(extract(epoch FROM clock_timestamp() - max(seen_at)))::int END FROM freehold.worker_heartbeats),
    'schedulerHeartbeatAgeSeconds', (SELECT CASE WHEN max(seen_at) IS NULL THEN NULL ELSE floor(extract(epoch FROM clock_timestamp() - max(seen_at)))::int END FROM freehold.scheduler_heartbeats),
    'openCriticalIncidents', (SELECT count(*)::int FROM freehold.operational_incidents WHERE status IN ('OPEN','CONTAINED','ESCALATED') AND severity = 'CRITICAL'),
    'authorizationFailureCount', (SELECT count(*)::text FROM freehold.governance_audit WHERE event_type = 'AUTHORIZATION_FAILURE'),
    'pendingGovernanceApprovals', (SELECT count(*)::text FROM freehold.governance_requests WHERE status = 'PENDING'),
    'dueInstructionCount', (SELECT count(*)::int FROM freehold.scheduled_transfers WHERE status = 'ACTIVE' AND next_execution_at <= clock_timestamp()),
    'oldestDueAgeSeconds', (SELECT CASE WHEN count(*) = 0 THEN NULL ELSE floor(extract(epoch FROM clock_timestamp() - min(next_execution_at)))::int END FROM freehold.scheduled_transfers WHERE status = 'ACTIVE' AND next_execution_at <= clock_timestamp()),
    'outboxPending', backlog->>'count',
    'outboxOldestAgeSeconds', backlog->'oldestAgeSeconds',
    'outboxQuarantined', backlog->>'quarantinedCount',
    'latestReconciliation', recon,
    'runtimeRolesConfined', (
      SELECT count(*) = 5 AND COALESCE(bool_and(
        rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolinherit
        AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
      ), false)
      FROM pg_roles
      WHERE rolname IN ('freehold_api','freehold_worker','freehold_verifier','freehold_auth','freehold_scheduler')
    )
  );
END $$;

REVOKE ALL ON FUNCTION freehold.deployment_posture(uuid) FROM PUBLIC, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
GRANT EXECUTE ON FUNCTION freehold.deployment_posture(uuid) TO freehold_api;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA freehold FROM PUBLIC;
RESET ROLE;
COMMIT;
