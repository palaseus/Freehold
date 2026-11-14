BEGIN;
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;
-- Operational alerts and incidents. This migration does not post journals,
-- change balances, or replace the independent verifier. The monitor may record
-- an alert. It cannot edit a financial row.

CREATE TABLE freehold.operational_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_key text NOT NULL CHECK (length(btrim(alert_key)) BETWEEN 1 AND 120),
  severity text NOT NULL CHECK (severity IN ('INFORMATIONAL','WARNING','HIGH','CRITICAL')),
  source text NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 80),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
  correlation_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(correlation_ids)='array'),
  state text NOT NULL CHECK (state IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  details jsonb NOT NULL CHECK (jsonb_typeof(details)='object'),
  detected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES freehold.users(id),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES freehold.users(id),
  resolution text,
  CHECK ((state<>'ACKNOWLEDGED') OR (acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL)),
  CHECK ((state<>'RESOLVED') OR (resolved_at IS NOT NULL AND resolution IS NOT NULL))
);
CREATE UNIQUE INDEX operational_alerts_unresolved_key
  ON freehold.operational_alerts(alert_key) WHERE state<>'RESOLVED';

CREATE TABLE freehold.operational_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  classification text NOT NULL DEFAULT 'OPERATIONAL' CHECK (classification='OPERATIONAL'),
  severity text NOT NULL CHECK (severity IN ('INFORMATIONAL','WARNING','HIGH','CRITICAL')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CONTAINED','ESCALATED','RESOLVED','CLOSED')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 4000),
  assignee_id uuid REFERENCES freehold.users(id),
  containment text,
  resolution text,
  created_by uuid NOT NULL REFERENCES freehold.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  CHECK (status<>'CLOSED' OR (closed_at IS NOT NULL AND resolution IS NOT NULL)),
  CHECK (status<>'RESOLVED' OR resolution IS NOT NULL),
  CHECK (status<>'CONTAINED' OR containment IS NOT NULL)
);
CREATE TABLE freehold.operational_incident_alerts (
  incident_id uuid NOT NULL REFERENCES freehold.operational_incidents(id),
  alert_id uuid NOT NULL REFERENCES freehold.operational_alerts(id),
  linked_by uuid NOT NULL REFERENCES freehold.users(id),
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (incident_id, alert_id)
);
CREATE TABLE freehold.operational_incident_operations (
  incident_id uuid NOT NULL REFERENCES freehold.operational_incidents(id),
  operation_ref text NOT NULL CHECK (length(btrim(operation_ref)) BETWEEN 1 AND 200),
  linked_by uuid NOT NULL REFERENCES freehold.users(id),
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (incident_id, operation_ref)
);
CREATE TABLE freehold.operational_incident_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES freehold.operational_incidents(id),
  actor_id uuid NOT NULL REFERENCES freehold.users(id),
  event_type text NOT NULL CHECK (event_type IN (
    'CREATED','NOTE','EVIDENCE','LINK_ALERT','LINK_OPERATION','ASSIGN','ESCALATE','CONTAIN','RESOLVE','CLOSE')),
  body text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION freehold._incident_event_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'INCIDENT_AUDIT_IMMUTABLE' USING ERRCODE='55000';
END $$;
CREATE TRIGGER operational_incident_events_immutable
  BEFORE UPDATE OR DELETE ON freehold.operational_incident_events
  FOR EACH ROW EXECUTE FUNCTION freehold._incident_event_immutable();

