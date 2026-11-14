-- Phase 16.2: tenant authorization hardening for institutional credentials.
-- Forward only. Migrations 001 through 027 are not edited.
--
-- The rejected Phase 16.1 draft tried to add caller-settable app.institution_id
-- RLS context to the customer ledger. That draft was never applied canonically
-- and was not a valid security boundary: any caller able to run SET could forge
-- the context, the API role was not a table DML role, and the institutional
-- plane is deliberately isolated by SECURITY DEFINER function boundaries.
--
-- This migration keeps the canonical boundary and closes a real tenant
-- privilege-escalation path: a DEVELOPER has webhooks:write, which is enough to
-- call institution_credential_issue, but must not be able to mint a credential
-- carrying payments:write, transfers:write, governance:write, or any other scope
-- outside the issuer's active capabilities. TENANT_ADMIN remains able to issue
-- the full supported scope set because its capability maps to every scope.
BEGIN;
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;

CREATE OR REPLACE FUNCTION freehold.institution_credential_issue(
  p_actor uuid, p_institution uuid, p_scopes text[], p_ttl integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE
  secret text;
  key_id text;
  cred uuid;
  requested text;
  allowed boolean;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'webhooks:write');
  IF p_ttl < 60 OR p_ttl > 86400 THEN
    RAISE EXCEPTION 'INSTITUTION_CREDENTIAL' USING ERRCODE = '22023';
  END IF;
  IF p_scopes IS NULL OR cardinality(p_scopes) < 1 THEN
    RAISE EXCEPTION 'INSTITUTION_SCOPE' USING ERRCODE = '22023';
  END IF;
  IF NOT (p_scopes <@ ARRAY[
      'accounts:read','accounts:write','transfers:write','payments:write','payments:read',
      'treasury:read','reserves:read','compliance:write','governance:write','webhooks:write',
      'billing:read','reports:read']::text[]) THEN
    RAISE EXCEPTION 'INSTITUTION_SCOPE' USING ERRCODE = '22023';
  END IF;
  -- A credential may only carry authority that at least one of the issuer's
  -- active institutional capabilities can exercise. This prevents a developer
  -- or payments operator from widening a credential beyond their own mandate.
  FOREACH requested IN ARRAY p_scopes LOOP
    SELECT EXISTS (
      SELECT 1
      FROM freehold.institution_members m
      WHERE m.institution_id = p_institution
        AND m.user_id = p_actor
        AND m.revoked_at IS NULL
        AND freehold._institution_scope_ok(m.capability, requested)
    ) INTO allowed;
    IF NOT allowed THEN
      RAISE EXCEPTION 'INSTITUTION_SCOPE' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  secret := encode(public.gen_random_bytes(32), 'hex');
  key_id := 'fh_sandbox_' || encode(public.gen_random_bytes(12), 'hex');
  INSERT INTO freehold.institution_credentials(institution_id, key_id, secret_hash, scopes, expires_at, created_by)
  VALUES (p_institution, key_id, encode(public.digest(secret, 'sha256'), 'hex'),
          p_scopes, clock_timestamp() + make_interval(secs => p_ttl), p_actor)
  RETURNING id INTO cred;
  PERFORM freehold._institution_audit(
    p_institution, p_actor, cred, 'CREDENTIAL_ISSUE', cred,
    jsonb_build_object('keyId', key_id, 'scopes', p_scopes, 'secretStored', false));
  RETURN jsonb_build_object(
    'credentialId', cred, 'keyId', key_id, 'secret', secret,
    'secretShownOnce', true, 'expiresInSeconds', p_ttl);
END $$;

RESET ROLE;
COMMIT;
