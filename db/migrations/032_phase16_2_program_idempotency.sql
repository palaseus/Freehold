-- Phase 16.2 follow-up: bind program idempotency to the request payload.
-- Forward only. Migrations 001 through 031 are not edited.
--
-- The program layer already keyed retries by idempotency key, but several
-- financial operations returned an existing result without comparing the
-- request payload, so a conflicting retry looked like a harmless duplicate:
--   * program_settle_atomic / program_settle_coordinate replayed any cached
--     settlement for the key without checking the legs payload,
--   * program_fusd_request replayed an issuance request without checking the
--     amount,
--   * program_escrow_fund replayed a funding without checking source, amount,
--     beneficiary, conditions, or expiry,
--   * _program_asset_move replayed an asset movement without checking kind,
--     holders, or quantity.
-- This migration records a payload hash on each new program result row and
-- rejects a same-key/different-payload retry with PROGRAM_IDEMPOTENCY_CONFLICT
-- (SQLSTATE 55000). Same-key/same-payload retries still replay the stored
-- result, and a transaction-scoped advisory lock serializes same-key calls so
-- concurrent identical retries cannot race past the pre-check.
BEGIN;
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;

ALTER TABLE freehold.program_executions ADD COLUMN payload_hash text;
ALTER TABLE freehold.program_executions ADD CONSTRAINT program_executions_payload_hash_check
  CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE freehold.program_escrows ADD COLUMN payload_hash text;
ALTER TABLE freehold.program_escrows ADD CONSTRAINT program_escrows_payload_hash_check
  CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE freehold.program_asset_journals ADD COLUMN payload_hash text;
ALTER TABLE freehold.program_asset_journals ADD CONSTRAINT program_asset_journals_payload_hash_check
  CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE freehold.program_issuance_requests ADD COLUMN payload_hash text;
ALTER TABLE freehold.program_issuance_requests ADD CONSTRAINT program_issuance_requests_payload_hash_check
  CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$');

