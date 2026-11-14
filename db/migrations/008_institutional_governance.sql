-- Institutional governance, dual control, and durable financial-write suspension.
-- Capability assignment is deployment controlled; ADMIN is not a capability.
BEGIN;
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;

CREATE TABLE freehold.governance_capabilities (
 principal_id uuid NOT NULL REFERENCES freehold.users(id),
 capability text NOT NULL CHECK (capability IN ('ACCOUNT_ADMIN','FINANCIAL_REVIEWER','SECURITY_ADMIN','AUDITOR','INSTITUTION_ADMIN','EMERGENCY_CONTROL')),
 granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 granted_by text NOT NULL,
 revoked_at timestamptz,
 revoked_by text,
 PRIMARY KEY(principal_id,capability),
 CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE TABLE freehold.governance_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_key text NOT NULL CHECK (length(btrim(request_key)) BETWEEN 1 AND 200),
 initiator_id uuid NOT NULL REFERENCES freehold.users(id),
 operation text NOT NULL CHECK(operation IN ('FREEZE_ACCOUNT','UNFREEZE_ACCOUNT','RESUME_WRITES')),
 parameters jsonb NOT NULL CHECK(jsonb_typeof(parameters)='object'),
 payload_hash bytea NOT NULL CHECK(octet_length(payload_hash)=32),
 justification text NOT NULL CHECK(length(btrim(justification)) BETWEEN 1 AND 1000),
 required_capability text NOT NULL CHECK(required_capability IN ('FINANCIAL_REVIEWER','INSTITUTION_ADMIN')),
 status text NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED','CANCELLED','EXPIRED','EXECUTED','FAILED')) DEFAULT 'PENDING',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '24 hours'),
 decided_at timestamptz,
 executed_at timestamptz,
 executor_id uuid REFERENCES freehold.users(id),
 result jsonb,
 operation_id uuid UNIQUE REFERENCES freehold.idempotency_requests(operation_id),
 UNIQUE(initiator_id,request_key),
 CHECK(expires_at>created_at),
 CHECK((status NOT IN ('EXECUTED','FAILED')) OR (executed_at IS NOT NULL AND executor_id IS NOT NULL AND result IS NOT NULL))
);
CREATE TABLE freehold.governance_decisions (
 request_id uuid NOT NULL REFERENCES freehold.governance_requests(id),
 principal_id uuid NOT NULL REFERENCES freehold.users(id),
 capability text NOT NULL CHECK(capability IN ('FINANCIAL_REVIEWER','INSTITUTION_ADMIN')),
 decision text NOT NULL CHECK(decision IN ('APPROVE','REJECT')),
 decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(request_id,principal_id)
);
CREATE TABLE freehold.governance_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 request_id uuid REFERENCES freehold.governance_requests(id),
 event_type text NOT NULL CHECK(event_type IN ('REQUESTED','APPROVED','REJECTED','CANCELLED','EXPIRED','EXECUTION_ATTEMPT','EXECUTED','EXECUTION_FAILED','EMERGENCY_SUSPEND','POLICY_CHANGE','AUTHORIZATION_FAILURE')),
 requesting_principal uuid REFERENCES freehold.users(id),
 approving_principal uuid REFERENCES freehold.users(id),
 executing_principal uuid REFERENCES freehold.users(id),
 executing_service text,
 affected_resource uuid,
 outcome text NOT NULL,
 reason text,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(metadata)='object'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE freehold.institutional_control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 writes_suspended boolean NOT NULL DEFAULT false,
 suspension_reason text,
 suspended_by uuid REFERENCES freehold.users(id),
 suspended_at timestamptz,
 resumed_at timestamptz,
 CHECK((NOT writes_suspended) OR (suspension_reason IS NOT NULL AND suspended_by IS NOT NULL AND suspended_at IS NOT NULL))
);
INSERT INTO freehold.institutional_control(singleton) VALUES(true);
COMMENT ON TABLE freehold.governance_capabilities IS 'Deployment provisioned, individually scoped institutional permissions. ADMIN role grants no capability by itself.';
COMMENT ON TABLE freehold.governance_requests IS 'Durable immutable governance payloads. Mutable columns are limited to one-way lifecycle transitions through SECURITY DEFINER functions.';
COMMENT ON TABLE freehold.governance_audit IS 'Database-resident append-only evidence; database owners and infrastructure administrators remain within the trust boundary.';

