-- Scheduler liveness and lock-wait abort. Does not post journals or change balances.
-- A lock timeout, deadlock, serialization failure, or query cancel rolls the
-- due-run back. It does not push the instruction forward.
BEGIN;
SET LOCAL ROLE freehold_owner;

CREATE TABLE freehold.scheduler_heartbeats (
  scheduler_id uuid PRIMARY KEY,
  seen_at timestamptz NOT NULL
);

CREATE FUNCTION freehold.scheduler_record_heartbeat(p_scheduler_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
  IF SESSION_USER IS DISTINCT FROM 'freehold_scheduler' THEN
    RAISE EXCEPTION 'SCHEDULER_ROLE_REQUIRED' USING ERRCODE='42501';
  END IF;
  IF p_scheduler_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_SCHEDULER_HEARTBEAT' USING ERRCODE='22023';
  END IF;
  INSERT INTO freehold.scheduler_heartbeats(scheduler_id, seen_at)
  VALUES (p_scheduler_id, clock_timestamp())
  ON CONFLICT (scheduler_id) DO UPDATE SET seen_at=EXCLUDED.seen_at;
END $$;

CREATE OR REPLACE FUNCTION freehold.scheduler_run_due(p_limit integer)
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
  EXCEPTION
   WHEN lock_not_available OR deadlock_detected OR serialization_failure OR query_canceled THEN
    RAISE;
   WHEN OTHERS THEN
    UPDATE freehold.scheduled_transfers SET last_status='FAILED', last_error=left(SQLERRM,200), last_execution_at=clock_timestamp(),
      next_execution_at=GREATEST(next_execution_at, clock_timestamp()+interval '1 minute')
     WHERE id=rec.id AND status='ACTIVE';
    results := results || jsonb_build_array(jsonb_build_object('instructionId',rec.id,'outcome','FAILED','error',SQLERRM));
  END;
 END LOOP;
 RETURN jsonb_build_object('processed',jsonb_array_length(results),'results',results);
END $$;

CREATE OR REPLACE FUNCTION freehold.operations_health(p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE backlog jsonb; seen timestamptz; worker_state text; scheduler_seen timestamptz; scheduler_state text;
BEGIN
 PERFORM freehold._gl_reader(p_actor);
 backlog := freehold.worker_backlog_status();
 SELECT max(seen_at) INTO seen FROM freehold.worker_heartbeats;
 worker_state := CASE WHEN seen IS NULL THEN 'UNAVAILABLE' WHEN seen<clock_timestamp()-interval '120 seconds' THEN 'STALE' ELSE 'RUNNING' END;
 SELECT max(seen_at) INTO scheduler_seen FROM freehold.scheduler_heartbeats;
 scheduler_state := CASE WHEN scheduler_seen IS NULL THEN 'UNAVAILABLE' WHEN scheduler_seen<clock_timestamp()-interval '120 seconds' THEN 'STALE' ELSE 'RUNNING' END;
 RETURN jsonb_build_object(
  'generatedAt',freehold._ts_utc(clock_timestamp()),
  'database','CONNECTED',
  'workerProcess',worker_state,
  'workerLastSeenAt',freehold._ts_utc(seen),
  'schedulerProcess',scheduler_state,
  'schedulerLastSeenAt',freehold._ts_utc(scheduler_seen),
  'outboxBacklogCount',(backlog->>'count')::bigint,
  'outboxOldestAgeSeconds',backlog->'oldestAgeSeconds',
  'outboxQuarantinedCount',(backlog->>'quarantinedCount')::bigint,
  'backupHealth',jsonb_build_object('status','UNAVAILABLE','reason','Backup evidence is not stored in this database.'),
  'latestVerifier',jsonb_build_object('status','UNAVAILABLE','reason','Verifier output is external evidence and is not stored in this database.'));
END $$;

CREATE OR REPLACE FUNCTION freehold.monitor_evaluate(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE
  divergent bigint; missing bigint; pending bigint; quarantined bigint; oldest bigint;
  suspended boolean; reason text; due_count bigint; due_age bigint; failed_gov bigint;
  balanced boolean; has_recon boolean; seen timestamptz; scheduler_seen timestamptz; archive_mode text;
  failed_wal bigint; last_failed timestamptz; last_archived timestamptz;
BEGIN
  PERFORM freehold._ops_actor(p_actor, true);
  SELECT count(*) FILTER (WHERE r.account_id IS NOT NULL AND (a.available_minor<>r.available_minor OR a.reserved_minor<>r.reserved_minor)),
         count(*) FILTER (WHERE r.account_id IS NULL)
    INTO divergent, missing
  FROM freehold.accounts a LEFT JOIN freehold.account_rollups r ON r.account_id=a.id;
  IF divergent>0 OR missing>0 THEN
    PERFORM freehold._alert_raise('projection-rollup-divergence','CRITICAL','ledger-monitor',
      'Customer balance projection disagrees with the committed rollup, or a rollup row is missing. This is not a full historical rescan.',
      '[]'::jsonb, jsonb_build_object('telemetry','MEASURED','divergentAccounts',divergent,'missingRollups',missing,
        'check','projection_vs_rollup','independentVerifier','NOT_INVOKED'));
  ELSE
    PERFORM freehold._alert_clear('projection-rollup-divergence');
  END IF;

  SELECT EXISTS(SELECT 1 FROM freehold.reconciliation_runs) INTO has_recon;
  IF NOT has_recon THEN
    PERFORM freehold._alert_raise('reconciliation-absent','INFORMATIONAL','reconciliation',
      'No worker reconciliation report is stored. Absence is not a healthy reconciliation.',
      '[]'::jsonb, jsonb_build_object('telemetry','UNAVAILABLE','latestBalanced',NULL));
    PERFORM freehold._alert_clear('reconciliation-mismatch');
  ELSE
    SELECT r.balanced INTO balanced FROM freehold.reconciliation_runs r ORDER BY r.recorded_at DESC, r.reconciliation_id DESC LIMIT 1;
    PERFORM freehold._alert_clear('reconciliation-absent');
    IF balanced THEN
      PERFORM freehold._alert_clear('reconciliation-mismatch');
    ELSE
      PERFORM freehold._alert_raise('reconciliation-mismatch','CRITICAL','reconciliation',
        'The latest stored worker reconciliation report is not balanced. This is an operational incident signal, not evidence of customer misconduct.',
        '[]'::jsonb, jsonb_build_object('telemetry','MEASURED','latestBalanced',false));
    END IF;
  END IF;

  SELECT count(*) FILTER (WHERE dispatched_at IS NULL AND quarantined_at IS NULL),
         count(*) FILTER (WHERE quarantined_at IS NOT NULL),
         floor(extract(epoch FROM clock_timestamp()-min(created_at) FILTER (WHERE dispatched_at IS NULL AND quarantined_at IS NULL)))::bigint
    INTO pending, quarantined, oldest
  FROM freehold.outbox_events;
  IF pending=0 THEN
    PERFORM freehold._alert_clear('outbox-backlog');
  ELSE
    PERFORM freehold._alert_raise('outbox-backlog',
      CASE WHEN pending>=1000 OR COALESCE(oldest,0)>=3600 THEN 'HIGH' WHEN pending>=100 OR COALESCE(oldest,0)>=300 THEN 'WARNING' ELSE 'INFORMATIONAL' END,
      'outbox','Outbox events are still undispatched.', '[]'::jsonb,
      jsonb_build_object('telemetry','MEASURED','pending',pending,'oldestAgeSeconds',oldest));
  END IF;
  IF quarantined>0 THEN
    PERFORM freehold._alert_raise('outbox-quarantine','HIGH','outbox','At least one outbox event is quarantined.',
      '[]'::jsonb, jsonb_build_object('telemetry','MEASURED','quarantined',quarantined));
  ELSE
    PERFORM freehold._alert_clear('outbox-quarantine');
  END IF;

  SELECT writes_suspended, suspension_reason INTO suspended, reason FROM freehold.institutional_control WHERE singleton;
  IF suspended THEN
    PERFORM freehold._alert_raise('emergency-suspension','HIGH','governance','Financial writes are suspended through the existing governance control.',
      '[]'::jsonb, jsonb_build_object('telemetry','MEASURED','writesSuspended',true,'reason',reason));
  ELSE
    PERFORM freehold._alert_clear('emergency-suspension');
  END IF;

  SELECT count(*), floor(extract(epoch FROM clock_timestamp()-min(next_execution_at)))::bigint
    INTO due_count, due_age
  FROM freehold.scheduled_transfers WHERE status='ACTIVE' AND next_execution_at<=clock_timestamp();
  IF due_count=0 OR COALESCE(due_age,0)<120 THEN
    PERFORM freehold._alert_clear('schedule-lag');
  ELSE
    PERFORM freehold._alert_raise('schedule-lag', CASE WHEN due_age>=3600 THEN 'HIGH' ELSE 'WARNING' END, 'scheduler',
      'An active scheduled transfer is past its execution time.', '[]'::jsonb,
      jsonb_build_object('telemetry','MEASURED','dueCount',due_count,'oldestAgeSeconds',due_age));
  END IF;

  SELECT count(*) INTO failed_gov FROM freehold.governance_requests
   WHERE status='FAILED' AND executed_at>clock_timestamp()-interval '24 hours';
  IF failed_gov>0 THEN
    PERFORM freehold._alert_raise('governance-execution-failure','WARNING','governance',
      'A governance execution failed in the last 24 hours.', '[]'::jsonb,
      jsonb_build_object('telemetry','MEASURED','failedExecutions',failed_gov));
  ELSE
    PERFORM freehold._alert_clear('governance-execution-failure');
  END IF;

  SELECT max(seen_at) INTO seen FROM freehold.worker_heartbeats;
  IF seen IS NULL THEN
    PERFORM freehold._alert_raise('worker-heartbeat','WARNING','worker',
      'No worker heartbeat is stored. Worker availability is not healthy.', '[]'::jsonb,
      jsonb_build_object('telemetry','UNAVAILABLE','lastSeenAt',NULL));
  ELSIF seen<clock_timestamp()-interval '120 seconds' THEN
    PERFORM freehold._alert_raise('worker-heartbeat','WARNING','worker','The newest worker heartbeat is older than 120 seconds.',
      '[]'::jsonb, jsonb_build_object('telemetry','MEASURED','lastSeenAt',freehold._ts_utc(seen)));
  ELSE
    PERFORM freehold._alert_clear('worker-heartbeat');
  END IF;

  SELECT max(seen_at) INTO scheduler_seen FROM freehold.scheduler_heartbeats;
  IF scheduler_seen IS NULL THEN
    PERFORM freehold._alert_raise('scheduler-heartbeat','WARNING','scheduler',
      'No scheduler heartbeat is stored. Scheduler availability is not healthy.', '[]'::jsonb,
      jsonb_build_object('telemetry','UNAVAILABLE','lastSeenAt',NULL));
  ELSIF scheduler_seen<clock_timestamp()-interval '120 seconds' THEN
    PERFORM freehold._alert_raise('scheduler-heartbeat','WARNING','scheduler','The newest scheduler heartbeat is older than 120 seconds.',
      '[]'::jsonb, jsonb_build_object('telemetry','MEASURED','lastSeenAt',freehold._ts_utc(scheduler_seen)));
  ELSE
    PERFORM freehold._alert_clear('scheduler-heartbeat');
  END IF;

  archive_mode := current_setting('archive_mode');
  IF archive_mode IN ('off','0') THEN
    PERFORM freehold._alert_raise('wal-archive','WARNING','wal',
      'WAL archive_mode is off. Archive health is not healthy.', '[]'::jsonb,
      jsonb_build_object('telemetry','MEASURED','archiveMode',archive_mode));
  ELSE
    SELECT failed_count, last_failed_time, last_archived_time INTO failed_wal, last_failed, last_archived FROM pg_stat_archiver;
    IF COALESCE(failed_wal,0)>0 AND (last_archived IS NULL OR last_failed>last_archived) THEN
      PERFORM freehold._alert_raise('wal-archive','HIGH','wal','The WAL archiver has a failure newer than the last archived file.',
        '[]'::jsonb, jsonb_build_object('telemetry','MEASURED','archiveMode',archive_mode,'failedCount',failed_wal));
    ELSE
      PERFORM freehold._alert_clear('wal-archive');
    END IF;
  END IF;

  PERFORM freehold._alert_raise('backup-telemetry','INFORMATIONAL','backup',
    'Database backup age is not stored in this database. Unavailable is not a recent backup.', '[]'::jsonb,
    jsonb_build_object('telemetry','UNAVAILABLE','backupAgeSeconds',NULL,
      'reason','Backup evidence is not stored in this database.'));
  PERFORM freehold._alert_raise('verifier-telemetry','INFORMATIONAL','verifier',
    'Independent verifier output is not stored in this database. Unavailable is not a successful verification.', '[]'::jsonb,
    jsonb_build_object('telemetry','UNAVAILABLE','reason','Verifier output is external evidence and is not stored in this database.'));

  RETURN jsonb_build_object('evaluatedAt',freehold._ts_utc(clock_timestamp()),
    'openAlerts',(SELECT count(*) FROM freehold.operational_alerts WHERE state<>'RESOLVED'),
    'financialRecordsChanged',false);
END $$;

REVOKE ALL ON TABLE freehold.scheduler_heartbeats
  FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier,freehold_auth,freehold_scheduler,freehold_backup;
REVOKE ALL ON FUNCTION freehold.scheduler_record_heartbeat(uuid)
  FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier,freehold_auth,freehold_scheduler,freehold_backup;
GRANT EXECUTE ON FUNCTION freehold.scheduler_record_heartbeat(uuid) TO freehold_scheduler;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA freehold FROM PUBLIC;
RESET ROLE;
COMMIT;