CREATE OR REPLACE FUNCTION freehold._program_asset_move(
  p_asset uuid, p_kind text, p_key text, p_from uuid, p_to uuid, p_qty bigint
) RETURNS uuid LANGUAGE plpgsql AS $fn$
DECLARE
  existing freehold.program_asset_journals;
  asset freehold.program_assets;
  first_holder uuid;
  second_holder uuid;
  from_available bigint;
  from_held bigint;
  from_pledged bigint;
  journal uuid;
  computed_hash text;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 OR p_key IS NULL THEN RAISE EXCEPTION 'PROGRAM_ASSET' USING ERRCODE = '22023'; END IF;
  computed_hash := freehold._program_hash(jsonb_build_object('kind', p_kind, 'from', p_from::text, 'to', p_to::text, 'qty', p_qty::text));
  PERFORM pg_advisory_xact_lock(hashtextextended('program_asset:' || p_asset::text || ':' || p_key, 0));
  SELECT * INTO existing FROM freehold.program_asset_journals WHERE asset_id = p_asset AND idempotency_key = p_key;
  IF existing.id IS NOT NULL THEN
    IF existing.payload_hash IS NOT NULL AND existing.payload_hash IS DISTINCT FROM computed_hash THEN
      RAISE EXCEPTION 'PROGRAM_IDEMPOTENCY_CONFLICT' USING ERRCODE = '55000';
    END IF;
    RETURN existing.id;
  END IF;
  PERFORM freehold._program_writer();
  SELECT * INTO asset FROM freehold.program_assets WHERE id = p_asset FOR UPDATE;
  IF NOT FOUND OR NOT asset.simulation_only OR asset.live_authorized THEN
    RAISE EXCEPTION 'PROGRAM_ASSET' USING ERRCODE = '22023';
  END IF;
  IF asset.lifecycle IN ('RETIRED','CANCELLED') THEN RAISE EXCEPTION 'PROGRAM_ASSET' USING ERRCODE = '22023'; END IF;
  first_holder := LEAST(p_from, p_to);
  second_holder := GREATEST(p_from, p_to);
  IF first_holder IS NOT NULL THEN
    PERFORM 1 FROM freehold.program_asset_positions WHERE asset_id = p_asset AND holder_institution_id = first_holder FOR UPDATE;
  END IF;
  IF second_holder IS NOT NULL AND second_holder IS DISTINCT FROM first_holder THEN
    PERFORM 1 FROM freehold.program_asset_positions WHERE asset_id = p_asset AND holder_institution_id = second_holder FOR UPDATE;
  END IF;
  IF p_kind = 'ISSUE' THEN
    IF asset.lifecycle NOT IN ('AUTHORIZED','ISSUED') OR p_to IS NULL THEN RAISE EXCEPTION 'PROGRAM_ASSET' USING ERRCODE = '22023'; END IF;
    INSERT INTO freehold.program_asset_positions(asset_id, holder_institution_id, available_minor)
    VALUES (p_asset, p_to, p_qty)
    ON CONFLICT (asset_id, holder_institution_id) DO UPDATE SET available_minor = freehold.program_asset_positions.available_minor + EXCLUDED.available_minor;
    UPDATE freehold.program_assets SET supply_minor = supply_minor + p_qty, lifecycle = 'ISSUED' WHERE id = p_asset;
  ELSIF p_kind = 'TRANSFER' THEN
    UPDATE freehold.program_asset_positions SET available_minor = available_minor - p_qty
    WHERE asset_id = p_asset AND holder_institution_id = p_from AND available_minor >= p_qty
    RETURNING available_minor INTO from_available;
    IF NOT FOUND THEN RAISE EXCEPTION 'PROGRAM_ASSET' USING ERRCODE = '55000'; END IF;
    INSERT INTO freehold.program_asset_positions(asset_id, holder_institution_id, available_minor)
    VALUES (p_asset, p_to, p_qty)
    ON CONFLICT (asset_id, holder_institution_id) DO UPDATE SET available_minor = freehold.program_asset_positions.available_minor + EXCLUDED.available_minor;
  ELSIF p_kind = 'HOLD' THEN
    UPDATE freehold.program_asset_positions SET available_minor = available_minor - p_qty, held_minor = held_minor + p_qty
    WHERE asset_id = p_asset AND holder_institution_id = p_from AND available_minor >= p_qty;
    IF NOT FOUND THEN RAISE EXCEPTION 'PROGRAM_ASSET' USING ERRCODE = '55000'; END IF;
  ELSIF p_kind = 'RELEASE' THEN
    UPDATE freehold.program_asset_positions SET available_minor = available_minor + p_qty, held_minor = held_minor - p_qty
    WHERE asset_id = p_asset AND holder_institution_id = p_from AND held_minor >= p_qty;
    IF NOT FOUND THEN RAISE EXCEPTION 'PROGRAM_ASSET' USING ERRCODE = '55000'; END IF;
  ELSIF p_kind = 'PLEDGE' THEN
    UPDATE freehold.program_asset_positions SET available_minor = available_minor - p_qty, pledged_minor = pledged_minor + p_qty
    WHERE asset_id = p_asset AND holder_institution_id = p_from AND available_minor >= p_qty;
    IF NOT FOUND THEN RAISE EXCEPTION 'PROGRAM_COLLATERAL' USING ERRCODE = '55000'; END IF;
  ELSIF p_kind = 'UNPLEDGE' THEN
    UPDATE freehold.program_asset_positions SET available_minor = available_minor + p_qty, pledged_minor = pledged_minor - p_qty
    WHERE asset_id = p_asset AND holder_institution_id = p_from AND pledged_minor >= p_qty;
    IF NOT FOUND THEN RAISE EXCEPTION 'PROGRAM_COLLATERAL' USING ERRCODE = '55000'; END IF;
  ELSIF p_kind IN ('REDEEM','RETIRE') THEN
    UPDATE freehold.program_asset_positions SET available_minor = available_minor - p_qty
    WHERE asset_id = p_asset AND holder_institution_id = p_from AND available_minor >= p_qty;
    IF NOT FOUND THEN RAISE EXCEPTION 'PROGRAM_ASSET' USING ERRCODE = '55000'; END IF;
    UPDATE freehold.program_assets SET supply_minor = supply_minor - p_qty,
      lifecycle = CASE WHEN p_kind = 'RETIRE' THEN 'RETIRED' ELSE 'REDEEMED' END
    WHERE id = p_asset AND supply_minor >= p_qty;
    IF NOT FOUND THEN RAISE EXCEPTION 'PROGRAM_ASSET' USING ERRCODE = '55000'; END IF;
  ELSE
    RAISE EXCEPTION 'PROGRAM_ASSET' USING ERRCODE = '22023';
  END IF;
  INSERT INTO freehold.program_asset_journals(asset_id, idempotency_key, kind, quantity_minor, from_holder, to_holder, payload_hash)
  VALUES (p_asset, p_key, p_kind, p_qty, p_from, p_to, computed_hash)
  RETURNING id INTO journal;
  RETURN journal;