CREATE FUNCTION freehold._ops_actor(p_actor uuid, p_write boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
  PERFORM freehold._require_bound_session(p_actor);
  IF p_write AND NOT (freehold._has_governance_capability(p_actor,'SECURITY_ADMIN') OR freehold._has_governance_capability(p_actor,'INSTITUTION_ADMIN')) THEN
    RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501';
  END IF;
  IF NOT p_write AND NOT (freehold._has_governance_capability(p_actor,'SECURITY_ADMIN') OR freehold._has_governance_capability(p_actor,'INSTITUTION_ADMIN')
    OR freehold._has_governance_capability(p_actor,'AUDITOR') OR freehold._has_governance_capability(p_actor,'FINANCIAL_REVIEWER')) THEN
    RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501';
  END IF;
END $$;

CREATE FUNCTION freehold._alert_raise(p_key text, p_severity text, p_source text, p_description text, p_correlation jsonb, p_details jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
  IF p_details->>'telemetry' IS NULL OR (p_details->>'telemetry') NOT IN ('MEASURED','UNAVAILABLE') THEN
    RAISE EXCEPTION 'ALERT_TELEMETRY_REQUIRED' USING ERRCODE='23514';
  END IF;
  INSERT INTO freehold.operational_alerts(alert_key,severity,source,description,correlation_ids,state,details)
  VALUES (p_key,p_severity,p_source,p_description,COALESCE(p_correlation,'[]'::jsonb),'OPEN',p_details)
  ON CONFLICT (alert_key) WHERE state<>'RESOLVED'
  DO UPDATE SET severity=EXCLUDED.severity, description=EXCLUDED.description, correlation_ids=EXCLUDED.correlation_ids,
    details=EXCLUDED.details, updated_at=clock_timestamp();
END $$;

CREATE FUNCTION freehold._alert_clear(p_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
  UPDATE freehold.operational_alerts
  SET state='RESOLVED', resolved_at=clock_timestamp(), resolution='CONDITION_CLEARED', updated_at=clock_timestamp()
  WHERE alert_key=p_key AND state<>'RESOLVED';
END $$;

-- Reads projections and rollups. Does not update either, and does not call the verifier.
CREATE FUNCTION freehold.monitor_evaluate(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE
  divergent bigint; missing bigint; pending bigint; quarantined bigint; oldest bigint;
  suspended boolean; reason text; due_count bigint; due_age bigint; failed_gov bigint;
  balanced boolean; has_recon boolean; seen timestamptz; archive_mode text;
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

CREATE FUNCTION freehold.alert_list(p_actor uuid, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE lim integer := least(GREATEST(COALESCE(p_limit,50),1),100);
BEGIN
  PERFORM freehold._ops_actor(p_actor, false);
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id',a.id,'alertKey',a.alert_key,'severity',a.severity,'source',a.source,'description',a.description,
    'correlationIds',a.correlation_ids,'state',a.state,'details',a.details,
    'detectedAt',freehold._ts_utc(a.detected_at),'updatedAt',freehold._ts_utc(a.updated_at),
    'acknowledgedAt',freehold._ts_utc(a.acknowledged_at),'acknowledgedBy',a.acknowledged_by,
    'resolvedAt',freehold._ts_utc(a.resolved_at),'resolvedBy',a.resolved_by,'resolution',a.resolution
  ) ORDER BY a.detected_at DESC, a.id) FROM (
    SELECT * FROM freehold.operational_alerts ORDER BY detected_at DESC, id LIMIT lim) a),'[]'::jsonb);
END $$;

CREATE FUNCTION freehold.alert_acknowledge(p_actor uuid, p_alert uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE row freehold.operational_alerts;
BEGIN
  PERFORM freehold._ops_actor(p_actor, true);
  UPDATE freehold.operational_alerts
  SET state='ACKNOWLEDGED', acknowledged_at=clock_timestamp(), acknowledged_by=p_actor, updated_at=clock_timestamp()
  WHERE id=p_alert AND state='OPEN' RETURNING * INTO row;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('id',row.id,'state',row.state,'acknowledgedBy',row.acknowledged_by);
END $$;

CREATE FUNCTION freehold._incident_event(p_incident uuid, p_actor uuid, p_type text, p_body text, p_metadata jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
  INSERT INTO freehold.operational_incident_events(incident_id,actor_id,event_type,body,metadata)
  VALUES (p_incident,p_actor,p_type,p_body,COALESCE(p_metadata,'{}'::jsonb));
END $$;

CREATE FUNCTION freehold.incident_open(p_actor uuid, p_severity text, p_title text, p_summary text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE id uuid;
BEGIN
  PERFORM freehold._ops_actor(p_actor, true);
  IF p_severity NOT IN ('INFORMATIONAL','WARNING','HIGH','CRITICAL') OR p_title IS NULL OR p_summary IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE='22023';
  END IF;
  INSERT INTO freehold.operational_incidents(severity,title,summary,created_by)
  VALUES (p_severity,btrim(p_title),btrim(p_summary),p_actor) RETURNING operational_incidents.id INTO id;
  PERFORM freehold._incident_event(id,p_actor,'CREATED',btrim(p_summary),jsonb_build_object('severity',p_severity,'classification','OPERATIONAL'));
  RETURN jsonb_build_object('incidentId',id,'classification','OPERATIONAL','status','OPEN','severity',p_severity);
END $$;

CREATE FUNCTION freehold.incident_update(p_actor uuid, p_incident uuid, p_action text, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE row freehold.operational_incidents; body text; alert uuid; assignee uuid; ref text;
BEGIN
  PERFORM freehold._ops_actor(p_actor, true);
  IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE='22023'; END IF;
  SELECT * INTO row FROM freehold.operational_incidents WHERE id=p_incident FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE='22023'; END IF;
  IF row.status='CLOSED' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE='22023'; END IF;
  body := NULLIF(btrim(p_payload->>'body'),'');
  IF p_action='NOTE' THEN
    IF body IS NULL THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE='22023'; END IF;
    PERFORM freehold._incident_event(row.id,p_actor,'NOTE',body,'{}'::jsonb);
  ELSIF p_action='EVIDENCE' THEN
    ref := NULLIF(btrim(p_payload->>'evidenceRef'),'');
    IF ref IS NULL OR length(ref)>500 THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE='22023'; END IF;
    PERFORM freehold._incident_event(row.id,p_actor,'EVIDENCE',body,jsonb_build_object('evidenceRef',ref));
  ELSIF p_action='LINK_ALERT' THEN
    alert := NULLIF(p_payload->>'alertId','')::uuid;
    INSERT INTO freehold.operational_incident_alerts(incident_id,alert_id,linked_by) VALUES (row.id,alert,p_actor);
    PERFORM freehold._incident_event(row.id,p_actor,'LINK_ALERT',body,jsonb_build_object('alertId',alert));
  ELSIF p_action='LINK_OPERATION' THEN
    ref := NULLIF(btrim(p_payload->>'operationRef'),'');
    IF ref IS NULL THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE='22023'; END IF;
    INSERT INTO freehold.operational_incident_operations(incident_id,operation_ref,linked_by) VALUES (row.id,ref,p_actor);
    PERFORM freehold._incident_event(row.id,p_actor,'LINK_OPERATION',body,jsonb_build_object('operationRef',ref));
  ELSIF p_action='ASSIGN' THEN
    assignee := NULLIF(p_payload->>'assigneeId','')::uuid;
    IF NOT EXISTS(SELECT 1 FROM freehold.users WHERE id=assignee AND status='ACTIVE') THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE='22023'; END IF;
    UPDATE freehold.operational_incidents SET assignee_id=assignee, updated_at=clock_timestamp() WHERE id=row.id;
    PERFORM freehold._incident_event(row.id,p_actor,'ASSIGN',body,jsonb_build_object('assigneeId',assignee));
  ELSIF p_action='ESCALATE' THEN
    IF body IS NULL THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE='22023'; END IF;
    UPDATE freehold.operational_incidents SET status='ESCALATED', updated_at=clock_timestamp() WHERE id=row.id;
    PERFORM freehold._incident_event(row.id,p_actor,'ESCALATE',body,'{}'::jsonb);
  ELSIF p_action='CONTAIN' THEN
    IF body IS NULL THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE='22023'; END IF;
    UPDATE freehold.operational_incidents SET status='CONTAINED', containment=body, updated_at=clock_timestamp() WHERE id=row.id;
    PERFORM freehold._incident_event(row.id,p_actor,'CONTAIN',body,'{}'::jsonb);
  ELSIF p_action='RESOLVE' THEN
    IF body IS NULL OR row.status='RESOLVED' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE='22023'; END IF;
    UPDATE freehold.operational_incidents SET status='RESOLVED', resolution=body, updated_at=clock_timestamp() WHERE id=row.id;
    PERFORM freehold._incident_event(row.id,p_actor,'RESOLVE',body,'{}'::jsonb);
  ELSIF p_action='CLOSE' THEN
    IF body IS NULL OR row.status<>'RESOLVED' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE='22023'; END IF;
    UPDATE freehold.operational_incidents SET status='CLOSED', closed_at=clock_timestamp(), updated_at=clock_timestamp() WHERE id=row.id;
    PERFORM freehold._incident_event(row.id,p_actor,'CLOSE',body,'{}'::jsonb);
  ELSE
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE='22023';
  END IF;
  RETURN freehold.incident_get(p_actor, row.id);
END $$;

CREATE FUNCTION freehold.incident_list(p_actor uuid, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE lim integer := least(GREATEST(COALESCE(p_limit,50),1),100);
BEGIN
  PERFORM freehold._ops_actor(p_actor, false);
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'incidentId',i.id,'classification',i.classification,'severity',i.severity,'status',i.status,'title',i.title,
    'assigneeId',i.assignee_id,'createdBy',i.created_by,'createdAt',freehold._ts_utc(i.created_at),'updatedAt',freehold._ts_utc(i.updated_at)
  ) ORDER BY i.created_at DESC, i.id) FROM (
    SELECT * FROM freehold.operational_incidents ORDER BY created_at DESC, id LIMIT lim) i),'[]'::jsonb);
END $$;

CREATE FUNCTION freehold.incident_get(p_actor uuid, p_incident uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE row freehold.operational_incidents;
BEGIN
  PERFORM freehold._ops_actor(p_actor, false);
  SELECT * INTO row FROM freehold.operational_incidents WHERE id=p_incident;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object(
    'incidentId',row.id,'classification',row.classification,'severity',row.severity,'status',row.status,
    'title',row.title,'summary',row.summary,'assigneeId',row.assignee_id,'containment',row.containment,
    'resolution',row.resolution,'createdBy',row.created_by,'createdAt',freehold._ts_utc(row.created_at),
    'updatedAt',freehold._ts_utc(row.updated_at),'closedAt',freehold._ts_utc(row.closed_at),
    'alerts',COALESCE((SELECT jsonb_agg(alert_id) FROM freehold.operational_incident_alerts WHERE incident_id=row.id),'[]'::jsonb),
    'operations',COALESCE((SELECT jsonb_agg(operation_ref) FROM freehold.operational_incident_operations WHERE incident_id=row.id),'[]'::jsonb),
    'events',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'eventType',e.event_type,'actorId',e.actor_id,'body',e.body,'metadata',e.metadata,'recordedAt',freehold._ts_utc(e.recorded_at)) ORDER BY e.id)
      FROM freehold.operational_incident_events e WHERE e.incident_id=row.id),'[]'::jsonb));
