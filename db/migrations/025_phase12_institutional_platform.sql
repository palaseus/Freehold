-- Phase 12. Forward only. Migrations 001 through 024 are not edited.
-- Institutional records are a separate plane from the customer ledger.
-- Row level security is not enabled. freehold_api cannot read these tables.
-- Isolation is the function boundary: every read and write takes an institution
-- and proves membership or a live credential for that institution.
-- A verifier SELECT policy would not be a substitute for that check, and FORCE
-- ROW LEVEL SECURITY would also bind the table owner that SECURITY DEFINER
-- functions run as. The verifier is granted SELECT and no EXECUTE.
-- Live issuance, external settlement, and real invoices stay refused.
-- Webhook and API secrets are returned once and stored only as SHA-256 hashes.
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;

CREATE TABLE freehold.institutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9-]{3,40}$'),
  legal_name text NOT NULL CHECK (char_length(legal_name) BETWEEN 3 AND 160),
  status text NOT NULL DEFAULT 'SIMULATED_SANDBOX' CHECK (status = 'SIMULATED_SANDBOX'),
  simulation_only boolean NOT NULL DEFAULT true CHECK (simulation_only),
  live_authorized boolean NOT NULL DEFAULT false CHECK (NOT live_authorized),
  created_by uuid NOT NULL REFERENCES freehold.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE freehold.institution_members (
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  user_id uuid NOT NULL REFERENCES freehold.users(id),
  capability text NOT NULL CHECK (capability IN (
    'TENANT_ADMIN','TREASURY','PAYMENTS','COMPLIANCE','GOVERNANCE','AUDITOR','DEVELOPER')),
  granted_by uuid NOT NULL REFERENCES freehold.users(id),
  revoked_at timestamptz,
  PRIMARY KEY (institution_id, user_id, capability)
);

CREATE TABLE freehold.institution_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  key_id text NOT NULL UNIQUE CHECK (key_id ~ '^fh_sandbox_[0-9a-f]{24}$'),
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_by uuid NOT NULL REFERENCES freehold.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (scopes <@ ARRAY[
    'accounts:read','accounts:write','transfers:write','payments:write','payments:read',
    'treasury:read','reserves:read','compliance:write','governance:write','webhooks:write',
    'billing:read','reports:read']::text[])
);

CREATE TABLE freehold.institution_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  external_ref text NOT NULL CHECK (char_length(external_ref) BETWEEN 1 AND 80),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  status text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED')),
  UNIQUE (institution_id, external_ref)
);

CREATE TABLE freehold.institution_ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  customer_id uuid REFERENCES freehold.institution_customers(id),
  legal_entity_id uuid NOT NULL REFERENCES freehold.legal_entities(id),
  kind text NOT NULL CHECK (kind IN (
    'CUSTOMER','TREASURY','OPERATING','RESERVE','CLEARING','SETTLEMENT_RECEIVABLE','SETTLEMENT_PAYABLE','SUSPENSE')),
  currency_code text NOT NULL REFERENCES freehold.currencies(code),
  balance_minor bigint NOT NULL DEFAULT 0 CHECK (balance_minor >= 0 OR kind = 'SUSPENSE'),
  evidence_state text NOT NULL DEFAULT 'EXTERNAL_UNAVAILABLE' CHECK (evidence_state IN ('SIMULATED_INTERNAL','EXTERNAL_UNAVAILABLE')),
  custodian_label text,
  maturity_date date,
  counts_as_external_asset boolean NOT NULL DEFAULT false CHECK (NOT counts_as_external_asset)
);

CREATE TABLE freehold.institution_journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  currency_code text NOT NULL REFERENCES freehold.currencies(code),
  legal_entity_id uuid NOT NULL REFERENCES freehold.legal_entities(id),
  kind text NOT NULL,
  idempotency_key text NOT NULL,
  correlation_id uuid NOT NULL,
  memo text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (institution_id, idempotency_key)
);

CREATE TABLE freehold.institution_entries (
  journal_id uuid NOT NULL REFERENCES freehold.institution_journals(id),
  account_id uuid NOT NULL REFERENCES freehold.institution_ledger_accounts(id),
  side text NOT NULL CHECK (side IN ('DEBIT','CREDIT')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (journal_id, account_id, side)
);

CREATE TABLE freehold.institution_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  account_id uuid NOT NULL REFERENCES freehold.institution_ledger_accounts(id),
  legal_entity_id uuid NOT NULL,
  currency_code text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  rail text NOT NULL CHECK (rail IN ('ACH','FEDWIRE','BANK_INTERNAL','RTP','STABLECOIN_NETWORK')),
  external_ref text NOT NULL,
  idempotency_key text NOT NULL,
  correlation_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN (
    'CREATED','VALIDATING','PENDING_APPROVAL','READY_TO_SUBMIT','SUBMITTED','ACKNOWLEDGED',
    'PENDING_SETTLEMENT','SETTLED','RETURNED','REJECTED','FAILED','UNKNOWN','CANCELLED')),
  finality text NOT NULL CHECK (finality IN ('NONE','INSTRUCTION_ACCEPTED','PROVIDER_ACKNOWLEDGED','SETTLED_SIMULATED')),
  live_submission boolean NOT NULL DEFAULT false CHECK (NOT live_submission),
  signature_ok boolean NOT NULL DEFAULT false,
  settlement_journal_id uuid REFERENCES freehold.institution_journals(id),
  reversal_journal_id uuid REFERENCES freehold.institution_journals(id),
  created_by uuid,
  created_credential uuid REFERENCES freehold.institution_credentials(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (institution_id, idempotency_key),
  UNIQUE (institution_id, external_ref),
  CHECK (state <> 'SETTLED' OR (signature_ok AND settlement_journal_id IS NOT NULL AND finality = 'SETTLED_SIMULATED'))
);

CREATE TABLE freehold.institution_provider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  payment_id uuid NOT NULL REFERENCES freehold.institution_payments(id),
  provider_event_id text NOT NULL,
  state text NOT NULL,
  signature_ok boolean NOT NULL,
  UNIQUE (payment_id, provider_event_id)
);

CREATE TABLE freehold.institution_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  payment_id uuid REFERENCES freehold.institution_payments(id),
  event_type text NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING','LEASED','DONE','DEAD')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until timestamptz,
  claimed_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE freehold.institution_webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  url text NOT NULL CHECK (url ~ '^https://example\.test/'),
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE freehold.institution_webhook_subscriptions (
  endpoint_id uuid NOT NULL REFERENCES freehold.institution_webhook_endpoints(id),
  event_type text NOT NULL,
  PRIMARY KEY (endpoint_id, event_type)
);

CREATE TABLE freehold.institution_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  event_type text NOT NULL,
  payment_id uuid REFERENCES freehold.institution_payments(id),
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE freehold.institution_webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES freehold.institution_webhook_events(id),
  endpoint_id uuid NOT NULL REFERENCES freehold.institution_webhook_endpoints(id),
  state text NOT NULL CHECK (state IN ('PENDING','DELIVERED_SIMULATED','FAILED','TIMEOUT','DEAD')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  UNIQUE (event_id, endpoint_id)
);

CREATE TABLE freehold.institution_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  payment_id uuid REFERENCES freehold.institution_payments(id),
  state text NOT NULL CHECK (state IN ('OPEN','EVIDENCE','ASSIGNED','ESCALATED','RESOLVED')),
  opened_by uuid NOT NULL,
  investigator_id uuid,
  resolution text,
  product_code text NOT NULL DEFAULT 'SIMULATED_LEDGER',
  legal_regime text NOT NULL DEFAULT 'NOT_DETERMINED' CHECK (legal_regime = 'NOT_DETERMINED')
);

CREATE TABLE freehold.institution_dispute_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id uuid NOT NULL REFERENCES freehold.institution_disputes(id),
  author_id uuid NOT NULL,
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE freehold.institution_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  dispute_id uuid REFERENCES freehold.institution_disputes(id),
  template_code text NOT NULL CHECK (template_code = 'TREASURY_COMPENSATING_PAIR'),
  debit_account_id uuid NOT NULL REFERENCES freehold.institution_ledger_accounts(id),
  credit_account_id uuid NOT NULL REFERENCES freehold.institution_ledger_accounts(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  state text NOT NULL CHECK (state IN ('PROPOSED','POSTED','REJECTED')),
  proposed_by uuid NOT NULL,
  posted_by uuid,
  journal_id uuid REFERENCES freehold.institution_journals(id),
  CHECK (state <> 'POSTED' OR (posted_by IS NOT NULL AND posted_by <> proposed_by AND journal_id IS NOT NULL))
);

CREATE TABLE freehold.institution_policies (
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  code text NOT NULL CHECK (code IN ('PAYMENT_APPROVAL_MINOR','CUSTODIAN_CONCENTRATION_BPS','RATE_PER_MINUTE')),
  threshold_minor bigint NOT NULL CHECK (threshold_minor >= 0),
  PRIMARY KEY (institution_id, code)
);

CREATE TABLE freehold.institution_risk_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  scenario text NOT NULL CHECK (scenario IN (
    'NORMAL_REDEMPTION','ELEVATED_REDEMPTION','LARGE_REDEMPTION_SHOCK','CUSTODIAN_OUTAGE',
    'SETTLEMENT_DELAY','RESERVE_INELIGIBILITY','MARKET_VALUE_DECLINE','COUNTERPARTY_DEFAULT')),
  assumptions jsonb NOT NULL,
  result jsonb NOT NULL,
  mutated_accounts boolean NOT NULL DEFAULT false CHECK (NOT mutated_accounts),
  regulatory_capital_determination boolean NOT NULL DEFAULT false CHECK (NOT regulatory_capital_determination),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE freehold.institution_price_plans (
  institution_id uuid PRIMARY KEY REFERENCES freehold.institutions(id),
  monthly_minor bigint NOT NULL CHECK (monthly_minor >= 0),
  api_call_minor bigint NOT NULL CHECK (api_call_minor >= 0),
  transaction_minor bigint NOT NULL CHECK (transaction_minor >= 0),
  compliance_minor bigint NOT NULL CHECK (compliance_minor >= 0),
  report_minor bigint NOT NULL CHECK (report_minor >= 0)
);

CREATE TABLE freehold.institution_usage_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  period_start date NOT NULL,
  meter text NOT NULL CHECK (meter IN ('API_CALL','TRANSACTION','COMPLIANCE_TOOL','REPORT','TENANT','CREDIT')),
  quantity bigint NOT NULL CHECK (quantity >= 0)
);