CREATE FUNCTION freehold._has_governance_capability(p_actor uuid,p_capability text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM freehold.users u JOIN freehold.governance_capabilities c ON c.principal_id=u.id
   WHERE u.id=p_actor AND u.status='ACTIVE' AND u.role='ADMIN' AND c.capability=p_capability AND c.revoked_at IS NULL)
$$;

CREATE FUNCTION freehold._governance_audit(p_request uuid,p_event text,p_actor uuid,p_resource uuid,p_outcome text,p_reason text DEFAULT NULL,p_metadata jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
 INSERT INTO freehold.governance_audit(request_id,event_type,requesting_principal,approving_principal,executing_principal,executing_service,affected_resource,outcome,reason,metadata)
 SELECT p_request,p_event,r.initiator_id,CASE WHEN p_event IN ('APPROVED','REJECTED') THEN p_actor END,
   CASE WHEN p_event IN ('EXECUTION_ATTEMPT','EXECUTED','EXECUTION_FAILED') THEN p_actor END,
   CASE WHEN p_event IN ('EXECUTION_ATTEMPT','EXECUTED','EXECUTION_FAILED') THEN 'freehold_api' END,
   p_resource,p_outcome,p_reason,COALESCE(p_metadata,'{}'::jsonb)
 FROM (SELECT p_request AS id) x LEFT JOIN freehold.governance_requests r ON r.id=x.id
$$;

CREATE FUNCTION freehold.governance_create_account_request(p_actor uuid,p_account uuid,p_frozen boolean,p_reason text,p_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
DECLARE op text; params jsonb; digest bytea; existing freehold.governance_requests; req freehold.governance_requests;
BEGIN
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

CREATE FUNCTION freehold.governance_create_resume_request(p_actor uuid,p_reason text,p_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE req freehold.governance_requests;
BEGIN
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

CREATE FUNCTION freehold.governance_decide(p_actor uuid,p_request uuid,p_decision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
DECLARE req freehold.governance_requests; cap text;
BEGIN
 SELECT * INTO req FROM freehold.governance_requests WHERE id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'GOVERNANCE_REQUEST_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF p_actor=req.initiator_id THEN RAISE EXCEPTION 'GOVERNANCE_SELF_APPROVAL' USING ERRCODE='42501'; END IF;
 cap:=req.required_capability;
 IF NOT freehold._has_governance_capability(p_actor,cap) THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_decision NOT IN ('APPROVE','REJECT') THEN RAISE EXCEPTION 'INVALID_GOVERNANCE_DECISION' USING ERRCODE='22023'; END IF;
 IF req.status IN ('PENDING','APPROVED') AND req.expires_at<=clock_timestamp() THEN
   UPDATE freehold.governance_requests SET status='EXPIRED',decided_at=clock_timestamp() WHERE id=p_request;
   PERFORM freehold._governance_audit(p_request,'EXPIRED',NULL,NULL,'EXPIRED',NULL,'{}');
   RETURN jsonb_build_object('requestId',p_request,'status','EXPIRED');
 END IF;
 IF req.status<>'PENDING' THEN RAISE EXCEPTION 'GOVERNANCE_REQUEST_TERMINAL' USING ERRCODE='55000'; END IF;
 INSERT INTO freehold.governance_decisions(request_id,principal_id,capability,decision) VALUES(p_request,p_actor,cap,p_decision);
 IF p_decision='REJECT' THEN UPDATE freehold.governance_requests SET status='REJECTED',decided_at=clock_timestamp() WHERE id=p_request;
 ELSE UPDATE freehold.governance_requests SET status='APPROVED',decided_at=clock_timestamp() WHERE id=p_request AND status='PENDING'; END IF;
 PERFORM freehold._governance_audit(p_request,CASE WHEN p_decision='APPROVE' THEN 'APPROVED' ELSE 'REJECTED' END,p_actor,
   CASE WHEN req.operation IN ('FREEZE_ACCOUNT','UNFREEZE_ACCOUNT') THEN (req.parameters->>'accountId')::uuid END,p_decision,req.justification,'{}');
 RETURN jsonb_build_object('requestId',p_request,'status',CASE WHEN p_decision='APPROVE' THEN 'APPROVED' ELSE 'REJECTED' END);
END $$;

CREATE FUNCTION freehold.governance_cancel(p_actor uuid,p_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE req freehold.governance_requests;
BEGIN
 SELECT * INTO req FROM freehold.governance_requests WHERE id=p_request FOR UPDATE;
 IF NOT FOUND OR req.initiator_id<>p_actor THEN RAISE EXCEPTION 'GOVERNANCE_REQUEST_NOT_FOUND' USING ERRCODE='42501'; END IF;
 IF req.status<>'PENDING' THEN RAISE EXCEPTION 'GOVERNANCE_REQUEST_TERMINAL' USING ERRCODE='55000'; END IF;
 UPDATE freehold.governance_requests SET status='CANCELLED',decided_at=clock_timestamp() WHERE id=p_request;
 PERFORM freehold._governance_audit(p_request,'CANCELLED',p_actor,NULL,'CANCELLED',req.justification,'{}');
 RETURN jsonb_build_object('requestId',p_request,'status','CANCELLED');
END $$;

CREATE FUNCTION freehold.governance_execute(p_actor uuid,p_request uuid,p_key text,p_correlation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
DECLARE req freehold.governance_requests; dec freehold.governance_decisions; op jsonb; frozen boolean; account uuid;
BEGIN
 SELECT * INTO req FROM freehold.governance_requests WHERE id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'GOVERNANCE_REQUEST_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF NOT freehold._has_governance_capability(p_actor,CASE WHEN req.operation='RESUME_WRITES' THEN 'INSTITUTION_ADMIN' ELSE 'ACCOUNT_ADMIN' END)
   THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 IF req.status IN ('APPROVED','EXECUTED','FAILED') AND
   (NOT freehold._has_governance_capability(req.initiator_id,CASE WHEN req.operation='RESUME_WRITES' THEN 'EMERGENCY_CONTROL' ELSE 'ACCOUNT_ADMIN' END)
    OR NOT EXISTS(SELECT 1 FROM freehold.governance_decisions d WHERE d.request_id=p_request AND d.decision='APPROVE'
      AND d.capability=req.required_capability AND d.principal_id<>req.initiator_id AND freehold._has_governance_capability(d.principal_id,d.capability)))
   THEN RAISE EXCEPTION 'GOVERNANCE_AUTHORIZATION_REVOKED' USING ERRCODE='42501'; END IF;
 IF req.status IN ('EXECUTED','FAILED') THEN RETURN req.result; END IF;
 IF req.status='PENDING' AND req.expires_at<=clock_timestamp() THEN
   UPDATE freehold.governance_requests SET status='EXPIRED',decided_at=clock_timestamp() WHERE id=p_request;
   PERFORM freehold._governance_audit(p_request,'EXPIRED',NULL,NULL,'EXPIRED',NULL,'{}');
   RETURN jsonb_build_object('requestId',p_request,'status','EXPIRED');
 END IF;
 IF req.status<>'APPROVED' THEN RAISE EXCEPTION 'GOVERNANCE_NOT_APPROVED' USING ERRCODE='55000'; END IF;
 IF NOT freehold._has_governance_capability(req.initiator_id,CASE WHEN req.operation='RESUME_WRITES' THEN 'EMERGENCY_CONTROL' ELSE 'ACCOUNT_ADMIN' END)
 OR NOT EXISTS(SELECT 1 FROM freehold.governance_decisions d WHERE d.request_id=p_request AND d.decision='APPROVE'
   AND d.capability=req.required_capability AND d.principal_id<>req.initiator_id AND freehold._has_governance_capability(d.principal_id,d.capability))
 THEN RAISE EXCEPTION 'GOVERNANCE_AUTHORIZATION_REVOKED' USING ERRCODE='42501'; END IF;
 IF req.expires_at<=clock_timestamp() THEN
   UPDATE freehold.governance_requests SET status='EXPIRED',decided_at=clock_timestamp() WHERE id=p_request;
   PERFORM freehold._governance_audit(p_request,'EXPIRED',NULL,NULL,'EXPIRED',NULL,'{}');
   RETURN jsonb_build_object('requestId',p_request,'status','EXPIRED');
 END IF;
 PERFORM freehold._governance_audit(p_request,'EXECUTION_ATTEMPT',p_actor,NULL,'ATTEMPT',req.justification,'{}');
 IF req.operation IN ('FREEZE_ACCOUNT','UNFREEZE_ACCOUNT') THEN
   account:=(req.parameters->>'accountId')::uuid; frozen:=(req.parameters->>'frozen')::boolean;
   op:=freehold.set_account_frozen(req.initiator_id,account,frozen,p_key,req.justification,p_correlation);
 ELSE
   UPDATE freehold.institutional_control SET writes_suspended=false,resumed_at=clock_timestamp(),suspension_reason=NULL,suspended_by=NULL,suspended_at=NULL WHERE singleton AND writes_suspended;
   op:=jsonb_build_object('status','COMPLETED','writesSuspended',false);
 END IF;
 UPDATE freehold.governance_requests SET status=CASE WHEN op->>'state'='REJECTED' THEN 'FAILED' ELSE 'EXECUTED' END,
   executed_at=clock_timestamp(),executor_id=p_actor,result=jsonb_build_object('requestId',p_request,'operation',req.operation,'status',CASE WHEN op->>'state'='REJECTED' THEN 'FAILED' ELSE 'EXECUTED' END,'result',op),
   operation_id=CASE WHEN op ? 'operationId' THEN (op->>'operationId')::uuid END
 WHERE id=p_request RETURNING * INTO req;
 PERFORM freehold._governance_audit(p_request,CASE WHEN req.status='FAILED' THEN 'EXECUTION_FAILED' ELSE 'EXECUTED' END,p_actor,account,req.status,req.justification,'{}');
 RETURN req.result;
END $$;

CREATE FUNCTION freehold.governance_suspend_writes(p_actor uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
BEGIN
 IF NOT freehold._has_governance_capability(p_actor,'EMERGENCY_CONTROL') THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'EMERGENCY_REASON_REQUIRED' USING ERRCODE='22023'; END IF;
 UPDATE freehold.institutional_control SET writes_suspended=true,suspension_reason=p_reason,suspended_by=p_actor,suspended_at=clock_timestamp(),resumed_at=NULL WHERE singleton;
 INSERT INTO freehold.governance_audit(event_type,requesting_principal,executing_service,outcome,reason,metadata)
 VALUES('EMERGENCY_SUSPEND',p_actor,'freehold_api','SUSPENDED',p_reason,'{}');
 RETURN freehold.governance_status(p_actor);
END $$;

CREATE FUNCTION freehold.governance_status(p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE ctl freehold.institutional_control;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM freehold.governance_capabilities c JOIN freehold.users u ON u.id=c.principal_id WHERE c.principal_id=p_actor AND c.revoked_at IS NULL AND u.status='ACTIVE' AND u.role='ADMIN') THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT * INTO ctl FROM freehold.institutional_control WHERE singleton;
 RETURN jsonb_build_object('writesSuspended',ctl.writes_suspended,'reason',ctl.suspension_reason,'suspendedAt',ctl.suspended_at,'resumedAt',ctl.resumed_at);
END $$;

CREATE FUNCTION freehold.governance_provision_capability(p_principal uuid,p_capability text,p_grantor text,p_enable boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 IF p_capability NOT IN ('ACCOUNT_ADMIN','FINANCIAL_REVIEWER','SECURITY_ADMIN','AUDITOR','INSTITUTION_ADMIN','EMERGENCY_CONTROL')
    OR p_grantor IS NULL OR length(btrim(p_grantor)) NOT BETWEEN 1 AND 200
    OR NOT EXISTS(SELECT 1 FROM freehold.users WHERE id=p_principal AND role='ADMIN' AND status='ACTIVE')
 THEN RAISE EXCEPTION 'INVALID_GOVERNANCE_PROVISIONING' USING ERRCODE='22023'; END IF;
 IF p_enable THEN
   INSERT INTO freehold.governance_capabilities(principal_id,capability,granted_by) VALUES(p_principal,p_capability,p_grantor)
   ON CONFLICT(principal_id,capability) DO UPDATE SET granted_at=clock_timestamp(),granted_by=EXCLUDED.granted_by,revoked_at=NULL,revoked_by=NULL;
 ELSE
   UPDATE freehold.governance_capabilities SET revoked_at=clock_timestamp(),revoked_by=p_grantor
   WHERE principal_id=p_principal AND capability=p_capability AND revoked_at IS NULL;
 END IF;
 INSERT INTO freehold.governance_audit(event_type,executing_service,affected_resource,outcome,reason,metadata)
 VALUES('POLICY_CHANGE','deployment_migration',p_principal,CASE WHEN p_enable THEN 'CAPABILITY_GRANTED' ELSE 'CAPABILITY_REVOKED' END,
   p_grantor,jsonb_build_object('capability',p_capability));
END $$;

CREATE FUNCTION freehold.governance_record_authorization_failure(p_actor uuid,p_action text,p_resource uuid,p_failure_code text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 IF p_action NOT IN ('ADMIN_ROUTE','ACCOUNT_READ','RECONCILIATION_READ','AUDIT_READ','REQUEST','APPROVE','REJECT','EXECUTE','CANCEL','SUSPEND','RESUME')
    OR p_failure_code NOT IN ('ROLE_OR_RECENT_TOTP_REQUIRED','CAPABILITY_REQUIRED','SELF_APPROVAL','AUTHORIZATION_REVOKED')
 THEN RAISE EXCEPTION 'INVALID_AUTHORIZATION_AUDIT' USING ERRCODE='22023'; END IF;
 INSERT INTO freehold.governance_audit(event_type,requesting_principal,affected_resource,outcome,metadata)
 VALUES('AUTHORIZATION_FAILURE',p_actor,p_resource,'DENIED',jsonb_build_object('action',p_action,'failureCode',p_failure_code));
END $$;

CREATE FUNCTION freehold.governance_record_execution_failure(p_actor uuid,p_request uuid,p_failure_code text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE req freehold.governance_requests;
BEGIN
 SELECT * INTO req FROM freehold.governance_requests WHERE id=p_request;
 IF NOT FOUND OR req.status IN ('EXECUTED','FAILED') THEN RETURN; END IF;
 IF p_failure_code NOT IN ('AUTHORIZATION_REVOKED','NOT_APPROVED','EXPIRED','DATABASE_FAILURE') THEN RAISE EXCEPTION 'INVALID_EXECUTION_AUDIT' USING ERRCODE='22023'; END IF;
 INSERT INTO freehold.governance_audit(request_id,event_type,requesting_principal,executing_principal,executing_service,affected_resource,outcome,metadata)
 VALUES(p_request,'EXECUTION_FAILED',req.initiator_id,p_actor,'freehold_api',CASE WHEN req.parameters ? 'accountId' THEN (req.parameters->>'accountId')::uuid END,p_failure_code,
   jsonb_build_object('operation',req.operation));
END $$;

CREATE FUNCTION freehold.governance_overview(p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM freehold.governance_capabilities c JOIN freehold.users u ON u.id=c.principal_id WHERE c.principal_id=p_actor AND c.revoked_at IS NULL AND u.status='ACTIVE' AND u.role='ADMIN') THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 WITH expired AS (UPDATE freehold.governance_requests SET status='EXPIRED',decided_at=clock_timestamp()
   WHERE status IN ('PENDING','APPROVED') AND expires_at<=clock_timestamp() RETURNING id)
 INSERT INTO freehold.governance_audit(request_id,event_type,outcome,metadata)
 SELECT id,'EXPIRED','EXPIRED','{}'::jsonb FROM expired;
 RETURN jsonb_build_object('status',freehold.governance_status(p_actor),
   'capabilities',(SELECT COALESCE(jsonb_agg(capability ORDER BY capability),'[]'::jsonb) FROM freehold.governance_capabilities WHERE principal_id=p_actor AND revoked_at IS NULL),
   'requests',(SELECT COALESCE(jsonb_agg(jsonb_build_object('requestId',r.id,'operation',r.operation,'parameters',r.parameters,'justification',r.justification,'status',r.status,'expiresAt',r.expires_at,'initiatorId',r.initiator_id,'approvals',(SELECT COALESCE(jsonb_agg(jsonb_build_object('principalId',d.principal_id,'decision',d.decision,'decidedAt',d.decided_at)),'[]'::jsonb) FROM freehold.governance_decisions d WHERE d.request_id=r.id)) ORDER BY r.created_at DESC),'[]'::jsonb) FROM (SELECT * FROM freehold.governance_requests ORDER BY created_at DESC LIMIT 50) r),
   'audit',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',a.id,'requestId',a.request_id,'eventType',a.event_type,'requestingPrincipal',a.requesting_principal,'approvingPrincipal',a.approving_principal,'executingPrincipal',a.executing_principal,'executingService',a.executing_service,'affectedResource',a.affected_resource,'outcome',a.outcome,'reason',a.reason,'recordedAt',a.recorded_at) ORDER BY a.id DESC),'[]'::jsonb) FROM (SELECT * FROM freehold.governance_audit ORDER BY id DESC LIMIT 100) a),
   'monetaryAuthority',jsonb_build_object('issuanceEnabled',false,'externalBackingVerified',false,'sandboxFundingOnly',true));
END $$;

CREATE FUNCTION freehold.governance_admin_list_accounts(p_actor uuid,p_query text,p_limit integer)
RETURNS TABLE(id uuid,"ownerEmail" text,currency text,status text,"availableMinor" text,"reservedMinor" text,"totalMinor" text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 IF NOT freehold._has_governance_capability(p_actor,'ACCOUNT_ADMIN') THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT * FROM freehold.admin_list_accounts(p_actor,p_query,p_limit);
END $$;
CREATE FUNCTION freehold.governance_read_reconciliation(p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 IF NOT (freehold._has_governance_capability(p_actor,'AUDITOR') OR freehold._has_governance_capability(p_actor,'SECURITY_ADMIN') OR freehold._has_governance_capability(p_actor,'FINANCIAL_REVIEWER')) THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 RETURN freehold.admin_latest_reconciliation();
END $$;
CREATE FUNCTION freehold.governance_read_audit(p_actor uuid,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 IF NOT (freehold._has_governance_capability(p_actor,'AUDITOR') OR freehold._has_governance_capability(p_actor,'SECURITY_ADMIN') OR freehold._has_governance_capability(p_actor,'FINANCIAL_REVIEWER') OR freehold._has_governance_capability(p_actor,'ACCOUNT_ADMIN')) THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 RETURN freehold.admin_audit_events(p_limit);
END $$;

CREATE FUNCTION freehold._governance_guard_idempotency()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM freehold.idempotency_requests x WHERE x.actor_id=NEW.actor_id AND x.operation=NEW.operation AND x.key=NEW.key) THEN RETURN NEW; END IF;
 PERFORM 1 FROM freehold.institutional_control WHERE singleton FOR SHARE;
 IF EXISTS(SELECT 1 FROM freehold.institutional_control WHERE singleton AND writes_suspended) THEN RAISE EXCEPTION 'FINANCIAL_WRITES_SUSPENDED' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER governance_financial_write_gate BEFORE INSERT ON freehold.idempotency_requests FOR EACH ROW EXECUTE FUNCTION freehold._governance_guard_idempotency();

CREATE FUNCTION freehold._governance_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN RAISE EXCEPTION 'GOVERNANCE_EVIDENCE_IMMUTABLE' USING ERRCODE='55000'; END $$;
CREATE TRIGGER governance_decisions_immutable BEFORE UPDATE OR DELETE ON freehold.governance_decisions FOR EACH ROW EXECUTE FUNCTION freehold._governance_immutable();
CREATE TRIGGER governance_audit_immutable BEFORE UPDATE OR DELETE ON freehold.governance_audit FOR EACH ROW EXECUTE FUNCTION freehold._governance_immutable();
CREATE FUNCTION freehold._governance_request_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 IF ROW(NEW.request_key,NEW.initiator_id,NEW.operation,NEW.parameters,NEW.payload_hash,NEW.justification,NEW.required_capability,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.request_key,OLD.initiator_id,OLD.operation,OLD.parameters,OLD.payload_hash,OLD.justification,OLD.required_capability,OLD.created_at,OLD.expires_at)
 THEN RAISE EXCEPTION 'GOVERNANCE_REQUEST_IMMUTABLE' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER governance_requests_immutable BEFORE UPDATE ON freehold.governance_requests FOR EACH ROW EXECUTE FUNCTION freehold._governance_request_immutable();

REVOKE ALL ON ALL TABLES IN SCHEMA freehold FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier;
-- Restore existing precise grants after schema-wide revocation.
GRANT SELECT ON freehold.currencies,freehold.accounts,freehold.ledger_accounts,freehold.ledger_journals,freehold.ledger_entries,freehold.transfers,freehold.holds,freehold.idempotency_requests TO freehold_api;
GRANT SELECT ON freehold.currencies,freehold.accounts,freehold.ledger_accounts,freehold.ledger_journals,freehold.ledger_entries,freehold.journal_seals,freehold.idempotency_requests,freehold.transfers,freehold.holds,freehold.outbox_events,freehold.worker_inbox TO freehold_verifier;
GRANT SELECT(id) ON freehold.users TO freehold_verifier;
GRANT SELECT(operation_id,actor_user_id,action_type,target_id,correlation_id) ON freehold.admin_actions TO freehold_verifier;
GRANT SELECT(id,event_type,resource_id,operation_id,outcome,correlation_id,actor_id) ON freehold.audit_log TO freehold_verifier;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA freehold FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier;
-- Existing runtime grants are restored explicitly below, preserving role separation.
GRANT EXECUTE ON FUNCTION freehold.auth_find_credentials(text),freehold.auth_get_user(uuid),freehold.auth_lock_user(uuid),freehold.register_user(text,text,bytea),freehold.demo_bootstrap_admin(text,text,text,bytea),freehold.auth_user_email(uuid),freehold.execute_internal_transfer(uuid,uuid,uuid,text,bigint,text,uuid),freehold.reserve_funds(uuid,uuid,bigint,text,text,timestamptz,uuid),freehold.release_hold(uuid,uuid,text,uuid),freehold.sandbox_fund_account(uuid,uuid,bigint,text,text,uuid),freehold.create_account(uuid,text,text,uuid) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.worker_claim_outbox(uuid,integer,integer),freehold.worker_complete_outbox(uuid,uuid),freehold.worker_reconcile_and_record() TO freehold_worker;
GRANT EXECUTE ON FUNCTION freehold.governance_create_account_request(uuid,uuid,boolean,text,text),freehold.governance_create_resume_request(uuid,text,text),freehold.governance_decide(uuid,uuid,text),freehold.governance_cancel(uuid,uuid),freehold.governance_execute(uuid,uuid,text,uuid),freehold.governance_suspend_writes(uuid,text),freehold.governance_status(uuid),freehold.governance_overview(uuid),freehold.governance_admin_list_accounts(uuid,text,integer),freehold.governance_read_reconciliation(uuid),freehold.governance_read_audit(uuid,integer),freehold.governance_record_authorization_failure(uuid,text,uuid,text),freehold.governance_record_execution_failure(uuid,uuid,text) TO freehold_api;
REVOKE ALL ON FUNCTION freehold.admin_list_accounts(uuid,text,integer),freehold.admin_latest_reconciliation(),freehold.admin_audit_events(integer) FROM freehold_api,PUBLIC;
REVOKE ALL ON FUNCTION freehold.governance_provision_capability(uuid,text,text,boolean) FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier;
GRANT EXECUTE ON FUNCTION freehold._has_governance_capability(uuid,text),freehold._governance_audit(uuid,text,uuid,uuid,text,text,jsonb),freehold._governance_guard_idempotency(),freehold._governance_immutable(),freehold._governance_request_immutable() TO freehold_owner;
REVOKE ALL ON FUNCTION freehold.set_account_frozen(uuid,uuid,boolean,text,text,uuid) FROM freehold_api,freehold_worker,PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE freehold_owner IN SCHEMA freehold REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier;
ALTER DEFAULT PRIVILEGES FOR ROLE freehold_owner IN SCHEMA freehold REVOKE ALL ON TABLES FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier;
RESET ROLE;
COMMIT;