END $$;

REVOKE ALL ON TABLE freehold.operational_alerts, freehold.operational_incidents, freehold.operational_incident_alerts,
  freehold.operational_incident_operations, freehold.operational_incident_events
  FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier,freehold_auth,freehold_scheduler,freehold_backup;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA freehold FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier,freehold_auth,freehold_scheduler,freehold_backup;
REVOKE ALL ON FUNCTION
  freehold._ops_actor(uuid,boolean),
  freehold._alert_raise(text,text,text,text,jsonb,jsonb),
  freehold._alert_clear(text),
  freehold._incident_event(uuid,uuid,text,text,jsonb),
  freehold.monitor_evaluate(uuid),
  freehold.alert_list(uuid,integer),
  freehold.alert_acknowledge(uuid,uuid),
  freehold.incident_open(uuid,text,text,text),
  freehold.incident_update(uuid,uuid,text,jsonb),
  freehold.incident_list(uuid,integer),
  freehold.incident_get(uuid,uuid)
  FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier,freehold_auth,freehold_scheduler,freehold_backup;
GRANT EXECUTE ON FUNCTION
  freehold.monitor_evaluate(uuid),
  freehold.alert_list(uuid,integer),
  freehold.alert_acknowledge(uuid,uuid),
  freehold.incident_open(uuid,text,text,text),
  freehold.incident_update(uuid,uuid,text,jsonb),
  freehold.incident_list(uuid,integer),
  freehold.incident_get(uuid,uuid)
  TO freehold_api;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA freehold FROM PUBLIC;
RESET ROLE;
COMMIT;
