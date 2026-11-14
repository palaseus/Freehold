-- Narrow identity/demo functions; no changes to ledger posting logic or grants.
BEGIN;
SET LOCAL ROLE freehold_owner;
CREATE TABLE freehold.demo_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 enabled boolean NOT NULL DEFAULT false,
 bootstrap_hash bytea CHECK (bootstrap_hash IS NULL OR octet_length(bootstrap_hash)=32)
);
INSERT INTO freehold.demo_settings DEFAULT VALUES;
CREATE FUNCTION freehold.register_user(p_email text,p_hash text,p_totp bytea DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE new_id uuid; correlation uuid:=gen_random_uuid();
BEGIN
 IF p_hash NOT LIKE '$argon2id$%' THEN RAISE EXCEPTION 'INVALID_PASSWORD_HASH' USING ERRCODE='22023'; END IF;
 BEGIN
  INSERT INTO freehold.users(email_normalized,password_hash,totp_secret_encrypted)
  VALUES(p_email,p_hash,p_totp) RETURNING id INTO new_id;
 EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'EMAIL_UNAVAILABLE' USING ERRCODE='23505'; END;
 INSERT INTO freehold.audit_log(actor_id,event_type,resource_id,correlation_id,request_id,outcome)
 VALUES(new_id,'USER_REGISTERED',new_id,correlation,correlation,'COMPLETED');
 RETURN new_id;
END $$;
CREATE FUNCTION freehold.demo_bootstrap_admin(p_token text,p_email text,p_hash text,p_totp bytea)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE settings freehold.demo_settings; new_id uuid; correlation uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO STRICT settings FROM freehold.demo_settings WHERE singleton FOR SHARE;
 IF NOT settings.enabled OR settings.bootstrap_hash IS NULL OR p_token IS NULL
 OR settings.bootstrap_hash<>sha256(convert_to(p_token,'UTF8')) OR p_totp IS NULL THEN
  RAISE EXCEPTION 'DEMO_DISABLED_OR_UNAUTHORIZED' USING ERRCODE='42501';
 END IF;
 IF p_hash NOT LIKE '$argon2id$%' THEN RAISE EXCEPTION 'INVALID_PASSWORD_HASH' USING ERRCODE='22023'; END IF;
 -- Re-running a seed never resets an existing user's credentials or role.
 INSERT INTO freehold.users(email_normalized,password_hash,role,totp_secret_encrypted)
 VALUES(p_email,p_hash,'ADMIN',p_totp) ON CONFLICT (email_normalized) DO NOTHING RETURNING id INTO new_id;
 IF new_id IS NULL THEN
  SELECT id INTO new_id FROM freehold.users WHERE email_normalized=p_email AND role='ADMIN';
  IF new_id IS NULL THEN RAISE EXCEPTION 'EMAIL_UNAVAILABLE' USING ERRCODE='23505'; END IF;
  RETURN new_id;
 END IF;
 INSERT INTO freehold.audit_log(actor_id,event_type,resource_id,correlation_id,request_id,outcome,metadata)
 VALUES(new_id,'DEMO_ADMIN_BOOTSTRAPPED',new_id,correlation,correlation,'COMPLETED','{"sandbox":true}');
 RETURN new_id;
END $$;
CREATE FUNCTION freehold.auth_user_email(p_id uuid) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
 SELECT email_normalized FROM freehold.users WHERE id=p_id
$$;
CREATE FUNCTION freehold.admin_list_accounts(p_actor uuid,p_query text,p_limit integer)
RETURNS TABLE(id uuid,"ownerEmail" text,currency text,status text,"availableMinor" text,"reservedMinor" text,"totalMinor" text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 PERFORM freehold._actor(p_actor,true);
 RETURN QUERY SELECT a.id,u.email_normalized,a.currency_code,a.status,a.available_minor::text,a.reserved_minor::text,
 (a.available_minor::numeric+a.reserved_minor::numeric)::text
 FROM freehold.accounts a JOIN freehold.users u ON u.id=a.owner_user_id
 WHERE p_query IS NULL OR p_query='' OR a.id::text=p_query OR u.email_normalized LIKE '%'||p_query||'%'
 ORDER BY a.created_at,a.id LIMIT least(greatest(p_limit,1),100);
END $$;
REVOKE ALL ON TABLE freehold.demo_settings FROM PUBLIC,freehold_app;
REVOKE ALL ON FUNCTION freehold.register_user(text,text,bytea),freehold.demo_bootstrap_admin(text,text,text,bytea),
 freehold.auth_user_email(uuid),freehold.admin_list_accounts(uuid,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION freehold.register_user(text,text,bytea),freehold.demo_bootstrap_admin(text,text,text,bytea),
 freehold.auth_user_email(uuid),freehold.admin_list_accounts(uuid,text,integer) TO freehold_app;
RESET ROLE;
COMMIT;
