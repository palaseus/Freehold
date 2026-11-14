-- Email lookup and governance-failure audit rows require the bound API session.
-- A freehold_api password alone must not read another user's email or insert
-- those audit rows. Posting behavior is unchanged.
BEGIN;
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;

CREATE OR REPLACE FUNCTION freehold.auth_user_email(p_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
  PERFORM freehold._require_bound_session(p_id);
  RETURN (SELECT email_normalized FROM freehold.users WHERE id=p_id);
END $$;

CREATE OR REPLACE FUNCTION freehold.governance_record_authorization_failure(p_actor uuid,p_action text,p_resource uuid,p_failure_code text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
  PERFORM freehold._require_bound_session(p_actor);
  IF p_action NOT IN ('ADMIN_ROUTE','ACCOUNT_READ','RECONCILIATION_READ','AUDIT_READ','REQUEST','APPROVE','REJECT','EXECUTE','CANCEL','SUSPEND','RESUME')
     OR p_failure_code NOT IN ('ROLE_OR_RECENT_TOTP_REQUIRED','CAPABILITY_REQUIRED','SELF_APPROVAL','AUTHORIZATION_REVOKED')
  THEN RAISE EXCEPTION 'INVALID_AUTHORIZATION_AUDIT' USING ERRCODE='22023'; END IF;
  INSERT INTO freehold.governance_audit(event_type,requesting_principal,affected_resource,outcome,metadata)
  VALUES('AUTHORIZATION_FAILURE',p_actor,p_resource,'DENIED',jsonb_build_object('action',p_action,'failureCode',p_failure_code));
END $$;

CREATE OR REPLACE FUNCTION freehold.governance_record_execution_failure(p_actor uuid,p_request uuid,p_failure_code text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE req freehold.governance_requests;
BEGIN
  PERFORM freehold._require_bound_session(p_actor);
  SELECT * INTO req FROM freehold.governance_requests WHERE id=p_request;
  IF NOT FOUND OR req.status IN ('EXECUTED','FAILED') THEN RETURN; END IF;
  IF p_failure_code NOT IN ('AUTHORIZATION_REVOKED','NOT_APPROVED','EXPIRED','DATABASE_FAILURE') THEN RAISE EXCEPTION 'INVALID_EXECUTION_AUDIT' USING ERRCODE='22023'; END IF;
  INSERT INTO freehold.governance_audit(request_id,event_type,requesting_principal,executing_principal,executing_service,affected_resource,outcome,metadata)
  VALUES(p_request,'EXECUTION_FAILED',req.initiator_id,p_actor,'freehold_api',CASE WHEN req.parameters ? 'accountId' THEN (req.parameters->>'accountId')::uuid END,p_failure_code,
    jsonb_build_object('operation',req.operation));
END $$;

REVOKE ALL ON FUNCTION
  freehold.auth_user_email(uuid),
  freehold.governance_record_authorization_failure(uuid,text,uuid,text),
  freehold.governance_record_execution_failure(uuid,uuid,text)
  FROM PUBLIC,freehold_worker,freehold_verifier,freehold_auth,freehold_scheduler,freehold_backup;
GRANT EXECUTE ON FUNCTION
  freehold.auth_user_email(uuid),
  freehold.governance_record_authorization_failure(uuid,text,uuid,text),
  freehold.governance_record_execution_failure(uuid,uuid,text)
  TO freehold_api;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA freehold FROM PUBLIC;
RESET ROLE;
COMMIT;
