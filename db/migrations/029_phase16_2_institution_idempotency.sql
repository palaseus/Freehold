-- Phase 16.2: deterministic institution-journal idempotency.
-- Forward only. Migrations 001 through 028 are not edited.
--
-- institution_journals is keyed by (institution_id, idempotency_key). Before
-- this migration any replay with the same key returned the original journal
-- without checking whether the request payload was identical. That made a
-- conflicting retry look like a harmless duplicate. This migration records a
-- request hash on each new journal and rejects a same-key/different-payload
-- retry with INSTITUTION_IDEMPOTENCY_CONFLICT (SQLSTATE 55000).
--
-- Transfer callers also take a transaction-scoped advisory lock on the journal
-- key so two concurrent identical retries cannot both pass the pre-check. The
-- lock is re-entrant, so _institution_post can take it again safely.
BEGIN;
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;

ALTER TABLE freehold.institution_journals ADD COLUMN request_hash text;
ALTER TABLE freehold.institution_journals ADD CONSTRAINT institution_journals_request_hash_check
  CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');

CREATE FUNCTION freehold._institution_request_hash(p_kind text, p_lines jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(public.digest(convert_to(
    p_kind || '|' || COALESCE(p_lines, '[]'::jsonb)::text, 'UTF8'), 'sha256'), 'hex');
$$;

CREATE OR REPLACE FUNCTION freehold._institution_post(
  p_institution uuid, p_entity uuid, p_currency text, p_kind text,
  p_key text, p_correlation uuid, p_memo text, p_lines jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE
  existing uuid;
  existing_hash text;
  computed_hash text;
  line jsonb;
  acct freehold.institution_ledger_accounts;
  debits bigint := 0;
  credits bigint := 0;
  journal uuid;
  signed bigint;
  next_balance bigint;
BEGIN
  IF p_institution IS NULL OR p_key IS NULL OR p_lines IS NULL THEN
    RAISE EXCEPTION 'INSTITUTION_IDEMPOTENCY' USING ERRCODE = '22023';
  END IF;
  computed_hash := freehold._institution_request_hash(p_kind, p_lines);
  PERFORM pg_advisory_xact_lock(
    hashtextextended('institution_journal:' || p_institution::text || ':' || p_key, 0));
  SELECT id, request_hash INTO existing, existing_hash
  FROM freehold.institution_journals
  WHERE institution_id = p_institution AND idempotency_key = p_key;
  IF existing IS NOT NULL THEN
    IF existing_hash IS NOT NULL AND existing_hash IS DISTINCT FROM computed_hash THEN
      RAISE EXCEPTION 'INSTITUTION_IDEMPOTENCY_CONFLICT' USING ERRCODE = '55000';
    END IF;
    RETURN existing;
  END IF;
  PERFORM freehold._institution_entity_ok(p_entity);
  PERFORM set_config('freehold.institution_writer', 'on', true);
  INSERT INTO freehold.institution_journals(
    institution_id, currency_code, legal_entity_id, kind, idempotency_key,
    correlation_id, memo, request_hash)
  VALUES (
    p_institution, p_currency, p_entity, p_kind, p_key,
    p_correlation, p_memo, computed_hash)
  RETURNING id INTO journal;
  FOR line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    SELECT * INTO acct FROM freehold.institution_ledger_accounts
    WHERE id = (line->>'account')::uuid FOR UPDATE;
    IF NOT FOUND OR acct.institution_id IS DISTINCT FROM p_institution
       OR acct.currency_code IS DISTINCT FROM p_currency
       OR acct.legal_entity_id IS DISTINCT FROM p_entity THEN
      RAISE EXCEPTION 'INSTITUTION_ACCOUNT' USING ERRCODE = '42501';
    END IF;
    IF line->>'side' = 'DEBIT' THEN
      debits := debits + (line->>'amount')::bigint;
    ELSE
      credits := credits + (line->>'amount')::bigint;
    END IF;
    signed := freehold._institution_signed(acct.kind, line->>'side', (line->>'amount')::bigint);
    IF signed IS NULL THEN
      RAISE EXCEPTION 'INSTITUTION_ACCOUNT' USING ERRCODE = '22023';
    END IF;
    next_balance := acct.balance_minor + signed;
    IF next_balance < 0 AND acct.kind <> 'SUSPENSE' THEN
      RAISE EXCEPTION 'INSTITUTION_INSUFFICIENT' USING ERRCODE = '55000';
    END IF;
    UPDATE freehold.institution_ledger_accounts SET balance_minor = next_balance WHERE id = acct.id;
    INSERT INTO freehold.institution_entries(journal_id, account_id, side, amount_minor)
    VALUES (journal, acct.id, line->>'side', (line->>'amount')::bigint);
  END LOOP;
  IF debits <> credits OR debits <= 0 THEN
    RAISE EXCEPTION 'INSTITUTION_UNBALANCED' USING ERRCODE = '23514';
  END IF;
  RETURN journal;
END $$;

CREATE OR REPLACE FUNCTION freehold.institution_transfer(
  p_actor uuid, p_key text, p_hash text, p_nonce text, p_institution uuid,
  p_from uuid, p_to uuid, p_amount bigint, p_idempotency text, p_correlation uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE
  who jsonb;
  src freehold.institution_ledger_accounts;
  dst freehold.institution_ledger_accounts;
  journal uuid;
  existing uuid;
  existing_hash text;
  computed_hash text;
  lines jsonb;
BEGIN
  who := freehold._institution_actor(p_actor, p_key, p_hash, p_nonce, p_institution, 'transfers:write');
  IF p_idempotency IS NULL THEN
    RAISE EXCEPTION 'INSTITUTION_IDEMPOTENCY' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('institution_journal:' || p_institution::text || ':' || p_idempotency, 0));
  lines := jsonb_build_array(
    jsonb_build_object('account', p_from, 'side', 'DEBIT', 'amount', p_amount::text),
    jsonb_build_object('account', p_to, 'side', 'CREDIT', 'amount', p_amount::text));
  computed_hash := freehold._institution_request_hash('INTERNAL_TRANSFER', lines);
  SELECT id, request_hash INTO existing, existing_hash
  FROM freehold.institution_journals
  WHERE institution_id = p_institution AND idempotency_key = p_idempotency;
  IF existing IS NOT NULL THEN
    IF existing_hash IS NOT NULL AND existing_hash IS DISTINCT FROM computed_hash THEN
      RAISE EXCEPTION 'INSTITUTION_IDEMPOTENCY_CONFLICT' USING ERRCODE = '55000';
    END IF;
    PERFORM freehold._institution_audit(
      p_institution, NULLIF(who->>'userId','')::uuid, NULLIF(who->>'credentialId','')::uuid,
      'DUPLICATE_TRANSFER', existing, '{}'::jsonb);
    RETURN jsonb_build_object('journalId', existing, 'duplicate', true);
  END IF;
  SELECT * INTO src FROM freehold.institution_ledger_accounts WHERE id = p_from;
  SELECT * INTO dst FROM freehold.institution_ledger_accounts WHERE id = p_to;
  IF src.institution_id IS DISTINCT FROM p_institution OR dst.institution_id IS DISTINCT FROM p_institution THEN
    RAISE EXCEPTION 'INSTITUTION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF src.legal_entity_id IS DISTINCT FROM dst.legal_entity_id
     OR src.currency_code IS DISTINCT FROM dst.currency_code THEN
    RAISE EXCEPTION 'INSTITUTION_ENTITY' USING ERRCODE = '22023';
  END IF;
  journal := freehold._institution_post(
    p_institution, src.legal_entity_id, src.currency_code, 'INTERNAL_TRANSFER',
    p_idempotency, p_correlation, 'INTERNAL_TRANSFER_NOT_EXTERNAL_SETTLEMENT', lines);
  PERFORM freehold._institution_emit(
    p_institution, NULL, 'transfer.posted',
    jsonb_build_object('journalId', journal, 'state', 'POSTED', 'amountMinor', p_amount::text));
  RETURN jsonb_build_object('journalId', journal, 'duplicate', false, 'correlationId', p_correlation);
END $$;

REVOKE ALL ON FUNCTION freehold._institution_request_hash(text, jsonb)
  FROM PUBLIC, freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._institution_post(uuid, uuid, text, text, text, uuid, text, jsonb)
  FROM PUBLIC, freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;

RESET ROLE;
COMMIT;
