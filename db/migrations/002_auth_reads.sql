-- Apply after 001 as deployment superuser. No ledger functions are changed.
-- The trusted backend needs credentials for password verification and a safe
-- current-user lookup. No table write or users-table SELECT grants are added.
BEGIN;
SET LOCAL ROLE freehold_owner;
CREATE FUNCTION freehold.auth_find_credentials(p_email text)
RETURNS TABLE(id uuid,password_hash text,status text,role text,auth_version bigint,totp_secret_encrypted bytea)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
 SELECT u.id,u.password_hash,u.status,u.role,u.auth_version,u.totp_secret_encrypted
 FROM freehold.users u WHERE u.email_normalized=p_email
$$;
CREATE FUNCTION freehold.auth_get_user(p_id uuid)
RETURNS TABLE(id uuid,status text,role text,auth_version bigint,two_factor_enabled boolean)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
 SELECT u.id,u.status,u.role,u.auth_version,u.totp_secret_encrypted IS NOT NULL
 FROM freehold.users u WHERE u.id=p_id
$$;
-- SHARE lock prevents revocation/role changes from racing a mutation's commit.
CREATE FUNCTION freehold.auth_lock_user(p_id uuid)
RETURNS TABLE(id uuid,status text,role text,auth_version bigint,two_factor_enabled boolean)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
 SELECT u.id,u.status,u.role,u.auth_version,u.totp_secret_encrypted IS NOT NULL
 FROM freehold.users u WHERE u.id=p_id FOR SHARE OF u
$$;
REVOKE ALL ON FUNCTION freehold.auth_find_credentials(text),freehold.auth_get_user(uuid),freehold.auth_lock_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION freehold.auth_find_credentials(text),freehold.auth_get_user(uuid),freehold.auth_lock_user(uuid) TO freehold_app;
COMMENT ON FUNCTION freehold.auth_find_credentials(text) IS 'Trusted authentication backend only. Never expose as a public RPC.';
RESET ROLE;
COMMIT;