END $fn$;

CREATE OR REPLACE FUNCTION freehold.program_escrow_fund(
  p_actor uuid, p_institution uuid, p_source uuid, p_amount bigint, p_beneficiary uuid, p_ref text,
  p_conditions jsonb, p_expires timestamptz, p_key text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE
  src freehold.institution_ledger_accounts;
  suspense uuid;
  journal uuid;
  escrow uuid;
  existing freehold.program_escrows;
  computed_hash text;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'payments:write');
  PERFORM freehold._program_open(p_institution);
  PERFORM freehold._program_forbidden(p_conditions);
  IF p_conditions->>'language' IS DISTINCT FROM 'fh-workflow-1' OR COALESCE(p_conditions->>'release', '') NOT IN ('AUTHORIZED','TIME') THEN
    RAISE EXCEPTION 'PROGRAM_LANGUAGE' USING ERRCODE = '22023';
  END IF;
  IF p_expires IS NULL OR p_expires <= clock_timestamp() OR p_amount IS NULL OR p_amount <= 0 OR p_beneficiary IS NULL THEN
    RAISE EXCEPTION 'PROGRAM_EXPIRED' USING ERRCODE = '22023';
  END IF;
  computed_hash := freehold._program_hash(jsonb_build_object(
    'source', p_source::text, 'amount', p_amount, 'beneficiary', p_beneficiary, 'ref', p_ref,
    'conditions', COALESCE(p_conditions, '{}'::jsonb), 'expires', p_expires));
  PERFORM pg_advisory_xact_lock(hashtextextended('program_escrow:' || p_institution::text || ':' || p_key, 0));
  SELECT * INTO existing FROM freehold.program_escrows WHERE institution_id = p_institution AND idempotency_key = p_key;
  IF existing.id IS NOT NULL THEN
    IF existing.payload_hash IS NOT NULL AND existing.payload_hash IS DISTINCT FROM computed_hash THEN
      RAISE EXCEPTION 'PROGRAM_IDEMPOTENCY_CONFLICT' USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object('escrowId', existing.id, 'duplicate', true, 'legalEscrow', false);
  END IF;
  SELECT * INTO src FROM freehold.institution_ledger_accounts WHERE id = p_source;
  IF src.id IS NULL OR src.institution_id IS DISTINCT FROM p_institution THEN RAISE EXCEPTION 'PROGRAM_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  PERFORM freehold._program_pick_policy(p_institution, 'ESCROW', p_amount, src.currency_code);
  SELECT id INTO suspense FROM freehold.institution_ledger_accounts
  WHERE institution_id = p_institution AND kind = 'SUSPENSE' AND currency_code = src.currency_code LIMIT 1;
  IF suspense IS NULL THEN RAISE EXCEPTION 'PROGRAM_ESCROW' USING ERRCODE = '22023'; END IF;
  journal := freehold._program_leg(p_institution, suspense, p_source, p_amount, 'escrow-fund:' || p_key);
  PERFORM freehold._program_writer();
  INSERT INTO freehold.program_escrows(
    institution_id, source_account_id, suspense_account_id, beneficiary_institution_id, beneficiary_ref,
    conditions, reserved_minor, status, expires_at, fund_journal_id, funded_by, idempotency_key, payload_hash)
  VALUES (
    p_institution, p_source, suspense, p_beneficiary, p_ref, p_conditions, p_amount, 'FUNDED', p_expires, journal, p_actor, p_key, computed_hash)
  RETURNING id INTO escrow;
  PERFORM freehold._program_audit(p_institution, p_actor, 'ESCROW_FUND', escrow, jsonb_build_object('legalEscrow', false, 'amountMinor', p_amount::text));
  RETURN jsonb_build_object('escrowId', escrow, 'status', 'FUNDED', 'journalId', journal, 'duplicate', false, 'legalEscrow', false, 'fiduciaryCustody', false);