CREATE TABLE freehold.institution_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  period_start date NOT NULL,
  total_minor bigint NOT NULL,
  state text NOT NULL DEFAULT 'SIMULATED_DRAFT' CHECK (state = 'SIMULATED_DRAFT'),
  collected boolean NOT NULL DEFAULT false CHECK (NOT collected),
  UNIQUE (institution_id, period_start)
);

CREATE TABLE freehold.institution_invoice_lines (
  invoice_id uuid NOT NULL REFERENCES freehold.institution_invoices(id),
  meter text NOT NULL,
  quantity bigint NOT NULL,
  amount_minor bigint NOT NULL,
  PRIMARY KEY (invoice_id, meter)
);

CREATE TABLE freehold.institution_compliance_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  subject_ref text NOT NULL,
  state text NOT NULL DEFAULT 'NOT_A_BSA_PROGRAM' CHECK (state = 'NOT_A_BSA_PROGRAM'),
  opened_by uuid NOT NULL
);

CREATE TABLE freehold.institution_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  actor_id uuid,
  credential_id uuid,
  action text NOT NULL,
  object_id uuid,
  detail jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE freehold.institution_nonces (
  credential_id uuid NOT NULL REFERENCES freehold.institution_credentials(id),
  nonce text NOT NULL CHECK (char_length(nonce) BETWEEN 8 AND 80),
  seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (credential_id, nonce)
);

CREATE TABLE freehold.institution_rate_buckets (
  institution_id uuid NOT NULL,
  actor_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  credential_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  bucket timestamptz NOT NULL,
  hits integer NOT NULL CHECK (hits > 0),
  PRIMARY KEY (institution_id, actor_id, credential_id, bucket)
);

CREATE TABLE freehold.institution_issuance_links (
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  issuance_id uuid NOT NULL REFERENCES freehold.issuance_operations(id),
  linked_by uuid NOT NULL,
  PRIMARY KEY (institution_id, issuance_id)
);

