-- Phase 16.2 follow-up: bind network payment idempotency to the payload.
-- Forward only. Migrations 001 through 030 are not edited.
--
-- network_payments already stored payload_sha256, but network_payment_open
-- returned an existing payment for the key without comparing the incoming
-- payload. A same-key retry with a different amount, purpose, or account
-- silently looked like a duplicate. This replaces the function so the payload
-- hash is computed before the replay check and a mismatch raises
-- NETWORK_IDEMPOTENCY_CONFLICT (HTTP 409). A transaction-scoped advisory lock
-- serializes same-key opens so concurrent identical retries replay instead of
-- racing into the unique constraint.
BEGIN;
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;

CREATE OR REPLACE FUNCTION freehold.network_payment_open(
  p_actor uuid, p_origin uuid, p_beneficiary uuid, p_origin_account uuid, p_beneficiary_account uuid,
  p_amount bigint, p_purpose text, p_key text, p_correlation uuid, p_cert uuid, p_signature text, p_nonce text, p_ttl integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE
  existing freehold.network_payments;
  cert freehold.network_certificates;
  origin_acct freehold.institution_ledger_accounts;
  beneficiary_acct freehold.institution_ledger_accounts;
  payload text;
  computed_hash text;
  payment uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_origin, 'payments:write');
  IF p_amount <= 0 OR p_ttl < 60 OR p_ttl > 604800 THEN RAISE EXCEPTION 'NETWORK_PAYMENT' USING ERRCODE = '22023'; END IF;
  IF p_signature !~ '^[0-9a-f]{128}$' OR p_nonce IS NULL THEN RAISE EXCEPTION 'NETWORK_SIGNATURE' USING ERRCODE = '42501'; END IF;
  SELECT * INTO cert FROM freehold.network_certificates WHERE id = p_cert FOR UPDATE;
  IF NOT FOUND OR cert.institution_id IS DISTINCT FROM p_origin THEN RAISE EXCEPTION 'NETWORK_CERT' USING ERRCODE = '42501'; END IF;
  IF cert.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'NETWORK_CERT_REVOKED' USING ERRCODE = '42501'; END IF;
  IF cert.not_after <= clock_timestamp() OR cert.not_before > clock_timestamp() THEN
    RAISE EXCEPTION 'NETWORK_CERT_EXPIRED' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO origin_acct FROM freehold.institution_ledger_accounts WHERE id = p_origin_account;
  SELECT * INTO beneficiary_acct FROM freehold.institution_ledger_accounts WHERE id = p_beneficiary_account;
  IF origin_acct.institution_id IS DISTINCT FROM p_origin OR origin_acct.kind IS DISTINCT FROM 'CUSTOMER'
     OR beneficiary_acct.institution_id IS DISTINCT FROM p_beneficiary OR beneficiary_acct.kind IS DISTINCT FROM 'CUSTOMER'
     OR origin_acct.currency_code IS DISTINCT FROM beneficiary_acct.currency_code THEN
    RAISE EXCEPTION 'NETWORK_CURRENCY' USING ERRCODE = '22023';
  END IF;
  payload := freehold._network_payload(
    p_origin, p_beneficiary, p_origin_account, p_beneficiary_account,
    origin_acct.currency_code, p_amount, p_key, p_purpose);
  computed_hash := encode(public.digest(payload, 'sha256'), 'hex');
  PERFORM pg_advisory_xact_lock(
    hashtextextended('network_payment:' || p_origin::text || ':' || p_key, 0));
  PERFORM freehold._network_writer();
  BEGIN
    INSERT INTO freehold.network_nonces(certificate_id, nonce) VALUES (cert.id, p_nonce);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'NETWORK_REPLAY' USING ERRCODE = '55000';
  END;
  SELECT * INTO existing FROM freehold.network_payments
  WHERE origin_institution_id = p_origin AND idempotency_key = p_key;
  IF FOUND THEN
    IF existing.payload_sha256 IS NOT NULL AND existing.payload_sha256 IS DISTINCT FROM computed_hash THEN
      RAISE EXCEPTION 'NETWORK_IDEMPOTENCY_CONFLICT' USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object('paymentId', existing.id, 'state', existing.state, 'duplicate', true, 'posted', false);
  END IF;
  INSERT INTO freehold.network_payments(
    origin_institution_id, beneficiary_institution_id, origin_account_id, beneficiary_account_id,
    currency_code, amount_minor, purpose, idempotency_key, correlation_id, state, certificate_id,
    signature_hex, payload_sha256, expires_at, created_by)
  VALUES (
    p_origin, p_beneficiary, p_origin_account, p_beneficiary_account, origin_acct.currency_code, p_amount, p_purpose, p_key,
    p_correlation, 'CREATED', cert.id, p_signature, computed_hash,
    clock_timestamp() + make_interval(secs => p_ttl), p_actor)
  RETURNING id INTO payment;
  PERFORM freehold._network_audit(NULL, p_origin, p_actor, 'PAYMENT_OPEN', NULL, 'CREATED', jsonb_build_object('paymentId', payment, 'posted', false));
  RETURN jsonb_build_object('paymentId', payment, 'state', 'CREATED', 'duplicate', false, 'posted', false, 'route', 'DIRECT_SIMULATION', 'externalSettlement', false);
END $$;

RESET ROLE;
COMMIT;
