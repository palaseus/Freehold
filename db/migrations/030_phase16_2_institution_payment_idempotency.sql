-- Phase 16.2 follow-up: bind institution payment idempotency to the payload.
-- Forward only. Migrations 001 through 029 are not edited.
--
-- institution_payments already had UNIQUE (institution_id, idempotency_key),
-- but institution_payment_open returned any existing payment for the key
-- without checking whether the request payload was identical. A conflicting
-- retry therefore looked like a harmless duplicate, and two concurrent opens
-- could race into a raw unique violation (HTTP 500). This migration records a
-- request hash on each new payment and serializes same-key opens with a
-- transaction-scoped advisory lock, matching the journal behavior from 029.
--
-- The hash deliberately excludes the actor, correlation id, and nonce: a
-- legitimate retry may arrive through a different session or credential and
-- with a fresh correlation id. It includes every field that changes what the
-- payment is: account, amount, rail, and external reference.
BEGIN;
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;

ALTER TABLE freehold.institution_payments ADD COLUMN request_hash text;
ALTER TABLE freehold.institution_payments ADD CONSTRAINT institution_payments_request_hash_check
  CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');

CREATE OR REPLACE FUNCTION freehold.institution_payment_open(
  p_actor uuid, p_key text, p_hash text, p_nonce text, p_institution uuid,
  p_account uuid, p_amount bigint, p_rail text, p_external text, p_idempotency text, p_correlation uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE
  who jsonb;
  acct freehold.institution_ledger_accounts;
  existing freehold.institution_payments;
  computed_hash text;
  pay uuid;
BEGIN
  who := freehold._institution_actor(p_actor, p_key, p_hash, p_nonce, p_institution, 'payments:write');
  IF p_idempotency IS NULL OR p_idempotency !~ '^[A-Za-z0-9:._-]{8,80}$' THEN
    RAISE EXCEPTION 'INSTITUTION_IDEMPOTENCY' USING ERRCODE = '22023';
  END IF;
  computed_hash := encode(public.digest(convert_to(
    jsonb_build_object(
      'account', p_account,
      'amountMinor', p_amount::text,
      'rail', p_rail,
      'externalRef', p_external
    )::text, 'UTF8'), 'sha256'), 'hex');
  PERFORM pg_advisory_xact_lock(
    hashtextextended('institution_payment:' || p_institution::text || ':' || p_idempotency, 0));
  SELECT * INTO existing FROM freehold.institution_payments
  WHERE institution_id = p_institution AND idempotency_key = p_idempotency;
  IF existing.id IS NOT NULL THEN
    IF existing.request_hash IS NOT NULL AND existing.request_hash IS DISTINCT FROM computed_hash THEN
      RAISE EXCEPTION 'INSTITUTION_IDEMPOTENCY_CONFLICT' USING ERRCODE = '55000';
    END IF;
    PERFORM freehold._institution_audit(p_institution, NULLIF(who->>'userId','')::uuid, NULLIF(who->>'credentialId','')::uuid,
      'DUPLICATE_PAYMENT', existing.id, jsonb_build_object('state', existing.state));
    RETURN jsonb_build_object(
      'paymentId', existing.id, 'state', existing.state, 'finality', existing.finality,
      'duplicate', true, 'liveSubmission', false);
  END IF;
  -- external_ref is independently unique per institution. Reusing it under a
  -- new key is a conflicting request, not a new payment. The unique constraint
  -- remains the final backstop for two different keys racing each other.
  IF EXISTS (
    SELECT 1 FROM freehold.institution_payments
    WHERE institution_id = p_institution AND external_ref = p_external
  ) THEN
    RAISE EXCEPTION 'INSTITUTION_IDEMPOTENCY_CONFLICT' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO acct FROM freehold.institution_ledger_accounts WHERE id = p_account;
  IF acct.institution_id IS DISTINCT FROM p_institution OR acct.kind <> 'CUSTOMER' THEN
    RAISE EXCEPTION 'INSTITUTION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('freehold.institution_writer', 'on', true);
  INSERT INTO freehold.institution_payments(
    institution_id, account_id, legal_entity_id, currency_code, amount_minor, rail, external_ref,
    idempotency_key, correlation_id, state, finality, created_by, created_credential, request_hash)
  VALUES (
    p_institution, p_account, acct.legal_entity_id, acct.currency_code, p_amount, p_rail, p_external,
    p_idempotency, p_correlation, 'CREATED', 'NONE', NULLIF(who->>'userId','')::uuid,
    NULLIF(who->>'credentialId','')::uuid, computed_hash)
  RETURNING id INTO pay;
  PERFORM freehold._institution_emit(p_institution, pay, 'payment.created', jsonb_build_object('paymentId', pay, 'state', 'CREATED', 'amountMinor', p_amount::text));
  PERFORM freehold._institution_audit(p_institution, NULLIF(who->>'userId','')::uuid, NULLIF(who->>'credentialId','')::uuid, 'PAYMENT_OPEN', pay, jsonb_build_object('rail', p_rail, 'liveSubmission', false));
  RETURN jsonb_build_object('paymentId', pay, 'state', 'CREATED', 'finality', 'NONE', 'duplicate', false, 'liveSubmission', false);
END $$;

RESET ROLE;
COMMIT;
