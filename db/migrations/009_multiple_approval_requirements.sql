-- Extend governance to enforce several independent approval requirements.
-- One principal can contribute at most one decision for a request, regardless
-- of how many capabilities that principal holds.
BEGIN;
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path=pg_catalog,freehold,pg_temp;

CREATE TABLE freehold.governance_approval_requirements (
 request_id uuid NOT NULL REFERENCES freehold.governance_requests(id),
 capability text NOT NULL CHECK(capability IN ('FINANCIAL_REVIEWER','INSTITUTION_ADMIN','SECURITY_ADMIN')),
 required_count smallint NOT NULL CHECK(required_count BETWEEN 1 AND 5),
 PRIMARY KEY(request_id,capability)
);
INSERT INTO freehold.governance_approval_requirements(request_id,capability,required_count)
 SELECT id,required_capability,1 FROM freehold.governance_requests;
CREATE FUNCTION freehold._governance_default_requirement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 INSERT INTO freehold.governance_approval_requirements(request_id,capability,required_count)
 VALUES(NEW.id,NEW.required_capability,1);
 RETURN NEW;
END $$;
CREATE TRIGGER governance_default_requirement AFTER INSERT ON freehold.governance_requests
 FOR EACH ROW EXECUTE FUNCTION freehold._governance_default_requirement();
CREATE TRIGGER governance_requirements_immutable BEFORE UPDATE OR DELETE ON freehold.governance_approval_requirements
 FOR EACH ROW EXECUTE FUNCTION freehold._governance_immutable();

CREATE OR REPLACE FUNCTION freehold.governance_overview(p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
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

CREATE OR REPLACE FUNCTION freehold.governance_decide(p_actor uuid,p_request uuid,p_decision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
DECLARE req freehold.governance_requests; cap text; all_approved boolean;
BEGIN
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

CREATE OR REPLACE FUNCTION freehold.governance_cancel(p_actor uuid,p_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE req freehold.governance_requests;
BEGIN
 SELECT * INTO req FROM freehold.governance_requests WHERE id=p_request FOR UPDATE;
 IF NOT FOUND OR req.initiator_id<>p_actor THEN RAISE EXCEPTION 'GOVERNANCE_REQUEST_NOT_FOUND' USING ERRCODE='42501'; END IF;
 IF NOT freehold._has_governance_capability(p_actor,CASE WHEN req.operation='RESUME_WRITES' THEN 'EMERGENCY_CONTROL' ELSE 'ACCOUNT_ADMIN' END)
 THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 IF req.status NOT IN ('PENDING','APPROVED') THEN RAISE EXCEPTION 'GOVERNANCE_REQUEST_TERMINAL' USING ERRCODE='55000'; END IF;
 UPDATE freehold.governance_requests SET status='CANCELLED',decided_at=clock_timestamp() WHERE id=p_request;
 PERFORM freehold._governance_audit(p_request,'CANCELLED',p_actor,NULL,'CANCELLED',req.justification,'{}');
 RETURN jsonb_build_object('requestId',p_request,'status','CANCELLED');
END $$;

CREATE OR REPLACE FUNCTION freehold.governance_execute(p_actor uuid,p_request uuid,p_key text,p_correlation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
DECLARE req freehold.governance_requests; op jsonb; frozen boolean; account uuid;
BEGIN
 SELECT * INTO req FROM freehold.governance_requests WHERE id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'GOVERNANCE_REQUEST_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF NOT freehold._has_governance_capability(p_actor,CASE WHEN req.operation='RESUME_WRITES' THEN 'INSTITUTION_ADMIN' ELSE 'ACCOUNT_ADMIN' END)
   THEN RAISE EXCEPTION 'GOVERNANCE_CAPABILITY_REQUIRED' USING ERRCODE='42501'; END IF;
 IF req.status IN ('APPROVED','EXECUTED','FAILED') AND
   (NOT freehold._has_governance_capability(req.initiator_id,CASE WHEN req.operation='RESUME_WRITES' THEN 'EMERGENCY_CONTROL' ELSE 'ACCOUNT_ADMIN' END)
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

REVOKE ALL ON TABLE freehold.governance_approval_requirements FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier;
REVOKE ALL ON FUNCTION freehold._governance_default_requirement() FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier;
GRANT SELECT(status,role) ON freehold.users TO freehold_verifier;
GRANT SELECT(id,initiator_id,operation,parameters,payload_hash,required_capability,status,created_at,expires_at,decided_at,executed_at,executor_id,result,operation_id)
 ON freehold.governance_requests TO freehold_verifier;
GRANT SELECT(principal_id,capability,granted_at,revoked_at) ON freehold.governance_capabilities TO freehold_verifier;
GRANT SELECT(request_id,principal_id,capability,decision,decided_at) ON freehold.governance_decisions TO freehold_verifier;
GRANT SELECT(request_id,capability,required_count) ON freehold.governance_approval_requirements TO freehold_verifier;
GRANT SELECT(request_id,event_type,requesting_principal,approving_principal,executing_principal,affected_resource,outcome,recorded_at)
 ON freehold.governance_audit TO freehold_verifier;
GRANT SELECT(singleton,writes_suspended,suspended_by,suspended_at,resumed_at) ON freehold.institutional_control TO freehold_verifier;
ALTER DEFAULT PRIVILEGES FOR ROLE freehold_owner IN SCHEMA freehold REVOKE ALL ON TABLES FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier;
ALTER DEFAULT PRIVILEGES FOR ROLE freehold_owner IN SCHEMA freehold REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier;
RESET ROLE;
COMMIT;