END $fn$;

CREATE OR REPLACE FUNCTION freehold.program_fusd_request(
  p_actor uuid, p_institution uuid, p_book uuid, p_amount bigint, p_key text, p_not_before timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE
  b freehold.monetary_books;
  supply freehold.monetary_supply;
  eligible bigint;
  before_outstanding bigint;
  after_outstanding bigint;
  existing freehold.program_issuance_requests;
  status_text text;
  row_id uuid;
  computed_hash text;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'governance:write');
  PERFORM freehold._program_open(p_institution);
  IF p_amount IS NULL OR p_amount <= 0 OR p_key IS NULL THEN RAISE EXCEPTION 'PROGRAM_LIMIT' USING ERRCODE = '22023'; END IF;
  computed_hash := freehold._program_hash(jsonb_build_object('book', p_book::text, 'amount', p_amount, 'notBefore', COALESCE(p_not_before::text, '')));
  PERFORM pg_advisory_xact_lock(hashtextextended('program_fusd:' || p_book::text || ':' || p_key, 0));
  SELECT * INTO existing FROM freehold.program_issuance_requests WHERE book_id = p_book AND idempotency_key = p_key;
  IF existing.id IS NOT NULL THEN
    IF existing.payload_hash IS NOT NULL AND existing.payload_hash IS DISTINCT FROM computed_hash THEN
      RAISE EXCEPTION 'PROGRAM_IDEMPOTENCY_CONFLICT' USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object('requestId', existing.id, 'status', existing.status, 'duplicate', true, 'supplyChanged', false, 'liveIssuance', false);
  END IF;
  SELECT * INTO b FROM freehold.monetary_books WHERE id = p_book;
  IF NOT FOUND OR b.product_code IS DISTINCT FROM 'PAYMENT_STABLECOIN' OR NOT b.simulation_only OR b.live_issuance_enabled THEN
    RAISE EXCEPTION 'PROGRAM_POLICY' USING ERRCODE = '22023';
  END IF;
  IF b.issuance_suspended THEN RAISE EXCEPTION 'PROGRAM_SUSPENDED' USING ERRCODE = '55000'; END IF;
  PERFORM freehold._program_pick_policy(p_institution, 'ISSUANCE', p_amount, 'USD');
  SELECT * INTO supply FROM freehold.monetary_supply WHERE book_id = p_book;
  before_outstanding := supply.outstanding;
  eligible := freehold._monetary_eligible(p_book);
  IF p_not_before IS NOT NULL AND p_not_before > clock_timestamp() THEN
    status_text := 'SCHEDULED';
  ELSIF supply.outstanding + supply.pending_issuance + p_amount > b.authorized_max_outstanding THEN
    status_text := 'REJECTED_CAP';
  ELSIF eligible < supply.outstanding + supply.pending_issuance + p_amount THEN
    status_text := 'REJECTED_COVERAGE';
  ELSE
    status_text := 'REQUESTED';
  END IF;
  PERFORM freehold._program_writer();
  INSERT INTO freehold.program_issuance_requests(
    institution_id, book_id, amount_minor, status, idempotency_key, changes_supply, not_before, created_by, payload_hash)
  VALUES (p_institution, p_book, p_amount, status_text, p_key, false, p_not_before, p_actor, computed_hash)
  RETURNING id INTO row_id;
  SELECT outstanding INTO after_outstanding FROM freehold.monetary_supply WHERE book_id = p_book;
  IF before_outstanding IS DISTINCT FROM after_outstanding THEN RAISE EXCEPTION 'PROGRAM_POLICY' USING ERRCODE = '55000'; END IF;
  PERFORM freehold._program_audit(p_institution, p_actor, 'FUSD_REQUEST', row_id, jsonb_build_object('status', status_text, 'supplyChanged', false, 'externalReserve', 'EXTERNAL_EVIDENCE_UNAVAILABLE'));
  RETURN jsonb_build_object('requestId', row_id, 'status', status_text, 'duplicate', false, 'supplyChanged', false, 'liveIssuance', false, 'changesOutstanding', false);
END $fn$;

