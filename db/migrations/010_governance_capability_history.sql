-- Preserve each capability grant/revocation interval for independent review.
BEGIN;
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path=pg_catalog,freehold,pg_temp;

CREATE TABLE freehold.governance_capability_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 principal_id uuid NOT NULL REFERENCES freehold.users(id),
 capability text NOT NULL CHECK(capability IN ('ACCOUNT_ADMIN','FINANCIAL_REVIEWER','SECURITY_ADMIN','AUDITOR','INSTITUTION_ADMIN','EMERGENCY_CONTROL')),
 event text NOT NULL CHECK(event IN ('GRANT','REVOKE')),
 changed_at timestamptz NOT NULL,
 grantor_reference text NOT NULL CHECK(length(btrim(grantor_reference)) BETWEEN 1 AND 200)
);
INSERT INTO freehold.governance_capability_history(principal_id,capability,event,changed_at,grantor_reference)
 SELECT principal_id,capability,'GRANT',granted_at,granted_by FROM freehold.governance_capabilities
 UNION ALL
 SELECT principal_id,capability,'REVOKE',revoked_at,revoked_by FROM freehold.governance_capabilities WHERE revoked_at IS NOT NULL;
CREATE INDEX governance_capability_history_lookup_idx ON freehold.governance_capability_history(principal_id,capability,changed_at,id);
CREATE TRIGGER governance_capability_history_immutable BEFORE UPDATE OR DELETE ON freehold.governance_capability_history
 FOR EACH ROW EXECUTE FUNCTION freehold._governance_immutable();

CREATE OR REPLACE FUNCTION freehold.governance_provision_capability(p_principal uuid,p_capability text,p_grantor text,p_enable boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE changed timestamptz:=clock_timestamp(); affected integer;
BEGIN
 IF p_capability NOT IN ('ACCOUNT_ADMIN','FINANCIAL_REVIEWER','SECURITY_ADMIN','AUDITOR','INSTITUTION_ADMIN','EMERGENCY_CONTROL')
    OR p_grantor IS NULL OR length(btrim(p_grantor)) NOT BETWEEN 1 AND 200
    OR NOT EXISTS(SELECT 1 FROM freehold.users WHERE id=p_principal AND role='ADMIN' AND status='ACTIVE')
 THEN RAISE EXCEPTION 'INVALID_GOVERNANCE_PROVISIONING' USING ERRCODE='22023'; END IF;
 IF p_enable THEN
   INSERT INTO freehold.governance_capabilities(principal_id,capability,granted_at,granted_by) VALUES(p_principal,p_capability,changed,p_grantor)
   ON CONFLICT(principal_id,capability) DO UPDATE SET granted_at=EXCLUDED.granted_at,granted_by=EXCLUDED.granted_by,revoked_at=NULL,revoked_by=NULL;
   INSERT INTO freehold.governance_capability_history(principal_id,capability,event,changed_at,grantor_reference)
   VALUES(p_principal,p_capability,'GRANT',changed,p_grantor);
 ELSE
   UPDATE freehold.governance_capabilities SET revoked_at=changed,revoked_by=p_grantor
   WHERE principal_id=p_principal AND capability=p_capability AND revoked_at IS NULL;
   GET DIAGNOSTICS affected=ROW_COUNT;
   IF affected>0 THEN
     INSERT INTO freehold.governance_capability_history(principal_id,capability,event,changed_at,grantor_reference)
     VALUES(p_principal,p_capability,'REVOKE',changed,p_grantor);
   END IF;
 END IF;
 INSERT INTO freehold.governance_audit(event_type,executing_service,affected_resource,outcome,reason,metadata)
 VALUES('POLICY_CHANGE','deployment_migration',p_principal,CASE WHEN p_enable THEN 'CAPABILITY_GRANTED' ELSE 'CAPABILITY_REVOKED' END,
   p_grantor,jsonb_build_object('capability',p_capability));
END $$;

REVOKE ALL ON TABLE freehold.governance_capability_history FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier;
GRANT SELECT(id,principal_id,capability,event,changed_at) ON freehold.governance_capability_history TO freehold_verifier;
ALTER DEFAULT PRIVILEGES FOR ROLE freehold_owner IN SCHEMA freehold REVOKE ALL ON TABLES FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier;
ALTER DEFAULT PRIVILEGES FOR ROLE freehold_owner IN SCHEMA freehold REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier;
RESET ROLE;
COMMIT;