CREATE FUNCTION freehold._institution_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
BEGIN
  IF current_setting('freehold.institution_writer', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'INSTITUTION_DIRECT_WRITE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'INSTITUTION_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION freehold._institution_no_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'INSTITUTION_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER institution_journals_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.institution_journals
  FOR EACH ROW EXECUTE FUNCTION freehold._institution_guard();
CREATE TRIGGER institution_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.institution_entries
  FOR EACH ROW EXECUTE FUNCTION freehold._institution_guard();
CREATE TRIGGER institution_entries_no_delete BEFORE DELETE ON freehold.institution_entries
  FOR EACH ROW EXECUTE FUNCTION freehold._institution_no_delete();
CREATE TRIGGER institution_audit_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.institution_audit
  FOR EACH ROW EXECUTE FUNCTION freehold._institution_guard();
CREATE TRIGGER institution_payments_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.institution_payments
  FOR EACH ROW EXECUTE FUNCTION freehold._institution_guard();
CREATE TRIGGER institution_accounts_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.institution_ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION freehold._institution_guard();

CREATE FUNCTION freehold._institution_journal_balanced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE debits bigint; credits bigint;
BEGIN
  SELECT COALESCE(sum(amount_minor) FILTER (WHERE side = 'DEBIT'), 0),
         COALESCE(sum(amount_minor) FILTER (WHERE side = 'CREDIT'), 0)
    INTO debits, credits
  FROM freehold.institution_entries WHERE journal_id = COALESCE(NEW.journal_id, OLD.journal_id);
  IF debits <> credits OR debits <= 0 THEN
    RAISE EXCEPTION 'INSTITUTION_UNBALANCED' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER institution_entries_balanced
  AFTER INSERT OR UPDATE OR DELETE ON freehold.institution_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION freehold._institution_journal_balanced();

CREATE FUNCTION freehold._institution_signed(p_kind text, p_side text, p_amount bigint) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_kind IN ('TREASURY','OPERATING','RESERVE','SETTLEMENT_RECEIVABLE') AND p_side = 'DEBIT' THEN p_amount
    WHEN p_kind IN ('TREASURY','OPERATING','RESERVE','SETTLEMENT_RECEIVABLE') AND p_side = 'CREDIT' THEN -p_amount
    WHEN p_kind IN ('CUSTOMER','CLEARING','SETTLEMENT_PAYABLE','SUSPENSE') AND p_side = 'CREDIT' THEN p_amount
    WHEN p_kind IN ('CUSTOMER','CLEARING','SETTLEMENT_PAYABLE','SUSPENSE') AND p_side = 'DEBIT' THEN -p_amount
  END;
$$;

CREATE FUNCTION freehold._institution_scope_ok(p_capability text, p_scope text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_capability
    WHEN 'TENANT_ADMIN' THEN true
    WHEN 'TREASURY' THEN p_scope IN ('treasury:read','reserves:read','reports:read','accounts:read')
    WHEN 'PAYMENTS' THEN p_scope IN ('payments:write','payments:read','transfers:write','accounts:read','accounts:write')
    WHEN 'COMPLIANCE' THEN p_scope IN ('compliance:write','accounts:read')
    WHEN 'GOVERNANCE' THEN p_scope IN ('governance:write','payments:read','reports:read')
    WHEN 'AUDITOR' THEN p_scope IN ('accounts:read','payments:read','treasury:read','reserves:read','reports:read','billing:read')
    WHEN 'DEVELOPER' THEN p_scope IN ('webhooks:write','accounts:read','billing:read')
    ELSE false
  END;
$$;

CREATE FUNCTION freehold._institution_audit(
  p_institution uuid, p_actor uuid, p_credential uuid, p_action text, p_object uuid, p_detail jsonb
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('freehold.institution_writer', 'on', true);
  INSERT INTO freehold.institution_audit(institution_id, actor_id, credential_id, action, object_id, detail)
  VALUES (p_institution, p_actor, p_credential, p_action, p_object, p_detail);
END $$;

CREATE FUNCTION freehold._institution_rate(p_institution uuid, p_actor uuid, p_credential uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  limit_hits bigint;
  actor uuid := COALESCE(p_actor, '00000000-0000-0000-0000-000000000000');
  cred uuid := COALESCE(p_credential, '00000000-0000-0000-0000-000000000000');
  minute_bucket timestamptz := date_trunc('minute', clock_timestamp());
  seen integer;
BEGIN
  SELECT threshold_minor INTO limit_hits FROM freehold.institution_policies
  WHERE institution_id = p_institution AND code = 'RATE_PER_MINUTE';
  IF limit_hits IS NULL THEN limit_hits := 1000; END IF;
  INSERT INTO freehold.institution_rate_buckets(institution_id, actor_id, credential_id, bucket, hits)
  VALUES (p_institution, actor, cred, minute_bucket, 1)
  ON CONFLICT (institution_id, actor_id, credential_id, bucket)
  DO UPDATE SET hits = freehold.institution_rate_buckets.hits + 1
  RETURNING hits INTO seen;
  IF seen > limit_hits THEN RAISE EXCEPTION 'INSTITUTION_RATE' USING ERRCODE = '55000'; END IF;
END $$;

CREATE FUNCTION freehold._institution_actor(
  p_actor uuid, p_key text, p_hash text, p_nonce text, p_institution uuid, p_scope text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE cred freehold.institution_credentials; allowed boolean;
BEGIN
  IF p_key IS NOT NULL THEN
    SELECT * INTO cred FROM freehold.institution_credentials WHERE key_id = p_key;
    IF NOT FOUND THEN RAISE EXCEPTION 'INSTITUTION_CREDENTIAL' USING ERRCODE = '42501'; END IF;
    IF cred.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'INSTITUTION_REVOKED' USING ERRCODE = '42501'; END IF;
    IF cred.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'INSTITUTION_EXPIRED' USING ERRCODE = '42501'; END IF;
    IF cred.secret_hash IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'INSTITUTION_CREDENTIAL' USING ERRCODE = '42501'; END IF;
    IF cred.institution_id IS DISTINCT FROM p_institution THEN RAISE EXCEPTION 'INSTITUTION_FORBIDDEN' USING ERRCODE = '42501'; END IF;
    IF NOT (p_scope = ANY (cred.scopes)) THEN RAISE EXCEPTION 'INSTITUTION_SCOPE' USING ERRCODE = '42501'; END IF;
    IF p_nonce IS NULL THEN RAISE EXCEPTION 'INSTITUTION_REPLAY' USING ERRCODE = '55000'; END IF;
    BEGIN
      INSERT INTO freehold.institution_nonces(credential_id, nonce) VALUES (cred.id, p_nonce);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'INSTITUTION_REPLAY' USING ERRCODE = '55000';
    END;
    PERFORM freehold._institution_rate(p_institution, NULL, cred.id);
    RETURN jsonb_build_object('userId', NULL, 'credentialId', cred.id);
  END IF;
  PERFORM freehold._require_bound_session(p_actor);
  SELECT EXISTS (
    SELECT 1 FROM freehold.institution_members m
    WHERE m.institution_id = p_institution AND m.user_id = p_actor AND m.revoked_at IS NULL
      AND freehold._institution_scope_ok(m.capability, p_scope)
  ) INTO allowed;
  IF NOT allowed THEN RAISE EXCEPTION 'INSTITUTION_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  PERFORM freehold._institution_rate(p_institution, p_actor, NULL);
  RETURN jsonb_build_object('userId', p_actor, 'credentialId', NULL);
END $$;

CREATE FUNCTION freehold._institution_entity_ok(p_entity uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE row freehold.legal_entities;
BEGIN
  SELECT * INTO row FROM freehold.legal_entities WHERE id = p_entity;
  IF NOT FOUND OR NOT row.simulation_only OR row.live_authorized THEN
    RAISE EXCEPTION 'INSTITUTION_ENTITY' USING ERRCODE = '22023';
  END IF;
END $$;

CREATE FUNCTION freehold._institution_post(
  p_institution uuid, p_entity uuid, p_currency text, p_kind text, p_key text, p_correlation uuid, p_memo text, p_lines jsonb
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  existing uuid;
  line jsonb;
  acct freehold.institution_ledger_accounts;
  debits bigint := 0;
  credits bigint := 0;
  journal uuid;
  signed bigint;
  next_balance bigint;
BEGIN
  SELECT id INTO existing FROM freehold.institution_journals
  WHERE institution_id = p_institution AND idempotency_key = p_key;
  IF existing IS NOT NULL THEN RETURN existing; END IF;
  PERFORM freehold._institution_entity_ok(p_entity);
  PERFORM set_config('freehold.institution_writer', 'on', true);
  INSERT INTO freehold.institution_journals(institution_id, currency_code, legal_entity_id, kind, idempotency_key, correlation_id, memo)
  VALUES (p_institution, p_currency, p_entity, p_kind, p_key, p_correlation, p_memo)
  RETURNING id INTO journal;
  FOR line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    SELECT * INTO acct FROM freehold.institution_ledger_accounts WHERE id = (line->>'account')::uuid FOR UPDATE;
    IF NOT FOUND OR acct.institution_id IS DISTINCT FROM p_institution OR acct.currency_code IS DISTINCT FROM p_currency
       OR acct.legal_entity_id IS DISTINCT FROM p_entity THEN
      RAISE EXCEPTION 'INSTITUTION_ACCOUNT' USING ERRCODE = '42501';
    END IF;
    IF line->>'side' = 'DEBIT' THEN debits := debits + (line->>'amount')::bigint; ELSE credits := credits + (line->>'amount')::bigint; END IF;
    signed := freehold._institution_signed(acct.kind, line->>'side', (line->>'amount')::bigint);
    IF signed IS NULL THEN RAISE EXCEPTION 'INSTITUTION_ACCOUNT' USING ERRCODE = '22023'; END IF;
    next_balance := acct.balance_minor + signed;
    IF next_balance < 0 AND acct.kind <> 'SUSPENSE' THEN RAISE EXCEPTION 'INSTITUTION_INSUFFICIENT' USING ERRCODE = '55000'; END IF;
    UPDATE freehold.institution_ledger_accounts SET balance_minor = next_balance WHERE id = acct.id;
    INSERT INTO freehold.institution_entries(journal_id, account_id, side, amount_minor)
    VALUES (journal, acct.id, line->>'side', (line->>'amount')::bigint);
  END LOOP;
  IF debits <> credits OR debits <= 0 THEN RAISE EXCEPTION 'INSTITUTION_UNBALANCED' USING ERRCODE = '23514'; END IF;
  RETURN journal;
END $$;

CREATE FUNCTION freehold._institution_finality(p_state text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_state = 'SUBMITTED' THEN 'INSTRUCTION_ACCEPTED'
    WHEN p_state IN ('ACKNOWLEDGED','PENDING_SETTLEMENT') THEN 'PROVIDER_ACKNOWLEDGED'
    WHEN p_state IN ('SETTLED','RETURNED') THEN 'SETTLED_SIMULATED'
    ELSE 'NONE'
  END;
$$;

CREATE FUNCTION freehold._institution_transition_ok(p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (p_from = 'CREATED' AND p_to IN ('VALIDATING','REJECTED','CANCELLED'))
    OR (p_from = 'VALIDATING' AND p_to IN ('PENDING_APPROVAL','READY_TO_SUBMIT','REJECTED','CANCELLED'))
    OR (p_from = 'PENDING_APPROVAL' AND p_to IN ('READY_TO_SUBMIT','REJECTED','CANCELLED'))
    OR (p_from = 'READY_TO_SUBMIT' AND p_to IN ('SUBMITTED','CANCELLED','FAILED'))
    OR (p_from = 'SUBMITTED' AND p_to IN ('ACKNOWLEDGED','REJECTED','FAILED','UNKNOWN'))
    OR (p_from = 'ACKNOWLEDGED' AND p_to IN ('PENDING_SETTLEMENT','FAILED','UNKNOWN'))
    OR (p_from = 'PENDING_SETTLEMENT' AND p_to IN ('SETTLED','RETURNED','FAILED','UNKNOWN'))
    OR (p_from = 'SETTLED' AND p_to = 'RETURNED')
    OR (p_from = 'UNKNOWN' AND p_to IN ('FAILED','PENDING_SETTLEMENT','ACKNOWLEDGED'));
$$;

CREATE FUNCTION freehold._institution_emit(p_institution uuid, p_payment uuid, p_type text, p_body jsonb) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  event_id uuid;
  endpoint uuid;
BEGIN
  IF p_type = 'payment.settled' AND COALESCE(p_body->>'state', '') IS DISTINCT FROM 'SETTLED' THEN
    RAISE EXCEPTION 'INSTITUTION_EVENT' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('freehold.institution_writer', 'on', true);
  INSERT INTO freehold.institution_webhook_events(institution_id, event_type, payment_id, body)
  VALUES (p_institution, p_type, p_payment, p_body)
  RETURNING id INTO event_id;
  FOR endpoint IN
    SELECT s.endpoint_id
    FROM freehold.institution_webhook_subscriptions s
    JOIN freehold.institution_webhook_endpoints e ON e.id = s.endpoint_id
    WHERE e.institution_id = p_institution AND e.active AND s.event_type = p_type
  LOOP
    INSERT INTO freehold.institution_webhook_deliveries(event_id, endpoint_id, state)
    VALUES (event_id, endpoint, 'PENDING');
  END LOOP;
  INSERT INTO freehold.institution_outbox(institution_id, payment_id, event_type, state)
  VALUES (p_institution, p_payment, p_type, 'PENDING');
END $$;

CREATE FUNCTION freehold.institution_open(p_actor uuid, p_code text, p_legal_name text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE inst uuid; entity uuid := '10000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM freehold._require_bound_session(p_actor);
  IF NOT EXISTS (SELECT 1 FROM freehold.users WHERE id = p_actor AND role = 'ADMIN' AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'INSTITUTION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM freehold._institution_entity_ok(entity);
  INSERT INTO freehold.institutions(code, legal_name, created_by) VALUES (p_code, p_legal_name, p_actor) RETURNING id INTO inst;
  INSERT INTO freehold.institution_members(institution_id, user_id, capability, granted_by)
  VALUES (inst, p_actor, 'TENANT_ADMIN', p_actor);
  INSERT INTO freehold.institution_policies(institution_id, code, threshold_minor) VALUES
    (inst, 'PAYMENT_APPROVAL_MINOR', 1000000000000),
    (inst, 'CUSTODIAN_CONCENTRATION_BPS', 10000),
    (inst, 'RATE_PER_MINUTE', 1000);
  PERFORM set_config('freehold.institution_writer', 'on', true);
  INSERT INTO freehold.institution_ledger_accounts(institution_id, legal_entity_id, kind, currency_code, evidence_state)
  VALUES
    (inst, entity, 'OPERATING', 'USD', 'SIMULATED_INTERNAL'),
    (inst, entity, 'TREASURY', 'USD', 'EXTERNAL_UNAVAILABLE'),
    (inst, entity, 'CLEARING', 'USD', 'SIMULATED_INTERNAL'),
    (inst, entity, 'SUSPENSE', 'USD', 'SIMULATED_INTERNAL');
  PERFORM freehold._institution_audit(inst, p_actor, NULL, 'INSTITUTION_OPEN', inst, jsonb_build_object('simulationOnly', true));
  RETURN jsonb_build_object('institutionId', inst, 'status', 'SIMULATED_SANDBOX', 'liveAuthorized', false, 'simulationOnly', true);
END $$;

CREATE FUNCTION freehold.institution_grant(p_actor uuid, p_institution uuid, p_member uuid, p_capability text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'governance:write');
  IF p_actor = p_member THEN RAISE EXCEPTION 'INSTITUTION_SELF_APPROVAL' USING ERRCODE = '22023'; END IF;
  INSERT INTO freehold.institution_members(institution_id, user_id, capability, granted_by)
  VALUES (p_institution, p_member, p_capability, p_actor)
  ON CONFLICT (institution_id, user_id, capability) DO UPDATE SET revoked_at = NULL, granted_by = EXCLUDED.granted_by;
  PERFORM freehold._institution_audit(p_institution, p_actor, NULL, 'GRANT', p_member, jsonb_build_object('capability', p_capability));
  RETURN jsonb_build_object('institutionId', p_institution, 'memberId', p_member, 'capability', p_capability);
END $$;

CREATE FUNCTION freehold.institution_policy_set(p_actor uuid, p_institution uuid, p_code text, p_threshold bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'governance:write');
  IF p_code = 'RATE_PER_MINUTE' AND (p_threshold < 1 OR p_threshold > 1000) THEN
    RAISE EXCEPTION 'INSTITUTION_POLICY' USING ERRCODE = '22023';
  END IF;
  IF p_code = 'CUSTODIAN_CONCENTRATION_BPS' AND p_threshold > 10000 THEN
    RAISE EXCEPTION 'INSTITUTION_POLICY' USING ERRCODE = '22023';
  END IF;
  UPDATE freehold.institution_policies SET threshold_minor = p_threshold
  WHERE institution_id = p_institution AND code = p_code;
  IF NOT FOUND THEN RAISE EXCEPTION 'INSTITUTION_POLICY' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._institution_audit(p_institution, p_actor, NULL, 'POLICY', p_institution, jsonb_build_object('code', p_code, 'threshold', p_threshold::text));
  RETURN jsonb_build_object('code', p_code, 'thresholdMinor', p_threshold::text);
END $$;

CREATE FUNCTION freehold.institution_credential_issue(p_actor uuid, p_institution uuid, p_scopes text[], p_ttl integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE secret text; key_id text; cred uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'webhooks:write');
  IF p_ttl < 60 OR p_ttl > 86400 THEN RAISE EXCEPTION 'INSTITUTION_CREDENTIAL' USING ERRCODE = '22023'; END IF;
  IF p_scopes IS NULL OR cardinality(p_scopes) < 1 THEN RAISE EXCEPTION 'INSTITUTION_SCOPE' USING ERRCODE = '22023'; END IF;
  secret := encode(public.gen_random_bytes(32), 'hex');
  key_id := 'fh_sandbox_' || encode(public.gen_random_bytes(12), 'hex');
  INSERT INTO freehold.institution_credentials(institution_id, key_id, secret_hash, scopes, expires_at, created_by)
  VALUES (p_institution, key_id, encode(public.digest(secret, 'sha256'), 'hex'), p_scopes, clock_timestamp() + make_interval(secs => p_ttl), p_actor)
  RETURNING id INTO cred;
  PERFORM freehold._institution_audit(p_institution, p_actor, cred, 'CREDENTIAL_ISSUE', cred, jsonb_build_object('keyId', key_id, 'secretStored', false));
  RETURN jsonb_build_object('credentialId', cred, 'keyId', key_id, 'secret', secret, 'secretShownOnce', true, 'expiresInSeconds', p_ttl);
END $$;

CREATE FUNCTION freehold.institution_credential_revoke(p_actor uuid, p_institution uuid, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE cred uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'webhooks:write');
  UPDATE freehold.institution_credentials SET revoked_at = clock_timestamp()
  WHERE institution_id = p_institution AND key_id = p_key AND revoked_at IS NULL
  RETURNING id INTO cred;
  IF cred IS NULL THEN RAISE EXCEPTION 'INSTITUTION_CREDENTIAL' USING ERRCODE = '42501'; END IF;
  PERFORM freehold._institution_audit(p_institution, p_actor, cred, 'CREDENTIAL_REVOKE', cred, jsonb_build_object('keyId', p_key));
  RETURN jsonb_build_object('keyId', p_key, 'revoked', true);
END $$;

CREATE FUNCTION freehold.institution_customer_open(
  p_actor uuid, p_institution uuid, p_ref text, p_name text, p_currency text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE cust uuid; acct uuid; entity uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'accounts:write');
  SELECT legal_entity_id INTO entity FROM freehold.institution_ledger_accounts
  WHERE institution_id = p_institution AND kind = 'OPERATING' LIMIT 1;
  INSERT INTO freehold.institution_customers(institution_id, external_ref, display_name, status)
  VALUES (p_institution, p_ref, p_name, 'ACTIVE') RETURNING id INTO cust;
  PERFORM set_config('freehold.institution_writer', 'on', true);
  INSERT INTO freehold.institution_ledger_accounts(institution_id, customer_id, legal_entity_id, kind, currency_code, evidence_state)
  VALUES (p_institution, cust, entity, 'CUSTOMER', p_currency, 'SIMULATED_INTERNAL') RETURNING id INTO acct;
  PERFORM freehold._institution_audit(p_institution, p_actor, NULL, 'CUSTOMER_OPEN', cust, jsonb_build_object('accountId', acct));
  RETURN jsonb_build_object('customerId', cust, 'accountId', acct, 'status', 'ACTIVE', 'currency', p_currency, 'balanceMinor', '0');
END $$;

CREATE FUNCTION freehold.institution_fund_simulated(
  p_actor uuid, p_institution uuid, p_account uuid, p_amount bigint, p_key text, p_correlation uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE acct freehold.institution_ledger_accounts; operating uuid; journal uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'accounts:write');
  SELECT * INTO acct FROM freehold.institution_ledger_accounts WHERE id = p_account AND institution_id = p_institution AND kind = 'CUSTOMER';
  IF NOT FOUND THEN RAISE EXCEPTION 'INSTITUTION_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  SELECT id INTO operating FROM freehold.institution_ledger_accounts
  WHERE institution_id = p_institution AND kind = 'OPERATING' AND currency_code = acct.currency_code AND legal_entity_id = acct.legal_entity_id;
  journal := freehold._institution_post(
    p_institution, acct.legal_entity_id, acct.currency_code, 'SIMULATED_FUNDING', p_key, p_correlation,
    'SIMULATED_TREASURY_FUNDING_NOT_EXTERNAL_CASH',
    jsonb_build_array(
      jsonb_build_object('account', operating, 'side', 'DEBIT', 'amount', p_amount::text),
      jsonb_build_object('account', p_account, 'side', 'CREDIT', 'amount', p_amount::text)));
  PERFORM freehold._institution_audit(p_institution, p_actor, NULL, 'FUND_SIMULATED', journal, jsonb_build_object('externalAsset', false));
  RETURN jsonb_build_object('journalId', journal, 'externalAsset', false, 'amountMinor', p_amount::text);
END $$;

CREATE FUNCTION freehold.institution_transfer(
  p_actor uuid, p_key text, p_hash text, p_nonce text, p_institution uuid,
  p_from uuid, p_to uuid, p_amount bigint, p_idempotency text, p_correlation uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE who jsonb; src freehold.institution_ledger_accounts; dst freehold.institution_ledger_accounts; journal uuid; existing uuid;
BEGIN
  who := freehold._institution_actor(p_actor, p_key, p_hash, p_nonce, p_institution, 'transfers:write');
  SELECT id INTO existing FROM freehold.institution_journals WHERE institution_id = p_institution AND idempotency_key = p_idempotency;
  IF existing IS NOT NULL THEN
    PERFORM freehold._institution_audit(p_institution, NULLIF(who->>'userId','')::uuid, NULLIF(who->>'credentialId','')::uuid, 'DUPLICATE_TRANSFER', existing, '{}'::jsonb);
    RETURN jsonb_build_object('journalId', existing, 'duplicate', true);
  END IF;
  SELECT * INTO src FROM freehold.institution_ledger_accounts WHERE id = p_from;
  SELECT * INTO dst FROM freehold.institution_ledger_accounts WHERE id = p_to;
  IF src.institution_id IS DISTINCT FROM p_institution OR dst.institution_id IS DISTINCT FROM p_institution THEN
    RAISE EXCEPTION 'INSTITUTION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF src.legal_entity_id IS DISTINCT FROM dst.legal_entity_id OR src.currency_code IS DISTINCT FROM dst.currency_code THEN
    RAISE EXCEPTION 'INSTITUTION_ENTITY' USING ERRCODE = '22023';
  END IF;
  journal := freehold._institution_post(
    p_institution, src.legal_entity_id, src.currency_code, 'INTERNAL_TRANSFER', p_idempotency, p_correlation,
    'INTERNAL_TRANSFER_NOT_EXTERNAL_SETTLEMENT',
    jsonb_build_array(
      jsonb_build_object('account', p_from, 'side', 'DEBIT', 'amount', p_amount::text),
      jsonb_build_object('account', p_to, 'side', 'CREDIT', 'amount', p_amount::text)));
  PERFORM freehold._institution_emit(p_institution, NULL, 'transfer.posted', jsonb_build_object('journalId', journal, 'state', 'POSTED', 'amountMinor', p_amount::text));
  RETURN jsonb_build_object('journalId', journal, 'duplicate', false, 'correlationId', p_correlation);
END $$;

CREATE FUNCTION freehold.institution_account_get(p_actor uuid, p_key text, p_hash text, p_nonce text, p_institution uuid, p_account uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE acct freehold.institution_ledger_accounts;
BEGIN
  PERFORM freehold._institution_actor(p_actor, p_key, p_hash, p_nonce, p_institution, 'accounts:read');
  SELECT * INTO acct FROM freehold.institution_ledger_accounts WHERE id = p_account;
  IF NOT FOUND OR acct.institution_id IS DISTINCT FROM p_institution THEN
    RAISE EXCEPTION 'INSTITUTION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'accountId', acct.id, 'institutionId', acct.institution_id, 'kind', acct.kind,
    'currency', acct.currency_code, 'balanceMinor', acct.balance_minor::text,
    'legalEntityId', acct.legal_entity_id, 'evidenceState', acct.evidence_state,
    'countsAsExternalAsset', false);
END $$;

CREATE FUNCTION freehold.institution_activity(p_actor uuid, p_institution uuid, p_account uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE acct_inst uuid; rows jsonb;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'accounts:read');
  SELECT institution_id INTO acct_inst FROM freehold.institution_ledger_accounts WHERE id = p_account;
  IF acct_inst IS DISTINCT FROM p_institution THEN RAISE EXCEPTION 'INSTITUTION_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'journalId', j.id, 'side', e.side, 'amountMinor', e.amount_minor::text, 'kind', j.kind, 'memo', j.memo
  ) ORDER BY j.created_at), '[]'::jsonb) INTO rows
  FROM freehold.institution_entries e
  JOIN freehold.institution_journals j ON j.id = e.journal_id
  WHERE e.account_id = p_account AND j.institution_id = p_institution;
  RETURN jsonb_build_object('accountId', p_account, 'entries', rows);
END $$;

CREATE FUNCTION freehold.institution_treasury_open(
  p_actor uuid, p_institution uuid, p_kind text, p_currency text, p_custodian text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE entity uuid; acct uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'treasury:read');
  IF p_kind NOT IN ('RESERVE','SETTLEMENT_RECEIVABLE','SETTLEMENT_PAYABLE') THEN
    RAISE EXCEPTION 'INSTITUTION_ACCOUNT' USING ERRCODE = '22023';
  END IF;
  SELECT legal_entity_id INTO entity FROM freehold.institution_ledger_accounts
  WHERE institution_id = p_institution AND kind = 'OPERATING' LIMIT 1;
  PERFORM set_config('freehold.institution_writer', 'on', true);
  INSERT INTO freehold.institution_ledger_accounts(
    institution_id, legal_entity_id, kind, currency_code, evidence_state, custodian_label, counts_as_external_asset)
  VALUES (p_institution, entity, p_kind, p_currency, 'EXTERNAL_UNAVAILABLE', p_custodian, false)
  RETURNING id INTO acct;
  RETURN jsonb_build_object('accountId', acct, 'evidenceState', 'EXTERNAL_UNAVAILABLE', 'countsAsExternalAsset', false);
END $$;

CREATE FUNCTION freehold.institution_treasury_report(p_actor uuid, p_key text, p_hash text, p_nonce text, p_institution uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE body jsonb;
BEGIN
  PERFORM freehold._institution_actor(p_actor, p_key, p_hash, p_nonce, p_institution, 'treasury:read');
  SELECT COALESCE(jsonb_agg(row_body), '[]'::jsonb) INTO body FROM (
    SELECT jsonb_build_object(
      'currency', a.currency_code,
      'legalEntityId', a.legal_entity_id,
      'kind', a.kind,
      'accountId', a.id,
      'balanceMinor', a.balance_minor::text,
      'evidenceState', a.evidence_state,
      'custodianLabel', a.custodian_label,
      'countsAsExternalAsset', false
    ) AS row_body
    FROM freehold.institution_ledger_accounts a
    WHERE a.institution_id = p_institution
  ) s;
  RETURN jsonb_build_object(
    'simulationOnly', true,
    'externalAssetsRecognized', false,
    'consolidatedBalance', NULL,
    'valuationBasis', 'NONE',
    'accounts', body,
    'unsettled', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('currency', currency_code, 'amountMinor', amount::text)), '[]'::jsonb)
      FROM (
        SELECT currency_code, sum(amount_minor) AS amount
        FROM freehold.institution_payments
        WHERE institution_id = p_institution
          AND state IN ('SUBMITTED','ACKNOWLEDGED','PENDING_SETTLEMENT','UNKNOWN')
        GROUP BY currency_code
      ) u
    ));
END $$;

CREATE FUNCTION freehold.institution_payment_open(
  p_actor uuid, p_key text, p_hash text, p_nonce text, p_institution uuid,
  p_account uuid, p_amount bigint, p_rail text, p_external text, p_idempotency text, p_correlation uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE who jsonb; acct freehold.institution_ledger_accounts; existing freehold.institution_payments; pay uuid;
BEGIN
  who := freehold._institution_actor(p_actor, p_key, p_hash, p_nonce, p_institution, 'payments:write');
  SELECT * INTO existing FROM freehold.institution_payments
  WHERE institution_id = p_institution AND idempotency_key = p_idempotency;
  IF existing.id IS NOT NULL THEN
    PERFORM freehold._institution_audit(p_institution, NULLIF(who->>'userId','')::uuid, NULLIF(who->>'credentialId','')::uuid,
      'DUPLICATE_PAYMENT', existing.id, jsonb_build_object('state', existing.state));
    RETURN jsonb_build_object('paymentId', existing.id, 'state', existing.state, 'duplicate', true, 'liveSubmission', false);
  END IF;
  SELECT * INTO acct FROM freehold.institution_ledger_accounts WHERE id = p_account;
  IF acct.institution_id IS DISTINCT FROM p_institution OR acct.kind <> 'CUSTOMER' THEN
    RAISE EXCEPTION 'INSTITUTION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('freehold.institution_writer', 'on', true);
  INSERT INTO freehold.institution_payments(
    institution_id, account_id, legal_entity_id, currency_code, amount_minor, rail, external_ref,
    idempotency_key, correlation_id, state, finality, created_by, created_credential)
  VALUES (
    p_institution, p_account, acct.legal_entity_id, acct.currency_code, p_amount, p_rail, p_external,
    p_idempotency, p_correlation, 'CREATED', 'NONE', NULLIF(who->>'userId','')::uuid, NULLIF(who->>'credentialId','')::uuid)
  RETURNING id INTO pay;
  PERFORM freehold._institution_emit(p_institution, pay, 'payment.created', jsonb_build_object('paymentId', pay, 'state', 'CREATED', 'amountMinor', p_amount::text));
  PERFORM freehold._institution_audit(p_institution, NULLIF(who->>'userId','')::uuid, NULLIF(who->>'credentialId','')::uuid, 'PAYMENT_OPEN', pay, jsonb_build_object('rail', p_rail, 'liveSubmission', false));
  RETURN jsonb_build_object('paymentId', pay, 'state', 'CREATED', 'finality', 'NONE', 'duplicate', false, 'liveSubmission', false);
END $$;

CREATE FUNCTION freehold.institution_payment_transition(
  p_actor uuid, p_key text, p_hash text, p_nonce text, p_institution uuid,
  p_payment uuid, p_state text, p_event text, p_signature text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE
  who jsonb;
  pay freehold.institution_payments;
  threshold bigint;
  secret text;
  payload text;
  ok boolean := false;
  clearing uuid;
  journal uuid;
  event_name text;
BEGIN
  who := freehold._institution_actor(p_actor, p_key, p_hash, p_nonce, p_institution, 'payments:write');
  SELECT * INTO pay FROM freehold.institution_payments WHERE id = p_payment FOR UPDATE;
  IF NOT FOUND OR pay.institution_id IS DISTINCT FROM p_institution THEN
    RAISE EXCEPTION 'INSTITUTION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_event IS NOT NULL AND EXISTS (
    SELECT 1 FROM freehold.institution_provider_events WHERE payment_id = pay.id AND provider_event_id = p_event
  ) THEN
    PERFORM freehold._institution_audit(p_institution, NULLIF(who->>'userId','')::uuid, NULLIF(who->>'credentialId','')::uuid,
      'DUPLICATE_PROVIDER_EVENT', pay.id, jsonb_build_object('event', p_event, 'state', pay.state));
    RETURN jsonb_build_object('paymentId', pay.id, 'state', pay.state, 'duplicate', true, 'finality', pay.finality);
  END IF;
  IF pay.state = p_state THEN
    RETURN jsonb_build_object('paymentId', pay.id, 'state', pay.state, 'duplicate', true, 'finality', pay.finality);
  END IF;
  IF NOT freehold._institution_transition_ok(pay.state, p_state) THEN
    RAISE EXCEPTION 'INSTITUTION_STATE' USING ERRCODE = '22023';
  END IF;
  SELECT threshold_minor INTO threshold FROM freehold.institution_policies
  WHERE institution_id = p_institution AND code = 'PAYMENT_APPROVAL_MINOR';
  IF p_state = 'READY_TO_SUBMIT' AND pay.amount_minor > COALESCE(threshold, 0) THEN
    IF NULLIF(who->>'userId','')::uuid IS NULL
       OR NULLIF(who->>'userId','')::uuid IS NOT DISTINCT FROM pay.created_by
       OR NOT EXISTS (
         SELECT 1 FROM freehold.institution_members m
         WHERE m.institution_id = p_institution AND m.user_id = NULLIF(who->>'userId','')::uuid
           AND m.revoked_at IS NULL AND m.capability = 'GOVERNANCE') THEN
      RAISE EXCEPTION 'INSTITUTION_APPROVAL' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_state = 'READY_TO_SUBMIT' AND pay.state = 'VALIDATING' AND pay.amount_minor > COALESCE(threshold, 0) THEN
    RAISE EXCEPTION 'INSTITUTION_APPROVAL' USING ERRCODE = '22023';
  END IF;
  IF p_state = 'SETTLED' THEN
    secret := current_setting('freehold.bank_simulator_key', true);
    payload := pay.institution_id::text || '|' || pay.id::text || '|' || COALESCE(p_event, '') || '|' || pay.amount_minor::text || '|SETTLED';
    ok := secret IS NOT NULL AND secret <> '' AND p_signature IS NOT NULL
      AND p_signature = encode(public.hmac(payload::bytea, convert_to(secret, 'utf8'), 'sha256'), 'hex');
    IF NOT ok THEN RAISE EXCEPTION 'INSTITUTION_SIGNATURE' USING ERRCODE = '42501'; END IF;
    SELECT id INTO clearing FROM freehold.institution_ledger_accounts
    WHERE institution_id = pay.institution_id AND kind = 'CLEARING' AND currency_code = pay.currency_code
      AND legal_entity_id = pay.legal_entity_id;
    IF clearing IS NULL THEN RAISE EXCEPTION 'INSTITUTION_CLEARING_MISSING' USING ERRCODE = '22023'; END IF;
    journal := freehold._institution_post(
      pay.institution_id, pay.legal_entity_id, pay.currency_code, 'SIMULATED_SETTLEMENT', 'settle:' || pay.id::text, pay.correlation_id,
      'SIMULATED_SETTLEMENT_NOT_EXTERNAL_CASH',
      jsonb_build_array(
        jsonb_build_object('account', pay.account_id, 'side', 'DEBIT', 'amount', pay.amount_minor::text),
        jsonb_build_object('account', clearing, 'side', 'CREDIT', 'amount', pay.amount_minor::text)));
  ELSIF p_state = 'RETURNED' AND pay.state = 'SETTLED' THEN
    SELECT id INTO clearing FROM freehold.institution_ledger_accounts
    WHERE institution_id = pay.institution_id AND kind = 'CLEARING' AND currency_code = pay.currency_code
      AND legal_entity_id = pay.legal_entity_id;
    journal := freehold._institution_post(
      pay.institution_id, pay.legal_entity_id, pay.currency_code, 'SIMULATED_RETURN', 'return:' || pay.id::text, pay.correlation_id,
      'SIMULATED_RETURN_NOT_A_LEDGER_REVERSAL_OF_THE_CUSTOMER_JOURNAL',
      jsonb_build_array(
        jsonb_build_object('account', clearing, 'side', 'DEBIT', 'amount', pay.amount_minor::text),
        jsonb_build_object('account', pay.account_id, 'side', 'CREDIT', 'amount', pay.amount_minor::text)));
  END IF;
  PERFORM set_config('freehold.institution_writer', 'on', true);
  UPDATE freehold.institution_payments SET
    state = p_state,
    finality = freehold._institution_finality(p_state),
    signature_ok = CASE WHEN p_state = 'SETTLED' THEN ok ELSE signature_ok END,
    settlement_journal_id = CASE WHEN p_state = 'SETTLED' THEN journal ELSE settlement_journal_id END,
    reversal_journal_id = CASE WHEN p_state = 'RETURNED' AND pay.state = 'SETTLED' THEN journal ELSE reversal_journal_id END
  WHERE id = pay.id;
  IF p_event IS NOT NULL THEN
    INSERT INTO freehold.institution_provider_events(institution_id, payment_id, provider_event_id, state, signature_ok)
    VALUES (pay.institution_id, pay.id, p_event, p_state, ok);
  END IF;
  event_name := CASE p_state
    WHEN 'SETTLED' THEN 'payment.settled'
    WHEN 'UNKNOWN' THEN 'payment.unknown'
    WHEN 'RETURNED' THEN 'payment.returned'
    WHEN 'FAILED' THEN 'payment.failed'
    WHEN 'REJECTED' THEN 'payment.rejected'
    WHEN 'ACKNOWLEDGED' THEN 'payment.acknowledged'
    WHEN 'SUBMITTED' THEN 'payment.submitted'
    WHEN 'CANCELLED' THEN 'payment.cancelled'
    ELSE 'payment.updated'
  END;
  PERFORM freehold._institution_emit(pay.institution_id, pay.id, event_name,
    jsonb_build_object('paymentId', pay.id, 'state', p_state, 'finality', freehold._institution_finality(p_state), 'amountMinor', pay.amount_minor::text));
  PERFORM freehold._institution_audit(pay.institution_id, NULLIF(who->>'userId','')::uuid, NULLIF(who->>'credentialId','')::uuid,
    'PAYMENT_' || p_state, pay.id, jsonb_build_object('from', pay.state, 'journal', journal));
  RETURN jsonb_build_object(
    'paymentId', pay.id, 'state', p_state, 'finality', freehold._institution_finality(p_state),
    'duplicate', false, 'liveSubmission', false, 'externalSettlement', false);
END $$;

CREATE FUNCTION freehold.institution_risk_run(p_actor uuid, p_institution uuid, p_scenario text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE
  before_sum bigint;
  after_sum bigint;
  customer_minor bigint;
  reserve_minor bigint;
  unsettled bigint;
  demand_bps integer;
  haircut_bps integer := 0;
  available bigint;
  demand bigint;
  largest bigint := 0;
  largest_label text;
  limit_bps bigint;
  result jsonb;
  assumptions jsonb;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'treasury:read');
  IF p_scenario NOT IN (
    'NORMAL_REDEMPTION','ELEVATED_REDEMPTION','LARGE_REDEMPTION_SHOCK','CUSTODIAN_OUTAGE',
    'SETTLEMENT_DELAY','RESERVE_INELIGIBILITY','MARKET_VALUE_DECLINE','COUNTERPARTY_DEFAULT') THEN
    RAISE EXCEPTION 'INSTITUTION_SCENARIO' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(sum(balance_minor), 0) INTO before_sum FROM freehold.institution_ledger_accounts WHERE institution_id = p_institution;
  SELECT COALESCE(sum(balance_minor), 0) INTO customer_minor FROM freehold.institution_ledger_accounts
  WHERE institution_id = p_institution AND kind = 'CUSTOMER';
  SELECT COALESCE(sum(balance_minor), 0) INTO reserve_minor FROM freehold.institution_ledger_accounts
  WHERE institution_id = p_institution AND kind = 'RESERVE';
  SELECT COALESCE(sum(amount_minor), 0) INTO unsettled FROM freehold.institution_payments
  WHERE institution_id = p_institution AND state IN ('SUBMITTED','ACKNOWLEDGED','PENDING_SETTLEMENT','UNKNOWN');
  demand_bps := CASE p_scenario
    WHEN 'NORMAL_REDEMPTION' THEN 500
    WHEN 'ELEVATED_REDEMPTION' THEN 2500
    WHEN 'LARGE_REDEMPTION_SHOCK' THEN 8000
    ELSE 0 END;
  IF p_scenario = 'MARKET_VALUE_DECLINE' THEN haircut_bps := 2000; END IF;
  available := CASE
    WHEN p_scenario IN ('CUSTODIAN_OUTAGE','RESERVE_INELIGIBILITY') THEN 0
    WHEN p_scenario = 'MARKET_VALUE_DECLINE' THEN reserve_minor * (10000 - haircut_bps) / 10000
    ELSE reserve_minor END;
  demand := customer_minor * demand_bps / 10000;
  SELECT threshold_minor INTO limit_bps FROM freehold.institution_policies
  WHERE institution_id = p_institution AND code = 'CUSTODIAN_CONCENTRATION_BPS';
  SELECT COALESCE(sum(balance_minor), 0), custodian_label INTO largest, largest_label
  FROM freehold.institution_ledger_accounts
  WHERE institution_id = p_institution AND kind = 'RESERVE' AND custodian_label IS NOT NULL
  GROUP BY custodian_label ORDER BY sum(balance_minor) DESC LIMIT 1;
  IF p_scenario = 'COUNTERPARTY_DEFAULT' THEN available := GREATEST(available - COALESCE(largest, 0), 0); END IF;
  assumptions := jsonb_build_object(
    'demandBasisPoints', demand_bps,
    'haircutBasisPoints', haircut_bps,
    'concentrationLimitBasisPoints', COALESCE(limit_bps, 10000),
    'note', 'Scenario output is not a regulatory liquidity or capital determination.');
  result := jsonb_build_object(
    'customerMinor', customer_minor::text,
    'scenarioDemandMinor', demand::text,
    'reserveAvailableMinor', available::text,
    'unsettledMinor', CASE WHEN p_scenario = 'SETTLEMENT_DELAY' THEN unsettled::text ELSE '0' END,
    'gapMinor', (available - demand - CASE WHEN p_scenario = 'SETTLEMENT_DELAY' THEN unsettled ELSE 0 END)::text,
    'largestCustodian', largest_label,
    'largestCustodianMinor', COALESCE(largest, 0)::text,
    'concentrationBreach', reserve_minor > 0 AND COALESCE(largest, 0) * 10000 / reserve_minor > COALESCE(limit_bps, 10000),
    'externalEvidence', 'EXTERNAL_UNAVAILABLE',
    'mutatedAccounts', false,
    'regulatoryDetermination', false);
  INSERT INTO freehold.institution_risk_runs(institution_id, scenario, assumptions, result)
  VALUES (p_institution, p_scenario, assumptions, result);
  SELECT COALESCE(sum(balance_minor), 0) INTO after_sum FROM freehold.institution_ledger_accounts WHERE institution_id = p_institution;
  IF before_sum IS DISTINCT FROM after_sum THEN RAISE EXCEPTION 'INSTITUTION_RISK_MUTATION' USING ERRCODE = '55000'; END IF;
  RETURN result || jsonb_build_object('scenario', p_scenario, 'assumptions', assumptions);
END $$;

CREATE FUNCTION freehold.institution_webhook_open(p_actor uuid, p_institution uuid, p_url text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE secret text; endpoint uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'webhooks:write');
  secret := encode(public.gen_random_bytes(32), 'hex');
  INSERT INTO freehold.institution_webhook_endpoints(institution_id, url, secret_hash)
  VALUES (p_institution, p_url, encode(public.digest(secret, 'sha256'), 'hex'))
  RETURNING id INTO endpoint;
  PERFORM freehold._institution_audit(p_institution, p_actor, NULL, 'WEBHOOK_OPEN', endpoint, jsonb_build_object('secretStored', false));
  RETURN jsonb_build_object('endpointId', endpoint, 'secret', secret, 'secretShownOnce', true, 'deliveryGuarantee', 'AT_LEAST_ONCE_ATTEMPT_NOT_EXACTLY_ONCE');
END $$;

CREATE FUNCTION freehold.institution_webhook_subscribe(p_actor uuid, p_institution uuid, p_endpoint uuid, p_event text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE owner uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'webhooks:write');
  SELECT institution_id INTO owner FROM freehold.institution_webhook_endpoints WHERE id = p_endpoint;
  IF owner IS DISTINCT FROM p_institution THEN RAISE EXCEPTION 'INSTITUTION_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  INSERT INTO freehold.institution_webhook_subscriptions(endpoint_id, event_type) VALUES (p_endpoint, p_event)
  ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('endpointId', p_endpoint, 'eventType', p_event);
END $$;

CREATE FUNCTION freehold.institution_webhook_attempt(
  p_actor uuid, p_institution uuid, p_delivery uuid, p_outcome text, p_secret text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE
  delivery freehold.institution_webhook_deliveries;
  event freehold.institution_webhook_events;
  endpoint freehold.institution_webhook_endpoints;
  payload text;
  sig text;
  ok boolean;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'webhooks:write');
  SELECT * INTO delivery FROM freehold.institution_webhook_deliveries WHERE id = p_delivery FOR UPDATE;
  SELECT * INTO event FROM freehold.institution_webhook_events WHERE id = delivery.event_id;
  SELECT * INTO endpoint FROM freehold.institution_webhook_endpoints WHERE id = delivery.endpoint_id;
  IF event.institution_id IS DISTINCT FROM p_institution OR endpoint.institution_id IS DISTINCT FROM p_institution THEN
    RAISE EXCEPTION 'INSTITUTION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF delivery.state = 'DELIVERED_SIMULATED' THEN
    RETURN jsonb_build_object('deliveryId', delivery.id, 'state', delivery.state, 'duplicate', true);
  END IF;
  IF delivery.state = 'DEAD' THEN RAISE EXCEPTION 'INSTITUTION_DEAD_LETTER' USING ERRCODE = '55000'; END IF;
  IF p_outcome = 'DELIVERED_SIMULATED' THEN
    payload := event.id::text || '|' || event.event_type || '|' || event.body::text;
    ok := p_secret IS NOT NULL AND encode(public.digest(p_secret, 'sha256'), 'hex') = endpoint.secret_hash;
    IF NOT ok THEN RAISE EXCEPTION 'INSTITUTION_SIGNATURE' USING ERRCODE = '42501'; END IF;
    sig := encode(public.hmac(payload::bytea, convert_to(p_secret, 'utf8'), 'sha256'), 'hex');
    IF sig IS NULL OR sig = '' THEN RAISE EXCEPTION 'INSTITUTION_SIGNATURE' USING ERRCODE = '42501'; END IF;
    UPDATE freehold.institution_webhook_deliveries
    SET state = 'DELIVERED_SIMULATED', attempts = attempts + 1 WHERE id = delivery.id;
    RETURN jsonb_build_object(
      'deliveryId', delivery.id, 'state', 'DELIVERED_SIMULATED', 'duplicate', false,
      'signature', sig, 'exactlyOnce', false, 'deliveryGuarantee', 'AT_LEAST_ONCE_ATTEMPT_NOT_EXACTLY_ONCE');
  END IF;
  IF p_outcome NOT IN ('FAILED','TIMEOUT') THEN RAISE EXCEPTION 'INSTITUTION_STATE' USING ERRCODE = '22023'; END IF;
  IF delivery.attempts + 1 >= 3 THEN
    UPDATE freehold.institution_webhook_deliveries SET state = 'DEAD', attempts = attempts + 1 WHERE id = delivery.id;
    RETURN jsonb_build_object('deliveryId', delivery.id, 'state', 'DEAD', 'exactlyOnce', false);
  END IF;
  UPDATE freehold.institution_webhook_deliveries SET state = p_outcome, attempts = attempts + 1 WHERE id = delivery.id;
  RETURN jsonb_build_object('deliveryId', delivery.id, 'state', p_outcome, 'attempts', delivery.attempts + 1, 'exactlyOnce', false);
END $$;

CREATE FUNCTION freehold.institution_dispute_open(
  p_actor uuid, p_institution uuid, p_payment uuid, p_note text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE pay_inst uuid; dispute uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'compliance:write');
  IF p_payment IS NOT NULL THEN
    SELECT institution_id INTO pay_inst FROM freehold.institution_payments WHERE id = p_payment;
    IF pay_inst IS DISTINCT FROM p_institution THEN RAISE EXCEPTION 'INSTITUTION_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  END IF;
  INSERT INTO freehold.institution_disputes(institution_id, payment_id, state, opened_by)
  VALUES (p_institution, p_payment, 'OPEN', p_actor) RETURNING id INTO dispute;
  INSERT INTO freehold.institution_dispute_notes(dispute_id, author_id, note) VALUES (dispute, p_actor, p_note);
  PERFORM freehold._institution_audit(p_institution, p_actor, NULL, 'DISPUTE_OPEN', dispute, jsonb_build_object('regulationE', false, 'legalRegime', 'NOT_DETERMINED'));
  RETURN jsonb_build_object('disputeId', dispute, 'state', 'OPEN', 'legalRegime', 'NOT_DETERMINED', 'ledgerReversed', false);
END $$;

CREATE FUNCTION freehold.institution_dispute_note(p_actor uuid, p_institution uuid, p_dispute uuid, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE owner uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'compliance:write');
  SELECT institution_id INTO owner FROM freehold.institution_disputes WHERE id = p_dispute;
  IF owner IS DISTINCT FROM p_institution THEN RAISE EXCEPTION 'INSTITUTION_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  INSERT INTO freehold.institution_dispute_notes(dispute_id, author_id, note) VALUES (p_dispute, p_actor, p_note);
  RETURN jsonb_build_object('disputeId', p_dispute, 'appended', true);
END $$;

CREATE FUNCTION freehold.institution_dispute_resolve(
  p_actor uuid, p_institution uuid, p_dispute uuid, p_state text, p_resolution text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE row freehold.institution_disputes;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'governance:write');
  SELECT * INTO row FROM freehold.institution_disputes WHERE id = p_dispute;
  IF row.institution_id IS DISTINCT FROM p_institution THEN RAISE EXCEPTION 'INSTITUTION_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  IF p_state NOT IN ('EVIDENCE','ASSIGNED','ESCALATED','RESOLVED') THEN RAISE EXCEPTION 'INSTITUTION_STATE' USING ERRCODE = '22023'; END IF;
  IF p_state = 'RESOLVED' AND p_actor = row.opened_by THEN RAISE EXCEPTION 'INSTITUTION_SELF_APPROVAL' USING ERRCODE = '22023'; END IF;
  UPDATE freehold.institution_disputes SET
    state = p_state,
    investigator_id = CASE WHEN p_state IN ('ASSIGNED','ESCALATED','RESOLVED') THEN p_actor ELSE investigator_id END,
    resolution = CASE WHEN p_state = 'RESOLVED' THEN p_resolution ELSE resolution END
  WHERE id = p_dispute;
  RETURN jsonb_build_object('disputeId', p_dispute, 'state', p_state, 'ledgerReversed', false, 'legalRegime', 'NOT_DETERMINED');
END $$;

CREATE FUNCTION freehold.institution_adjustment_propose(
  p_actor uuid, p_institution uuid, p_dispute uuid, p_debit uuid, p_credit uuid, p_amount bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE d freehold.institution_ledger_accounts; c freehold.institution_ledger_accounts; adj uuid; customer_journals bigint;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'governance:write');
  SELECT * INTO d FROM freehold.institution_ledger_accounts WHERE id = p_debit;
  SELECT * INTO c FROM freehold.institution_ledger_accounts WHERE id = p_credit;
  IF d.institution_id IS DISTINCT FROM p_institution OR c.institution_id IS DISTINCT FROM p_institution
     OR d.currency_code IS DISTINCT FROM c.currency_code OR d.legal_entity_id IS DISTINCT FROM c.legal_entity_id THEN
    RAISE EXCEPTION 'INSTITUTION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO customer_journals FROM freehold.ledger_journals;
  INSERT INTO freehold.institution_adjustments(
    institution_id, dispute_id, template_code, debit_account_id, credit_account_id, amount_minor, state, proposed_by)
  VALUES (p_institution, p_dispute, 'TREASURY_COMPENSATING_PAIR', p_debit, p_credit, p_amount, 'PROPOSED', p_actor)
  RETURNING id INTO adj;
  RETURN jsonb_build_object('adjustmentId', adj, 'state', 'PROPOSED', 'customerJournals', customer_journals::text, 'template', 'TREASURY_COMPENSATING_PAIR');
END $$;

CREATE FUNCTION freehold.institution_adjustment_post(p_actor uuid, p_institution uuid, p_adjustment uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE adj freehold.institution_adjustments; d freehold.institution_ledger_accounts; journal uuid; journals bigint;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'governance:write');
  SELECT * INTO adj FROM freehold.institution_adjustments WHERE id = p_adjustment FOR UPDATE;
  IF adj.institution_id IS DISTINCT FROM p_institution THEN RAISE EXCEPTION 'INSTITUTION_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  IF adj.state <> 'PROPOSED' THEN RAISE EXCEPTION 'INSTITUTION_STATE' USING ERRCODE = '22023'; END IF;
  IF p_actor = adj.proposed_by THEN RAISE EXCEPTION 'INSTITUTION_SELF_APPROVAL' USING ERRCODE = '22023'; END IF;
  SELECT * INTO d FROM freehold.institution_ledger_accounts WHERE id = adj.debit_account_id;
  SELECT count(*) INTO journals FROM freehold.ledger_journals;
  journal := freehold._institution_post(
    p_institution, d.legal_entity_id, d.currency_code, 'COMPENSATING_ADJUSTMENT', 'adjust:' || adj.id::text, gen_random_uuid(),
    'AUTHORIZED_COMPENSATING_PAIR_NOT_A_CUSTOMER_LEDGER_REVERSAL',
    jsonb_build_array(
      jsonb_build_object('account', adj.debit_account_id, 'side', 'DEBIT', 'amount', adj.amount_minor::text),
      jsonb_build_object('account', adj.credit_account_id, 'side', 'CREDIT', 'amount', adj.amount_minor::text)));
  UPDATE freehold.institution_adjustments SET state = 'POSTED', posted_by = p_actor, journal_id = journal WHERE id = adj.id;
  IF (SELECT count(*) FROM freehold.ledger_journals) <> journals THEN
    RAISE EXCEPTION 'INSTITUTION_CUSTOMER_LEDGER' USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object('adjustmentId', adj.id, 'state', 'POSTED', 'journalId', journal, 'customerLedgerUnchanged', true);
END $$;

CREATE FUNCTION freehold.institution_billing_plan(
  p_actor uuid, p_institution uuid, p_monthly bigint, p_api bigint, p_tx bigint, p_compliance bigint, p_report bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'governance:write');
  INSERT INTO freehold.institution_price_plans(institution_id, monthly_minor, api_call_minor, transaction_minor, compliance_minor, report_minor)
  VALUES (p_institution, p_monthly, p_api, p_tx, p_compliance, p_report)
  ON CONFLICT (institution_id) DO UPDATE SET
    monthly_minor = EXCLUDED.monthly_minor, api_call_minor = EXCLUDED.api_call_minor,
    transaction_minor = EXCLUDED.transaction_minor, compliance_minor = EXCLUDED.compliance_minor,
    report_minor = EXCLUDED.report_minor;
  RETURN jsonb_build_object('institutionId', p_institution, 'collected', false, 'separateFromReserves', true);
END $$;

CREATE FUNCTION freehold.institution_usage_record(
  p_actor uuid, p_institution uuid, p_period date, p_meter text, p_quantity bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'billing:read');
  INSERT INTO freehold.institution_usage_records(institution_id, period_start, meter, quantity)
  VALUES (p_institution, p_period, p_meter, p_quantity);
  RETURN jsonb_build_object('meter', p_meter, 'quantity', p_quantity::text);
END $$;

CREATE FUNCTION freehold.institution_invoice_draft(p_actor uuid, p_key text, p_hash text, p_nonce text, p_institution uuid, p_period date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE
  plan freehold.institution_price_plans;
  invoice uuid;
  total bigint := 0;
  qty bigint;
  amount bigint;
  meter_code text;
  unit_rate bigint;
BEGIN
  PERFORM freehold._institution_actor(p_actor, p_key, p_hash, p_nonce, p_institution, 'billing:read');
  SELECT * INTO plan FROM freehold.institution_price_plans WHERE institution_id = p_institution;
  IF NOT FOUND THEN RAISE EXCEPTION 'INSTITUTION_BILLING' USING ERRCODE = '22023'; END IF;
  INSERT INTO freehold.institution_invoices(institution_id, period_start, total_minor)
  VALUES (p_institution, p_period, 0)
  ON CONFLICT (institution_id, period_start) DO UPDATE SET total_minor = 0
  RETURNING id INTO invoice;
  DELETE FROM freehold.institution_invoice_lines WHERE invoice_id = invoice;
  total := plan.monthly_minor;
  INSERT INTO freehold.institution_invoice_lines(invoice_id, meter, quantity, amount_minor)
  VALUES (invoice, 'MONTHLY', 1, plan.monthly_minor);
  FOR meter_code, unit_rate IN
    SELECT rates.meter_code, rates.unit_rate FROM (VALUES
      ('API_CALL', plan.api_call_minor),
      ('TRANSACTION', plan.transaction_minor),
      ('COMPLIANCE_TOOL', plan.compliance_minor),
      ('REPORT', plan.report_minor),
      ('TENANT', 0::bigint)) AS rates(meter_code, unit_rate)
  LOOP
    SELECT COALESCE(sum(usage.quantity), 0) INTO qty FROM freehold.institution_usage_records AS usage
    WHERE usage.institution_id = p_institution AND usage.period_start = p_period AND usage.meter = meter_code;
    IF qty > 0 AND unit_rate > 0 AND (qty * unit_rate) / qty IS DISTINCT FROM unit_rate THEN
      RAISE EXCEPTION 'INSTITUTION_BILLING' USING ERRCODE = '22023';
    END IF;
    amount := qty * unit_rate;
    total := total + amount;
    IF qty > 0 THEN
      INSERT INTO freehold.institution_invoice_lines(invoice_id, meter, quantity, amount_minor) VALUES (invoice, meter_code, qty, amount);
    END IF;
  END LOOP;
  SELECT COALESCE(sum(quantity), 0) INTO qty FROM freehold.institution_usage_records
  WHERE institution_id = p_institution AND period_start = p_period AND meter = 'CREDIT';
  IF qty > 0 THEN
    total := total - qty;
    INSERT INTO freehold.institution_invoice_lines(invoice_id, meter, quantity, amount_minor) VALUES (invoice, 'CREDIT', qty, -qty);
  END IF;
  UPDATE freehold.institution_invoices SET total_minor = total WHERE id = invoice;
  RETURN jsonb_build_object('invoiceId', invoice, 'totalMinor', total::text, 'state', 'SIMULATED_DRAFT', 'collected', false, 'separateFromCustomerBalances', true);
END $$;

CREATE FUNCTION freehold.institution_compliance_open(p_actor uuid, p_institution uuid, p_subject text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE cid uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'compliance:write');
  INSERT INTO freehold.institution_compliance_cases(institution_id, subject_ref, opened_by)
  VALUES (p_institution, p_subject, p_actor) RETURNING id INTO cid;
  RETURN jsonb_build_object('caseId', cid, 'state', 'NOT_A_BSA_PROGRAM', 'isDispute', false, 'isIncident', false);
END $$;

CREATE FUNCTION freehold.institution_issuance_link(p_actor uuid, p_institution uuid, p_issuance uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE supply bigint;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'payments:read');
  IF NOT EXISTS (SELECT 1 FROM freehold.issuance_operations WHERE id = p_issuance) THEN
    RAISE EXCEPTION 'INSTITUTION_ISSUANCE' USING ERRCODE = '22023';
  END IF;
  INSERT INTO freehold.institution_issuance_links(institution_id, issuance_id, linked_by)
  VALUES (p_institution, p_issuance, p_actor)
  ON CONFLICT DO NOTHING;
  SELECT outstanding INTO supply FROM freehold.monetary_supply WHERE book_id = '20000000-0000-4000-8000-000000000001';
  RETURN jsonb_build_object('issuanceId', p_issuance, 'supplyUnchanged', supply::text, 'addedToSupply', false);
END $$;

CREATE FUNCTION freehold.institution_list(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE body jsonb;
BEGIN
  PERFORM freehold._require_bound_session(p_actor);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'institutionId', i.id, 'code', i.code, 'legalName', i.legal_name, 'status', i.status, 'liveAuthorized', i.live_authorized
  ) ORDER BY i.code), '[]'::jsonb) INTO body
  FROM freehold.institutions i
  JOIN freehold.institution_members m ON m.institution_id = i.id AND m.user_id = p_actor AND m.revoked_at IS NULL;
  RETURN jsonb_build_object('institutions', body, 'simulationOnly', true);
END $$;

CREATE FUNCTION freehold.institution_health(p_actor uuid, p_institution uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'reports:read');
  RETURN jsonb_build_object(
    'pendingOutbox', (SELECT count(*) FROM freehold.institution_outbox WHERE institution_id = p_institution AND state IN ('PENDING','LEASED'))::text,
    'deadWebhooks', (SELECT count(*) FROM freehold.institution_webhook_deliveries d
      JOIN freehold.institution_webhook_events e ON e.id = d.event_id
      WHERE e.institution_id = p_institution AND d.state = 'DEAD')::text,
    'unknownPayments', (SELECT count(*) FROM freehold.institution_payments WHERE institution_id = p_institution AND state = 'UNKNOWN')::text,
    'liveRails', false);
END $$;

CREATE FUNCTION freehold.institution_activate_live(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'LIVE_MONETARY_ACTIVATION_REFUSED' USING ERRCODE = '42501';
END $$;

CREATE FUNCTION freehold.institution_webhook_rotate(p_actor uuid, p_institution uuid, p_endpoint uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE secret text; owner uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'webhooks:write');
  SELECT institution_id INTO owner FROM freehold.institution_webhook_endpoints WHERE id = p_endpoint AND active;
  IF owner IS DISTINCT FROM p_institution THEN RAISE EXCEPTION 'INSTITUTION_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  secret := encode(public.gen_random_bytes(32), 'hex');
  UPDATE freehold.institution_webhook_endpoints
  SET secret_hash = encode(public.digest(secret, 'sha256'), 'hex')
  WHERE id = p_endpoint AND institution_id = p_institution;
  PERFORM freehold._institution_audit(p_institution, p_actor, NULL, 'WEBHOOK_ROTATE', p_endpoint, jsonb_build_object('previousSecretRetained', false));
  RETURN jsonb_build_object('endpointId', p_endpoint, 'secret', secret, 'secretShownOnce', true, 'previousSecretRetained', false);
END $$;

CREATE FUNCTION freehold.institution_billing_forecast(p_actor uuid, p_institution uuid, p_factor bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE total bigint := 0; forecast bigint;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'billing:read');
  IF p_factor < 0 OR p_factor > 100000 THEN RAISE EXCEPTION 'INSTITUTION_BILLING' USING ERRCODE = '22023'; END IF;
  SELECT i.total_minor INTO total FROM freehold.institution_invoices i
  WHERE i.institution_id = p_institution ORDER BY i.period_start DESC LIMIT 1;
  IF total IS NULL THEN total := 0; END IF;
  IF p_factor > 0 AND total > 0 AND (total * p_factor) / p_factor IS DISTINCT FROM total THEN
    RAISE EXCEPTION 'INSTITUTION_BILLING' USING ERRCODE = '22003';
  END IF;
  forecast := total * p_factor / 10000;
  RETURN jsonb_build_object(
    'forecastMinor', forecast::text, 'basis', CASE WHEN total = 0 THEN 'NONE' ELSE 'LAST_SIMULATED_INVOICE' END,
    'factorBasisPoints', p_factor::text, 'inventedCustomers', false, 'collected', false, 'separateFromReserves', true);
END $$;

CREATE FUNCTION freehold.institution_outbox_claim(p_worker uuid, p_lease_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE claimed integer; ids jsonb;
BEGIN
  WITH picked AS (
    SELECT id FROM freehold.institution_outbox
    WHERE state = 'PENDING' OR (state = 'LEASED' AND lease_until < clock_timestamp())
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 20
  ), upd AS (
    UPDATE freehold.institution_outbox o SET
      state = 'LEASED',
      attempts = o.attempts + 1,
      claimed_by = p_worker,
      lease_until = CASE WHEN p_lease_seconds <= 0 THEN clock_timestamp() - interval '1 second'
                         ELSE clock_timestamp() + make_interval(secs => p_lease_seconds) END
    FROM picked WHERE o.id = picked.id
    RETURNING o.id
  )
  SELECT count(*)::int, COALESCE(jsonb_agg(id), '[]'::jsonb) INTO claimed, ids FROM upd;
  RETURN jsonb_build_object('claimed', claimed, 'ids', ids, 'postsPayments', false);
END $$;

CREATE FUNCTION freehold.institution_outbox_complete(p_worker uuid, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE before_count bigint; after_count bigint; updated integer;
BEGIN
  SELECT count(*) INTO before_count FROM freehold.institution_payments;
  UPDATE freehold.institution_outbox SET state = 'DONE', lease_until = NULL
  WHERE id = p_id AND state = 'LEASED' AND claimed_by = p_worker;
  GET DIAGNOSTICS updated = ROW_COUNT;
  SELECT count(*) INTO after_count FROM freehold.institution_payments;
  IF before_count IS DISTINCT FROM after_count THEN RAISE EXCEPTION 'INSTITUTION_OUTBOX' USING ERRCODE = '55000'; END IF;
  RETURN jsonb_build_object('outboxId', p_id, 'done', updated = 1, 'paymentRowsUnchanged', true);
END $$;

REVOKE ALL ON FUNCTION freehold._institution_signed(text, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._institution_scope_ok(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._institution_audit(uuid, uuid, uuid, text, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._institution_rate(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._institution_actor(uuid, text, text, text, uuid, text) FROM PUBLIC, freehold_api;
REVOKE ALL ON FUNCTION freehold._institution_entity_ok(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._institution_post(uuid, uuid, text, text, text, uuid, text, jsonb) FROM PUBLIC, freehold_api;
REVOKE ALL ON FUNCTION freehold._institution_finality(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._institution_transition_ok(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._institution_emit(uuid, uuid, text, jsonb) FROM PUBLIC, freehold_api;
REVOKE EXECUTE ON FUNCTION freehold._institution_signed(text, text, bigint) FROM freehold_verifier;
REVOKE EXECUTE ON FUNCTION freehold._institution_post(uuid, uuid, text, text, text, uuid, text, jsonb) FROM freehold_verifier;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'institution_open(uuid,text,text)',
    'institution_grant(uuid,uuid,uuid,text)',
    'institution_policy_set(uuid,uuid,text,bigint)',
    'institution_credential_issue(uuid,uuid,text[],integer)',
    'institution_credential_revoke(uuid,uuid,text)',
    'institution_customer_open(uuid,uuid,text,text,text)',
    'institution_fund_simulated(uuid,uuid,uuid,bigint,text,uuid)',
    'institution_transfer(uuid,text,text,text,uuid,uuid,uuid,bigint,text,uuid)',
    'institution_account_get(uuid,text,text,text,uuid,uuid)',
    'institution_activity(uuid,uuid,uuid)',
    'institution_treasury_open(uuid,uuid,text,text,text)',
    'institution_treasury_report(uuid,text,text,text,uuid)',
    'institution_payment_open(uuid,text,text,text,uuid,uuid,bigint,text,text,text,uuid)',
    'institution_payment_transition(uuid,text,text,text,uuid,uuid,text,text,text)',
    'institution_risk_run(uuid,uuid,text)',
    'institution_webhook_open(uuid,uuid,text)',
    'institution_webhook_subscribe(uuid,uuid,uuid,text)',
    'institution_webhook_attempt(uuid,uuid,uuid,text,text)',
    'institution_dispute_open(uuid,uuid,uuid,text)',
    'institution_dispute_note(uuid,uuid,uuid,text)',
    'institution_dispute_resolve(uuid,uuid,uuid,text,text)',
    'institution_adjustment_propose(uuid,uuid,uuid,uuid,uuid,bigint)',
    'institution_adjustment_post(uuid,uuid,uuid)',
    'institution_billing_plan(uuid,uuid,bigint,bigint,bigint,bigint,bigint)',
    'institution_usage_record(uuid,uuid,date,text,bigint)',
    'institution_invoice_draft(uuid,text,text,text,uuid,date)',
    'institution_compliance_open(uuid,uuid,text)',
    'institution_issuance_link(uuid,uuid,uuid)',
    'institution_list(uuid)',
    'institution_health(uuid,uuid)',
    'institution_activate_live(uuid)',
    'institution_webhook_rotate(uuid,uuid,uuid)',
    'institution_billing_forecast(uuid,uuid,bigint)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION freehold.%s FROM PUBLIC, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION freehold.%s TO freehold_api', fn);
  END LOOP;
  EXECUTE 'REVOKE ALL ON FUNCTION freehold.institution_outbox_claim(uuid, integer) FROM PUBLIC, freehold_api, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup';
  EXECUTE 'REVOKE ALL ON FUNCTION freehold.institution_outbox_complete(uuid, uuid) FROM PUBLIC, freehold_api, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup';
  EXECUTE 'GRANT EXECUTE ON FUNCTION freehold.institution_outbox_claim(uuid, integer) TO freehold_worker';
  EXECUTE 'GRANT EXECUTE ON FUNCTION freehold.institution_outbox_complete(uuid, uuid) TO freehold_worker';
END $$;

-- Default function ACLs grant EXECUTE to PUBLIC. ALTER DEFAULT PRIVILEGES
-- REVOKE does not materialize a denial on this server, so a blanket revoke
-- is required. Named grants to freehold_api and freehold_worker stay.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA freehold FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._institution_guard() FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._institution_no_delete() FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._institution_journal_balanced() FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;

GRANT SELECT ON
  freehold.institutions, freehold.institution_members, freehold.institution_credentials, freehold.institution_customers,
  freehold.institution_ledger_accounts, freehold.institution_journals, freehold.institution_entries, freehold.institution_payments,
  freehold.institution_provider_events, freehold.institution_outbox, freehold.institution_webhook_endpoints,
  freehold.institution_webhook_subscriptions, freehold.institution_webhook_events, freehold.institution_webhook_deliveries,
  freehold.institution_disputes, freehold.institution_dispute_notes, freehold.institution_adjustments, freehold.institution_policies,
  freehold.institution_risk_runs, freehold.institution_price_plans, freehold.institution_usage_records, freehold.institution_invoices,
  freehold.institution_invoice_lines, freehold.institution_compliance_cases, freehold.institution_audit, freehold.institution_nonces,
  freehold.institution_rate_buckets, freehold.institution_issuance_links
TO freehold_verifier;

RESET ROLE;