CREATE OR REPLACE FUNCTION freehold.program_settle_atomic(
  p_actor uuid, p_institution uuid, p_key text, p_deadline timestamptz, p_legs jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE
  existing freehold.program_executions;
  exec_id uuid;
  leg jsonb;
  ordinal integer := 0;
  exposure bigint := 0;
  journal uuid;
  acct uuid;
  inst uuid;
  n integer;
  computed_hash text;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'payments:write');
  PERFORM freehold._program_open(p_institution);
  IF p_legs IS NULL OR jsonb_typeof(p_legs) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'PROGRAM_LANGUAGE' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._program_forbidden(p_legs);
  n := jsonb_array_length(p_legs);
  IF n < 1 OR n > 16 THEN RAISE EXCEPTION 'PROGRAM_LIMIT' USING ERRCODE = '22023'; END IF;
  computed_hash := freehold._program_hash(p_legs);
  PERFORM pg_advisory_xact_lock(hashtextextended('program_settle:' || p_institution::text || ':' || p_key, 0));
  SELECT * INTO existing FROM freehold.program_executions WHERE institution_id = p_institution AND idempotency_key = p_key FOR UPDATE;
  IF existing.id IS NOT NULL THEN
    IF existing.payload_hash IS NOT NULL AND existing.payload_hash IS DISTINCT FROM computed_hash THEN
      RAISE EXCEPTION 'PROGRAM_IDEMPOTENCY_CONFLICT' USING ERRCODE = '55000';
    END IF;
    IF existing.state = 'UNKNOWN' THEN RAISE EXCEPTION 'PROGRAM_UNKNOWN_BLOCKED' USING ERRCODE = '55000'; END IF;
    RETURN jsonb_build_object('executionId', existing.id, 'duplicate', true, 'state', existing.state, 'atomicity', existing.atomicity);
  END IF;
  IF p_deadline IS NOT NULL AND p_deadline <= clock_timestamp() THEN
    PERFORM freehold._program_writer();
    INSERT INTO freehold.program_executions(institution_id, idempotency_key, state, atomicity, finished_at, payload_hash)
    VALUES (p_institution, p_key, 'EXPIRED', 'NONE', clock_timestamp(), computed_hash) RETURNING id INTO exec_id;
    RETURN jsonb_build_object('executionId', exec_id, 'state', 'EXPIRED', 'executed', false, 'posted', false);
  END IF;
  FOR leg IN SELECT value FROM jsonb_array_elements(p_legs) LOOP
    IF leg ? 'coordination' OR leg ? 'sql' THEN RAISE EXCEPTION 'PROGRAM_NOT_ATOMIC' USING ERRCODE = '22023'; END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_object_keys(leg) AS key_name WHERE key_name NOT IN ('institutionId','debitAccount','creditAccount','amountMinor')
    ) THEN
      RAISE EXCEPTION 'PROGRAM_LANGUAGE' USING ERRCODE = '22023';
    END IF;
    IF COALESCE(leg->>'amountMinor', '') !~ '^[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'PROGRAM_LIMIT' USING ERRCODE = '22023'; END IF;
    IF EXISTS (
      SELECT 1 FROM freehold.institution_ledger_accounts
      WHERE id IN ((leg->>'debitAccount')::uuid, (leg->>'creditAccount')::uuid) AND currency_code IS DISTINCT FROM 'USD'
    ) THEN RAISE EXCEPTION 'PROGRAM_POLICY' USING ERRCODE = '22023'; END IF;
    exposure := exposure + (leg->>'amountMinor')::bigint;
    inst := (leg->>'institutionId')::uuid;
    PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, inst, 'payments:write');
    PERFORM freehold._program_open(inst);
  END LOOP;
  PERFORM freehold._program_pick_policy(p_institution, 'SETTLEMENT', exposure, 'USD');
  FOR acct IN
    SELECT account_id FROM (
      SELECT (value->>'debitAccount')::uuid AS account_id FROM jsonb_array_elements(p_legs)
      UNION
      SELECT (value->>'creditAccount')::uuid AS account_id FROM jsonb_array_elements(p_legs)
    ) ids WHERE account_id IS NOT NULL ORDER BY account_id
  LOOP
    PERFORM 1 FROM freehold.institution_ledger_accounts WHERE id = acct FOR UPDATE;
  END LOOP;
  PERFORM freehold._program_writer();
  INSERT INTO freehold.program_executions(institution_id, idempotency_key, state, atomicity, payload_hash)
  VALUES (p_institution, p_key, 'EXECUTING', 'SINGLE_DATABASE', computed_hash) RETURNING id INTO exec_id;
  FOR leg IN SELECT value FROM jsonb_array_elements(p_legs) LOOP
    journal := freehold._program_leg((leg->>'institutionId')::uuid, (leg->>'debitAccount')::uuid, (leg->>'creditAccount')::uuid, (leg->>'amountMinor')::bigint, 'p14:' || exec_id::text || ':' || ordinal::text);
    INSERT INTO freehold.program_legs(
      execution_id, ordinal, kind, state, amount_minor, currency_code, institution_id, debit_account_id, credit_account_id, journal_id, coordination)
    VALUES (exec_id, ordinal, 'SETTLEMENT', 'POSTED', (leg->>'amountMinor')::bigint, 'USD', (leg->>'institutionId')::uuid,
      (leg->>'debitAccount')::uuid, (leg->>'creditAccount')::uuid, journal, 'SINGLE_DATABASE');
    ordinal := ordinal + 1;
  END LOOP;
  UPDATE freehold.program_executions SET state = 'COMPLETED', finished_at = clock_timestamp() WHERE id = exec_id;
  PERFORM freehold._program_audit(p_institution, p_actor, 'SETTLE_ATOMIC', exec_id, jsonb_build_object('legs', n, 'distributedAtomicity', false));
  RETURN jsonb_build_object('executionId', exec_id, 'state', 'COMPLETED', 'duplicate', false, 'atomicity', 'SINGLE_DATABASE', 'distributedAtomicity', false, 'posted', true);
END $fn$;

CREATE OR REPLACE FUNCTION freehold.program_settle_coordinate(
  p_actor uuid, p_institution uuid, p_key text, p_legs jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE existing freehold.program_executions; exec_id uuid; leg jsonb; ordinal integer := 0;
  computed_hash text;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'payments:write');
  PERFORM freehold._program_forbidden(p_legs);
  computed_hash := freehold._program_hash(p_legs);
  PERFORM pg_advisory_xact_lock(hashtextextended('program_settle:' || p_institution::text || ':' || p_key, 0));
  SELECT * INTO existing FROM freehold.program_executions WHERE institution_id = p_institution AND idempotency_key = p_key;
  IF existing.id IS NOT NULL THEN
    IF existing.payload_hash IS NOT NULL AND existing.payload_hash IS DISTINCT FROM computed_hash THEN
      RAISE EXCEPTION 'PROGRAM_IDEMPOTENCY_CONFLICT' USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object('executionId', existing.id, 'duplicate', true, 'state', existing.state, 'distributedAtomicity', false, 'posted', false);
  END IF;
  PERFORM freehold._program_writer();
  INSERT INTO freehold.program_executions(institution_id, idempotency_key, state, atomicity, finished_at, payload_hash)
  VALUES (p_institution, p_key, 'UNKNOWN', 'COORDINATED_NOT_ATOMIC', clock_timestamp(), computed_hash) RETURNING id INTO exec_id;
  FOR leg IN SELECT value FROM jsonb_array_elements(p_legs) LOOP
    INSERT INTO freehold.program_legs(execution_id, ordinal, kind, state, amount_minor, currency_code, institution_id, coordination)
    VALUES (exec_id, ordinal, 'COORDINATED_EXTERNAL', 'AWAITING_EXTERNAL', COALESCE((leg->>'amountMinor')::bigint, 0), 'USD', p_institution, 'AWAITING_EXTERNAL');
    ordinal := ordinal + 1;
  END LOOP;
  PERFORM freehold._program_audit(p_institution, p_actor, 'SETTLE_COORDINATE', exec_id, jsonb_build_object('distributedAtomicity', false, 'posted', false));
  RETURN jsonb_build_object('executionId', exec_id, 'state', 'UNKNOWN', 'distributedAtomicity', false, 'posted', false, 'externalFinality', 'EXTERNAL_EVIDENCE_UNAVAILABLE');
END $fn$;

RESET ROLE;
COMMIT;
