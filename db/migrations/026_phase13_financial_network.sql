-- Phase 13. Forward only. Migrations 001 through 025 are not edited.
-- A simulated network of institutional tenants. Not a licensed payment system.
-- Messages do not move money. Journals post only when a cycle reaches FINAL
-- under the simulated finality rule. External settlement stays unavailable.
-- Row level security stays off so the verifier can read every tenant.
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;

CREATE TABLE freehold.network_rulebooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_label text NOT NULL UNIQUE CHECK (version_label ~ '^[a-z0-9.-]{3,40}$'),
  body jsonb NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ADOPTED')),
  proposed_by uuid NOT NULL REFERENCES freehold.users(id),
  adopted_by uuid REFERENCES freehold.users(id),
  simulation_only boolean NOT NULL DEFAULT true CHECK (simulation_only),
  enforceable_clearing_agreement boolean NOT NULL DEFAULT false CHECK (NOT enforceable_clearing_agreement),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (status <> 'ADOPTED' OR (adopted_by IS NOT NULL AND adopted_by <> proposed_by))
);

CREATE TABLE freehold.network_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL UNIQUE REFERENCES freehold.institutions(id),
  status text NOT NULL CHECK (status IN (
    'APPLICANT','UNDER_REVIEW','APPROVED_FOR_SIMULATION','ACTIVE_SIMULATION','SUSPENDED','TERMINATED')),
  risk_class text NOT NULL DEFAULT 'SIMULATED_STANDARD' CHECK (risk_class IN ('SIMULATED_STANDARD','SIMULATED_ELEVATED')),
  permitted_services text[] NOT NULL DEFAULT ARRAY['CUSTOMER_CREDIT']::text[],
  currencies text[] NOT NULL DEFAULT ARRAY['USD']::text[],
  instruments text[] NOT NULL DEFAULT ARRAY['CREDIT_TRANSFER']::text[],
  participation_limit_minor bigint NOT NULL DEFAULT 1000000000000 CHECK (participation_limit_minor >= 0),
  opening_liquidity_minor bigint NOT NULL DEFAULT 0 CHECK (opening_liquidity_minor >= 0),
  settlement_capacity_minor bigint NOT NULL DEFAULT 0 CHECK (settlement_capacity_minor >= 0),
  net_debit_limit_minor bigint NOT NULL DEFAULT 0 CHECK (net_debit_limit_minor >= 0),
  liquidity_currency text NOT NULL DEFAULT 'USD',
  settlement_account_id uuid REFERENCES freehold.institution_ledger_accounts(id),
  rulebook_id uuid REFERENCES freehold.network_rulebooks(id),
  applied_by uuid NOT NULL REFERENCES freehold.users(id),
  reviewed_by uuid REFERENCES freehold.users(id),
  activated_by uuid REFERENCES freehold.users(id),
  suspended_by uuid REFERENCES freehold.users(id),
  licensed_claim boolean NOT NULL DEFAULT false CHECK (NOT licensed_claim),
  live_authorized boolean NOT NULL DEFAULT false CHECK (NOT live_authorized),
  simulation_only boolean NOT NULL DEFAULT true CHECK (simulation_only),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE freehold.network_rulebook_acceptances (
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  rulebook_id uuid NOT NULL REFERENCES freehold.network_rulebooks(id),
  accepted_by uuid NOT NULL REFERENCES freehold.users(id),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (institution_id, rulebook_id)
);

CREATE TABLE freehold.network_member_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid REFERENCES freehold.network_members(id),
  institution_id uuid REFERENCES freehold.institutions(id),
  actor_id uuid NOT NULL,
  action text NOT NULL,
  from_status text,
  to_status text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE freehold.network_certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  algorithm text NOT NULL CHECK (algorithm = 'ED25519'),
  public_key_hex text NOT NULL CHECK (public_key_hex ~ '^[0-9a-f]{64}$'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  not_before timestamptz NOT NULL,
  not_after timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (institution_id, fingerprint),
  CHECK (not_after > not_before)
);

CREATE TABLE freehold.network_nonces (
  certificate_id uuid NOT NULL REFERENCES freehold.network_certificates(id),
  nonce text NOT NULL CHECK (char_length(nonce) BETWEEN 8 AND 80),
  seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (certificate_id, nonce)
);

CREATE TABLE freehold.network_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('BILATERAL','MULTILATERAL')),
  currency_code text NOT NULL REFERENCES freehold.currencies(code),
  status text NOT NULL CHECK (status IN ('OPEN','FINALIZED','FAILED')),
  rulebook_id uuid REFERENCES freehold.network_rulebooks(id),
  failure_reason text,
  net_sum_minor bigint,
  opened_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finalized_at timestamptz,
  CHECK (status <> 'FINALIZED' OR (failure_reason IS NULL AND net_sum_minor = 0 AND finalized_at IS NOT NULL)),
  CHECK (status <> 'FAILED' OR failure_reason IS NOT NULL)
);

CREATE TABLE freehold.network_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origin_institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  beneficiary_institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  origin_account_id uuid NOT NULL REFERENCES freehold.institution_ledger_accounts(id),
  beneficiary_account_id uuid NOT NULL REFERENCES freehold.institution_ledger_accounts(id),
  currency_code text NOT NULL REFERENCES freehold.currencies(code),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 80 AND purpose !~ '\|'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 80 AND idempotency_key !~ '\|'),
  correlation_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN (
    'CREATED','VALIDATED','CLEARED','NETTED','SETTLEMENT_PENDING','SETTLEMENT_SUBMITTED',
    'SETTLEMENT_CONFIRMED','FINAL','FAILED','REVERSED_BY_NEW_OPERATION','UNKNOWN','REJECTED','CANCELLED')),
  finality text NOT NULL DEFAULT 'NONE' CHECK (finality IN ('NONE','SIMULATED_CONFIRMED_NOT_FINAL','SIMULATED_NET_FINAL')),
  route text NOT NULL DEFAULT 'DIRECT_SIMULATION' CHECK (route = 'DIRECT_SIMULATION'),
  cycle_id uuid REFERENCES freehold.network_cycles(id),
  certificate_id uuid REFERENCES freehold.network_certificates(id),
  signature_hex text CHECK (signature_hex IS NULL OR signature_hex ~ '^[0-9a-f]{128}$'),
  payload_sha256 text CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[0-9a-f]{64}$'),
  simulated_confirmation boolean NOT NULL DEFAULT false,
  finality_mechanism text CHECK (finality_mechanism IS NULL OR finality_mechanism = 'SIMULATED_NET_SETTLEMENT_NOT_EXTERNAL'),
  live_submission boolean NOT NULL DEFAULT false CHECK (NOT live_submission),
  external_settlement boolean NOT NULL DEFAULT false CHECK (NOT external_settlement),
  origin_journal_id uuid REFERENCES freehold.institution_journals(id),
  beneficiary_journal_id uuid REFERENCES freehold.institution_journals(id),
  reversal_origin_journal_id uuid REFERENCES freehold.institution_journals(id),
  reversal_beneficiary_journal_id uuid REFERENCES freehold.institution_journals(id),
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (origin_institution_id, idempotency_key),
  CHECK (origin_institution_id <> beneficiary_institution_id),
  CHECK (state <> 'FINAL' OR (
    simulated_confirmation AND finality = 'SIMULATED_NET_FINAL'
    AND finality_mechanism = 'SIMULATED_NET_SETTLEMENT_NOT_EXTERNAL'
    AND origin_journal_id IS NOT NULL AND beneficiary_journal_id IS NOT NULL)),
  CHECK (state <> 'SETTLEMENT_CONFIRMED' OR (simulated_confirmation AND finality = 'SIMULATED_CONFIRMED_NOT_FINAL' AND origin_journal_id IS NULL)),
  CHECK (state NOT IN ('CREATED','VALIDATED','CLEARED','NETTED','SETTLEMENT_PENDING','SETTLEMENT_SUBMITTED','FAILED','UNKNOWN','REJECTED','CANCELLED') OR origin_journal_id IS NULL)
);

CREATE TABLE freehold.network_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL UNIQUE REFERENCES freehold.network_payments(id),
  origin_institution_id uuid NOT NULL,
  beneficiary_institution_id uuid NOT NULL,
  currency_code text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  eligible boolean NOT NULL,
  exclusion_reason text,
  status text NOT NULL CHECK (status IN ('OPEN','IN_CYCLE','SETTLED','CANCELED','EXCLUDED')),
  cycle_id uuid REFERENCES freehold.network_cycles(id)
);

CREATE TABLE freehold.network_cycle_positions (
  cycle_id uuid NOT NULL REFERENCES freehold.network_cycles(id),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  currency_code text NOT NULL,
  gross_outgoing_minor bigint NOT NULL CHECK (gross_outgoing_minor >= 0),
  gross_incoming_minor bigint NOT NULL CHECK (gross_incoming_minor >= 0),
  net_minor bigint NOT NULL,
  PRIMARY KEY (cycle_id, institution_id),
  CHECK (net_minor = gross_incoming_minor - gross_outgoing_minor)
);

CREATE TABLE freehold.network_settlement_instructions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL REFERENCES freehold.network_cycles(id),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  currency_code text NOT NULL,
  net_minor bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING','SUBMITTED','CONFIRMED_SIMULATED','FINAL','FAILED','UNKNOWN')),
  confirmation_simulated boolean NOT NULL DEFAULT false,
  external_settlement boolean NOT NULL DEFAULT false CHECK (NOT external_settlement),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (cycle_id, institution_id),
  CHECK (state <> 'CONFIRMED_SIMULATED' OR confirmation_simulated),
  CHECK (state <> 'FINAL' OR confirmation_simulated)
);

CREATE TABLE freehold.network_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES freehold.network_payments(id),
  family text NOT NULL CHECK (family IN (
    'pain.001.001.09','pacs.008.001.08','pacs.002.001.10','pacs.004.001.09','camt.053.001.08')),
  message_id text NOT NULL UNIQUE CHECK (char_length(message_id) BETWEEN 8 AND 80),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE freehold.network_risk_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario text NOT NULL CHECK (scenario IN (
    'MEMBER_FAILS_TO_SETTLE','LIQUIDITY_LOSS','OUTGOING_SURGE','DEBIT_LIMIT_EXCEEDED',
    'PROVIDER_OUTAGE','SUSPENDED_DURING_CLEARING','DELAYED_CONFIRMATION','DUPLICATE_MESSAGE',
    'UNEXPECTED_RETURN','CORRUPTED_EVIDENCE')),
  assumptions jsonb NOT NULL,
  result jsonb NOT NULL,
  mutated_accounts boolean NOT NULL DEFAULT false CHECK (NOT mutated_accounts),
  invented_funding boolean NOT NULL DEFAULT false CHECK (NOT invented_funding),
  regulatory_determination boolean NOT NULL DEFAULT false CHECK (NOT regulatory_determination),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE freehold.network_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid REFERENCES freehold.network_cycles(id),
  event_type text NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING','LEASED','DONE','DEAD')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until timestamptz,
  claimed_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION freehold._network_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
BEGIN
  IF current_setting('freehold.network_writer', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'NETWORK_DIRECT_WRITE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'NETWORK_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  -- Field access is nested. One trigger covers every network table, and PL/pgSQL
  -- resolves OLD.column when the statement runs, including a false AND branch.
  IF TG_TABLE_NAME = 'network_cycles' AND TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('FINALIZED','FAILED') THEN
      RAISE EXCEPTION 'NETWORK_CYCLE_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'network_payments' AND TG_OP = 'UPDATE' THEN
    IF OLD.amount_minor IS DISTINCT FROM NEW.amount_minor THEN
      RAISE EXCEPTION 'NETWORK_AMOUNT_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    IF NEW.signature_hex IS DISTINCT FROM OLD.signature_hex OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256 THEN
      RAISE EXCEPTION 'NETWORK_FINALITY_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    IF OLD.state = 'FINAL' AND NEW.state IS DISTINCT FROM 'REVERSED_BY_NEW_OPERATION' THEN
      RAISE EXCEPTION 'NETWORK_FINALITY_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    IF OLD.state IN ('FINAL','REVERSED_BY_NEW_OPERATION') AND (
      NEW.origin_journal_id IS DISTINCT FROM OLD.origin_journal_id
      OR NEW.beneficiary_journal_id IS DISTINCT FROM OLD.beneficiary_journal_id
    ) THEN
      RAISE EXCEPTION 'NETWORK_FINALITY_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'network_cycle_positions' AND TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'NETWORK_POSITION_IMMUTABLE' USING ERRCODE = '55000';
  ELSIF TG_TABLE_NAME = 'network_settlement_instructions' AND TG_OP = 'UPDATE' THEN
    IF OLD.state = 'FINAL' THEN
      RAISE EXCEPTION 'NETWORK_FINALITY_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER network_rulebooks_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.network_rulebooks
  FOR EACH ROW EXECUTE FUNCTION freehold._network_guard();
CREATE TRIGGER network_members_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.network_members
  FOR EACH ROW EXECUTE FUNCTION freehold._network_guard();
CREATE TRIGGER network_acceptances_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.network_rulebook_acceptances
  FOR EACH ROW EXECUTE FUNCTION freehold._network_guard();
CREATE TRIGGER network_audit_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.network_member_audit
  FOR EACH ROW EXECUTE FUNCTION freehold._network_guard();
CREATE TRIGGER network_certificates_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.network_certificates
  FOR EACH ROW EXECUTE FUNCTION freehold._network_guard();
CREATE TRIGGER network_nonces_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.network_nonces
  FOR EACH ROW EXECUTE FUNCTION freehold._network_guard();
CREATE TRIGGER network_payments_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.network_payments
  FOR EACH ROW EXECUTE FUNCTION freehold._network_guard();
CREATE TRIGGER network_obligations_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.network_obligations
  FOR EACH ROW EXECUTE FUNCTION freehold._network_guard();
CREATE TRIGGER network_cycles_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.network_cycles
  FOR EACH ROW EXECUTE FUNCTION freehold._network_guard();
CREATE TRIGGER network_positions_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.network_cycle_positions
  FOR EACH ROW EXECUTE FUNCTION freehold._network_guard();
CREATE TRIGGER network_instructions_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.network_settlement_instructions
  FOR EACH ROW EXECUTE FUNCTION freehold._network_guard();
CREATE TRIGGER network_messages_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.network_messages
  FOR EACH ROW EXECUTE FUNCTION freehold._network_guard();
CREATE TRIGGER network_risk_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.network_risk_runs
  FOR EACH ROW EXECUTE FUNCTION freehold._network_guard();
CREATE TRIGGER network_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.network_outbox
  FOR EACH ROW EXECUTE FUNCTION freehold._network_guard();

CREATE FUNCTION freehold._network_writer() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('freehold.network_writer', 'on', true);
END $$;

CREATE FUNCTION freehold._network_admin(p_actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
BEGIN
  PERFORM freehold._require_bound_session(p_actor);
  IF NOT EXISTS (SELECT 1 FROM freehold.users WHERE id = p_actor AND role = 'ADMIN' AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'NETWORK_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
END $$;

CREATE FUNCTION freehold._network_audit(
  p_member uuid, p_institution uuid, p_actor uuid, p_action text, p_from text, p_to text, p_detail jsonb
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM freehold._network_writer();
  INSERT INTO freehold.network_member_audit(member_id, institution_id, actor_id, action, from_status, to_status, detail)
  VALUES (p_member, p_institution, p_actor, p_action, p_from, p_to, COALESCE(p_detail, '{}'::jsonb));
END $$;

CREATE FUNCTION freehold._network_rulebook_ok(p_body jsonb) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE required text;
BEGIN
  IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN
    RAISE EXCEPTION 'NETWORK_RULEBOOK' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_body->>'enforceableAgreement', 'true') IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'NETWORK_RULEBOOK' USING ERRCODE = '22023';
  END IF;
  FOREACH required IN ARRAY ARRAY[
    'membershipEligibility','participantDuties','transactionTypes','messageFormat','clearingEligibility',
    'nettingMethodology','settlementMechanism','settlementWindow','finalityRules','incidentProcedures',
    'suspensionPolicy','disputeProcedures','reconciliationObligations','amendmentProcess'
  ] LOOP
    IF COALESCE(p_body->>required, '') = '' THEN
      RAISE EXCEPTION 'NETWORK_RULEBOOK' USING ERRCODE = '22023';
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION freehold.network_rulebook_propose(p_actor uuid, p_label text, p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE book uuid;
BEGIN
  PERFORM freehold._network_admin(p_actor);
  PERFORM freehold._network_rulebook_ok(p_body);
  PERFORM freehold._network_writer();
  INSERT INTO freehold.network_rulebooks(version_label, body, proposed_by)
  VALUES (p_label, p_body, p_actor) RETURNING id INTO book;
  PERFORM freehold._network_audit(NULL, NULL, p_actor, 'RULEBOOK_PROPOSE', NULL, 'DRAFT', jsonb_build_object('rulebookId', book, 'enforceableAgreement', false));
  RETURN jsonb_build_object('rulebookId', book, 'status', 'DRAFT', 'enforceableClearingAgreement', false, 'simulationOnly', true);
END $$;

CREATE FUNCTION freehold.network_rulebook_adopt(p_actor uuid, p_rulebook uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE proposer uuid; book_status text;
BEGIN
  PERFORM freehold._network_admin(p_actor);
  SELECT proposed_by, status INTO proposer, book_status FROM freehold.network_rulebooks WHERE id = p_rulebook FOR UPDATE;
  IF NOT FOUND OR book_status IS DISTINCT FROM 'DRAFT' THEN RAISE EXCEPTION 'NETWORK_RULEBOOK' USING ERRCODE = '22023'; END IF;
  IF proposer = p_actor THEN RAISE EXCEPTION 'NETWORK_SELF_APPROVAL' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._network_writer();
  UPDATE freehold.network_rulebooks SET status = 'ADOPTED', adopted_by = p_actor WHERE id = p_rulebook;
  PERFORM freehold._network_audit(NULL, NULL, p_actor, 'RULEBOOK_ADOPT', 'DRAFT', 'ADOPTED', jsonb_build_object('rulebookId', p_rulebook));
  RETURN jsonb_build_object('rulebookId', p_rulebook, 'status', 'ADOPTED', 'enforceableClearingAgreement', false);
END $$;

CREATE FUNCTION freehold.network_member_apply(p_actor uuid, p_institution uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE member uuid; entity uuid; clearing uuid; receivable uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'governance:write');
  IF EXISTS (SELECT 1 FROM freehold.network_members WHERE institution_id = p_institution) THEN
    RAISE EXCEPTION 'NETWORK_MEMBER' USING ERRCODE = '55000';
  END IF;
  SELECT legal_entity_id, id INTO entity, clearing FROM freehold.institution_ledger_accounts
  WHERE institution_id = p_institution AND kind = 'CLEARING' AND currency_code = 'USD' LIMIT 1;
  IF clearing IS NULL THEN RAISE EXCEPTION 'NETWORK_CLEARING_MISSING' USING ERRCODE = '55000'; END IF;
  PERFORM set_config('freehold.institution_writer', 'on', true);
  INSERT INTO freehold.institution_ledger_accounts(institution_id, legal_entity_id, kind, currency_code, evidence_state, counts_as_external_asset)
  VALUES (p_institution, entity, 'SETTLEMENT_RECEIVABLE', 'USD', 'EXTERNAL_UNAVAILABLE', false)
  RETURNING id INTO receivable;
  INSERT INTO freehold.institution_ledger_accounts(institution_id, legal_entity_id, kind, currency_code, evidence_state, counts_as_external_asset)
  VALUES (p_institution, entity, 'SETTLEMENT_PAYABLE', 'USD', 'EXTERNAL_UNAVAILABLE', false);
  PERFORM freehold._network_writer();
  INSERT INTO freehold.network_members(institution_id, status, settlement_account_id, applied_by)
  VALUES (p_institution, 'APPLICANT', clearing, p_actor) RETURNING id INTO member;
  PERFORM freehold._network_audit(member, p_institution, p_actor, 'MEMBER_APPLY', NULL, 'APPLICANT', jsonb_build_object('licensedClaim', false, 'liveAuthorized', false));
  RETURN jsonb_build_object('memberId', member, 'institutionId', p_institution, 'status', 'APPLICANT', 'licensedClaim', false, 'liveAuthorized', false, 'simulationOnly', true);
END $$;

CREATE FUNCTION freehold.network_rulebook_accept(p_actor uuid, p_institution uuid, p_rulebook uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE book_status text; member uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'governance:write');
  SELECT status INTO book_status FROM freehold.network_rulebooks WHERE id = p_rulebook;
  IF book_status IS DISTINCT FROM 'ADOPTED' THEN RAISE EXCEPTION 'NETWORK_RULEBOOK' USING ERRCODE = '22023'; END IF;
  SELECT id INTO member FROM freehold.network_members WHERE institution_id = p_institution;
  IF member IS NULL THEN RAISE EXCEPTION 'NETWORK_MEMBER' USING ERRCODE = '42501'; END IF;
  PERFORM freehold._network_writer();
  INSERT INTO freehold.network_rulebook_acceptances(institution_id, rulebook_id, accepted_by)
  VALUES (p_institution, p_rulebook, p_actor)
  ON CONFLICT (institution_id, rulebook_id) DO NOTHING;
  UPDATE freehold.network_members SET rulebook_id = p_rulebook WHERE id = member AND institution_id = p_institution;
  PERFORM freehold._network_audit(member, p_institution, p_actor, 'RULEBOOK_ACCEPT', NULL, NULL, jsonb_build_object('rulebookId', p_rulebook));
  RETURN jsonb_build_object('institutionId', p_institution, 'rulebookId', p_rulebook, 'accepted', true, 'enforceableClearingAgreement', false);
END $$;

CREATE FUNCTION freehold.network_member_transition(p_actor uuid, p_institution uuid, p_to text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE member freehold.network_members; accepted_by uuid;
BEGIN
  PERFORM freehold._network_admin(p_actor);
  SELECT * INTO member FROM freehold.network_members WHERE institution_id = p_institution FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NETWORK_MEMBER' USING ERRCODE = '42501'; END IF;
  IF member.status = 'TERMINATED' OR p_to = member.status THEN RAISE EXCEPTION 'NETWORK_MEMBER' USING ERRCODE = '22023'; END IF;
  IF p_actor = member.applied_by AND p_to <> 'SUSPENDED' THEN RAISE EXCEPTION 'NETWORK_SELF_APPROVAL' USING ERRCODE = '22023'; END IF;
  IF p_to = 'UNDER_REVIEW' AND member.status IS DISTINCT FROM 'APPLICANT' THEN RAISE EXCEPTION 'NETWORK_MEMBER' USING ERRCODE = '22023'; END IF;
  IF p_to = 'APPROVED_FOR_SIMULATION' AND (member.status IS DISTINCT FROM 'UNDER_REVIEW' OR p_actor = member.reviewed_by) THEN
    RAISE EXCEPTION 'NETWORK_MEMBER' USING ERRCODE = '22023';
  END IF;
  IF p_to = 'ACTIVE_SIMULATION' AND member.status NOT IN ('APPROVED_FOR_SIMULATION','SUSPENDED') THEN
    RAISE EXCEPTION 'NETWORK_MEMBER' USING ERRCODE = '22023';
  END IF;
  IF p_to = 'ACTIVE_SIMULATION' THEN
    SELECT a.accepted_by INTO accepted_by FROM freehold.network_rulebook_acceptances a
    JOIN freehold.network_rulebooks b ON b.id = a.rulebook_id AND b.status = 'ADOPTED'
    WHERE a.institution_id = p_institution AND a.rulebook_id = member.rulebook_id;
    IF accepted_by IS NULL OR accepted_by = p_actor THEN RAISE EXCEPTION 'NETWORK_RULEBOOK' USING ERRCODE = '22023'; END IF;
    IF member.status = 'SUSPENDED' AND p_actor = member.suspended_by THEN RAISE EXCEPTION 'NETWORK_SELF_APPROVAL' USING ERRCODE = '22023'; END IF;
  END IF;
  IF p_to = 'SUSPENDED' AND member.status IS DISTINCT FROM 'ACTIVE_SIMULATION' THEN RAISE EXCEPTION 'NETWORK_MEMBER' USING ERRCODE = '22023'; END IF;
  IF p_to NOT IN ('UNDER_REVIEW','APPROVED_FOR_SIMULATION','ACTIVE_SIMULATION','SUSPENDED','TERMINATED') THEN
    RAISE EXCEPTION 'NETWORK_MEMBER' USING ERRCODE = '22023';
  END IF;
  PERFORM freehold._network_writer();
  UPDATE freehold.network_members SET
    status = p_to,
    reviewed_by = CASE WHEN p_to = 'UNDER_REVIEW' THEN p_actor ELSE reviewed_by END,
    activated_by = CASE WHEN p_to = 'ACTIVE_SIMULATION' THEN p_actor ELSE activated_by END,
    suspended_by = CASE WHEN p_to = 'SUSPENDED' THEN p_actor ELSE suspended_by END
  WHERE id = member.id;
  PERFORM freehold._network_audit(member.id, p_institution, p_actor, 'MEMBER_TRANSITION', member.status, p_to, jsonb_build_object('financialPosting', false));
  RETURN jsonb_build_object('institutionId', p_institution, 'fromStatus', member.status, 'status', p_to, 'financialPosting', false, 'licensedClaim', false);
END $$;

CREATE FUNCTION freehold.network_member_currencies(p_actor uuid, p_institution uuid, p_currencies text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE member uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'governance:write');
  IF p_currencies IS NULL OR cardinality(p_currencies) < 1 OR cardinality(p_currencies) > 8 THEN
    RAISE EXCEPTION 'NETWORK_CURRENCY' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_currencies) AS listed(code)
    WHERE listed.code !~ '^[A-Z]{3}$'
      OR NOT EXISTS (SELECT 1 FROM freehold.currencies AS known WHERE known.code = listed.code)
  ) THEN RAISE EXCEPTION 'NETWORK_CURRENCY' USING ERRCODE = '22023'; END IF;
  SELECT id INTO member FROM freehold.network_members WHERE institution_id = p_institution FOR UPDATE;
  IF member IS NULL THEN RAISE EXCEPTION 'NETWORK_MEMBER' USING ERRCODE = '42501'; END IF;
  PERFORM freehold._network_writer();
  UPDATE freehold.network_members SET currencies = p_currencies WHERE id = member;
  PERFORM freehold._network_audit(member, p_institution, p_actor, 'MEMBER_CURRENCIES', NULL, NULL, jsonb_build_object('currencies', to_jsonb(p_currencies), 'posted', false));
  RETURN jsonb_build_object('institutionId', p_institution, 'currencies', to_jsonb(p_currencies), 'posted', false);
END $$;

CREATE FUNCTION freehold.network_certificate_register(
  p_actor uuid, p_institution uuid, p_public_hex text, p_not_before timestamptz, p_not_after timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE cert uuid; fingerprint text;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'governance:write');
  IF p_public_hex !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'NETWORK_CERT' USING ERRCODE = '22023'; END IF;
  IF p_not_after <= clock_timestamp() OR p_not_before > clock_timestamp() THEN
    RAISE EXCEPTION 'NETWORK_CERT_EXPIRED' USING ERRCODE = '22023';
  END IF;
  fingerprint := encode(public.digest(decode(p_public_hex, 'hex'), 'sha256'), 'hex');
  PERFORM freehold._network_writer();
  INSERT INTO freehold.network_certificates(institution_id, algorithm, public_key_hex, fingerprint, not_before, not_after)
  VALUES (p_institution, 'ED25519', p_public_hex, fingerprint, p_not_before, p_not_after)
  RETURNING id INTO cert;
  PERFORM freehold._network_audit(NULL, p_institution, p_actor, 'CERT_REGISTER', NULL, NULL, jsonb_build_object('certificateId', cert, 'privateKeyStored', false));
  RETURN jsonb_build_object('certificateId', cert, 'algorithm', 'ED25519', 'fingerprint', fingerprint, 'privateKeyStored', false);
END $$;

CREATE FUNCTION freehold.network_certificate_revoke(p_actor uuid, p_institution uuid, p_cert uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE owner uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'governance:write');
  SELECT institution_id INTO owner FROM freehold.network_certificates WHERE id = p_cert AND revoked_at IS NULL;
  IF owner IS DISTINCT FROM p_institution THEN RAISE EXCEPTION 'NETWORK_CERT_REVOKED' USING ERRCODE = '42501'; END IF;
  PERFORM freehold._network_writer();
  UPDATE freehold.network_certificates SET revoked_at = clock_timestamp() WHERE id = p_cert;
  PERFORM freehold._network_audit(NULL, p_institution, p_actor, 'CERT_REVOKE', NULL, NULL, jsonb_build_object('certificateId', p_cert));
  RETURN jsonb_build_object('certificateId', p_cert, 'revoked', true);
END $$;

CREATE FUNCTION freehold.network_liquidity_set(
  p_actor uuid, p_institution uuid, p_opening bigint, p_capacity bigint, p_debit_limit bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE member uuid; available bigint;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'governance:write');
  IF p_opening < 0 OR p_capacity < 0 OR p_debit_limit < 0 THEN RAISE EXCEPTION 'NETWORK_LIQUIDITY' USING ERRCODE = '22023'; END IF;
  SELECT id INTO member FROM freehold.network_members WHERE institution_id = p_institution FOR UPDATE;
  IF member IS NULL THEN RAISE EXCEPTION 'NETWORK_MEMBER' USING ERRCODE = '42501'; END IF;
  available := LEAST(p_opening, p_capacity);
  PERFORM freehold._network_writer();
  UPDATE freehold.network_members SET
    opening_liquidity_minor = p_opening,
    settlement_capacity_minor = p_capacity,
    net_debit_limit_minor = p_debit_limit
  WHERE id = member;
  PERFORM freehold._network_audit(member, p_institution, p_actor, 'LIQUIDITY_SET', NULL, NULL, jsonb_build_object(
    'openingMinor', p_opening::text, 'availableMinor', available::text, 'centralBankBalanceCreated', false, 'externalAsset', false));
  RETURN jsonb_build_object(
    'institutionId', p_institution, 'openingMinor', p_opening::text, 'capacityMinor', p_capacity::text,
    'availableMinor', available::text, 'netDebitLimitMinor', p_debit_limit::text,
    'centralBankBalanceCreated', false, 'inventedFunding', false, 'externalAsset', false);
END $$;

CREATE FUNCTION freehold._network_payload(
  p_origin uuid, p_beneficiary uuid, p_origin_account uuid, p_beneficiary_account uuid,
  p_currency text, p_amount bigint, p_key text, p_purpose text
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT 'v1|' || p_origin::text || '|' || p_beneficiary::text || '|' || p_origin_account::text || '|'
    || p_beneficiary_account::text || '|' || p_currency || '|' || p_amount::text || '|' || p_key || '|' || p_purpose;
$$;

CREATE FUNCTION freehold.network_payment_open(
  p_actor uuid, p_origin uuid, p_beneficiary uuid, p_origin_account uuid, p_beneficiary_account uuid,
  p_amount bigint, p_purpose text, p_key text, p_correlation uuid, p_cert uuid, p_signature text, p_nonce text, p_ttl integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE
  existing freehold.network_payments;
  cert freehold.network_certificates;
  origin_acct freehold.institution_ledger_accounts;
  beneficiary_acct freehold.institution_ledger_accounts;
  payload text;
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
  PERFORM freehold._network_writer();
  BEGIN
    INSERT INTO freehold.network_nonces(certificate_id, nonce) VALUES (cert.id, p_nonce);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'NETWORK_REPLAY' USING ERRCODE = '55000';
  END;
  SELECT * INTO existing FROM freehold.network_payments
  WHERE origin_institution_id = p_origin AND idempotency_key = p_key;
  IF FOUND THEN
    RETURN jsonb_build_object('paymentId', existing.id, 'state', existing.state, 'duplicate', true, 'posted', false);
  END IF;
  SELECT * INTO origin_acct FROM freehold.institution_ledger_accounts WHERE id = p_origin_account;
  SELECT * INTO beneficiary_acct FROM freehold.institution_ledger_accounts WHERE id = p_beneficiary_account;
  IF origin_acct.institution_id IS DISTINCT FROM p_origin OR origin_acct.kind IS DISTINCT FROM 'CUSTOMER'
     OR beneficiary_acct.institution_id IS DISTINCT FROM p_beneficiary OR beneficiary_acct.kind IS DISTINCT FROM 'CUSTOMER'
     OR origin_acct.currency_code IS DISTINCT FROM beneficiary_acct.currency_code THEN
    RAISE EXCEPTION 'NETWORK_CURRENCY' USING ERRCODE = '22023';
  END IF;
  payload := freehold._network_payload(p_origin, p_beneficiary, p_origin_account, p_beneficiary_account, origin_acct.currency_code, p_amount, p_key, p_purpose);
  INSERT INTO freehold.network_payments(
    origin_institution_id, beneficiary_institution_id, origin_account_id, beneficiary_account_id,
    currency_code, amount_minor, purpose, idempotency_key, correlation_id, state, certificate_id,
    signature_hex, payload_sha256, expires_at, created_by)
  VALUES (
    p_origin, p_beneficiary, p_origin_account, p_beneficiary_account, origin_acct.currency_code, p_amount, p_purpose, p_key,
    p_correlation, 'CREATED', cert.id, p_signature, encode(public.digest(payload, 'sha256'), 'hex'),
    clock_timestamp() + make_interval(secs => p_ttl), p_actor)
  RETURNING id INTO payment;
  PERFORM freehold._network_audit(NULL, p_origin, p_actor, 'PAYMENT_OPEN', NULL, 'CREATED', jsonb_build_object('paymentId', payment, 'posted', false));
  RETURN jsonb_build_object('paymentId', payment, 'state', 'CREATED', 'duplicate', false, 'posted', false, 'route', 'DIRECT_SIMULATION', 'externalSettlement', false);
END $$;

CREATE FUNCTION freehold.network_payment_validate(p_actor uuid, p_payment uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE pay freehold.network_payments; origin_member freehold.network_members; beneficiary_member freehold.network_members;
BEGIN
  SELECT * INTO pay FROM freehold.network_payments WHERE id = p_payment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NETWORK_PAYMENT' USING ERRCODE = '42501'; END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, pay.origin_institution_id, 'payments:write');
  IF pay.state = 'VALIDATED' THEN
    RETURN jsonb_build_object('paymentId', pay.id, 'state', pay.state, 'duplicate', true, 'posted', false);
  END IF;
  IF pay.state IS DISTINCT FROM 'CREATED' THEN RAISE EXCEPTION 'NETWORK_STATE' USING ERRCODE = '22023'; END IF;
  IF pay.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'NETWORK_EXPIRED' USING ERRCODE = '22023'; END IF;
  SELECT * INTO origin_member FROM freehold.network_members WHERE institution_id = pay.origin_institution_id;
  SELECT * INTO beneficiary_member FROM freehold.network_members WHERE institution_id = pay.beneficiary_institution_id;
  IF origin_member.status IS DISTINCT FROM 'ACTIVE_SIMULATION' OR beneficiary_member.status IS DISTINCT FROM 'ACTIVE_SIMULATION' THEN
    RAISE EXCEPTION 'NETWORK_MEMBER_SUSPENDED' USING ERRCODE = '42501';
  END IF;
  IF pay.amount_minor > origin_member.participation_limit_minor OR NOT (pay.currency_code = ANY (origin_member.currencies))
     OR NOT (pay.currency_code = ANY (beneficiary_member.currencies)) THEN
    RAISE EXCEPTION 'NETWORK_LIMIT' USING ERRCODE = '22023';
  END IF;
  PERFORM freehold._network_writer();
  UPDATE freehold.network_payments SET state = 'VALIDATED' WHERE id = pay.id;
  INSERT INTO freehold.network_obligations(
    payment_id, origin_institution_id, beneficiary_institution_id, currency_code, amount_minor, eligible, status)
  VALUES (pay.id, pay.origin_institution_id, pay.beneficiary_institution_id, pay.currency_code, pay.amount_minor, true, 'OPEN');
  RETURN jsonb_build_object('paymentId', pay.id, 'state', 'VALIDATED', 'posted', false, 'obligation', 'OPEN');
END $$;

CREATE FUNCTION freehold.network_payment_cancel(p_actor uuid, p_payment uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE pay freehold.network_payments;
BEGIN
  SELECT * INTO pay FROM freehold.network_payments WHERE id = p_payment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NETWORK_PAYMENT' USING ERRCODE = '42501'; END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, pay.origin_institution_id, 'payments:write');
  IF pay.state = 'CANCELLED' THEN RETURN jsonb_build_object('paymentId', pay.id, 'state', 'CANCELLED', 'duplicate', true); END IF;
  IF pay.state NOT IN ('CREATED','VALIDATED') THEN RAISE EXCEPTION 'NETWORK_STATE' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._network_writer();
  UPDATE freehold.network_payments SET state = 'CANCELLED' WHERE id = pay.id;
  UPDATE freehold.network_obligations SET status = 'CANCELED', eligible = false, exclusion_reason = 'CANCELED'
  WHERE payment_id = pay.id AND status = 'OPEN';
  RETURN jsonb_build_object('paymentId', pay.id, 'state', 'CANCELLED', 'posted', false);
END $$;

CREATE FUNCTION freehold.network_payment_reject(p_actor uuid, p_payment uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE pay freehold.network_payments;
BEGIN
  SELECT * INTO pay FROM freehold.network_payments WHERE id = p_payment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NETWORK_PAYMENT' USING ERRCODE = '42501'; END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, pay.beneficiary_institution_id, 'governance:write');
  IF pay.state = 'REJECTED' THEN RETURN jsonb_build_object('paymentId', pay.id, 'state', 'REJECTED', 'duplicate', true); END IF;
  IF pay.state IS DISTINCT FROM 'VALIDATED' THEN RAISE EXCEPTION 'NETWORK_STATE' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._network_writer();
  UPDATE freehold.network_payments SET state = 'REJECTED' WHERE id = pay.id;
  UPDATE freehold.network_obligations SET status = 'EXCLUDED', eligible = false, exclusion_reason = 'DESTINATION_REJECTED'
  WHERE payment_id = pay.id AND status = 'OPEN';
  RETURN jsonb_build_object('paymentId', pay.id, 'state', 'REJECTED', 'posted', false);
END $$;

CREATE FUNCTION freehold.network_payment_get(p_actor uuid, p_institution uuid, p_payment uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE pay freehold.network_payments; side text;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'payments:read');
  SELECT * INTO pay FROM freehold.network_payments WHERE id = p_payment;
  IF NOT FOUND THEN RAISE EXCEPTION 'NETWORK_PAYMENT' USING ERRCODE = '42501'; END IF;
  IF p_institution = pay.origin_institution_id THEN side := 'ORIGIN';
  ELSIF p_institution = pay.beneficiary_institution_id THEN side := 'BENEFICIARY';
  ELSE RAISE EXCEPTION 'NETWORK_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object(
    'paymentId', pay.id, 'side', side, 'state', pay.state, 'finality', pay.finality,
    'currency', pay.currency_code, 'amountMinor', pay.amount_minor::text,
    'originInstitutionId', pay.origin_institution_id, 'beneficiaryInstitutionId', pay.beneficiary_institution_id,
    'accountId', CASE WHEN side = 'ORIGIN' THEN pay.origin_account_id ELSE pay.beneficiary_account_id END,
    'simulatedConfirmation', pay.simulated_confirmation, 'externalSettlement', false,
    'customerDisplayNames', false, 'posted', pay.origin_journal_id IS NOT NULL);
END $$;

CREATE FUNCTION freehold.network_cycle_build(p_actor uuid, p_kind text, p_currency text, p_members uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE cycle uuid; included integer := 0; parties integer; book uuid;
BEGIN
  PERFORM freehold._network_admin(p_actor);
  IF p_kind NOT IN ('BILATERAL','MULTILATERAL') OR p_members IS NULL THEN RAISE EXCEPTION 'NETWORK_CYCLE' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('freehold-network-clearing')::bigint);
  SELECT id INTO book FROM freehold.network_rulebooks WHERE status = 'ADOPTED' ORDER BY created_at DESC LIMIT 1;
  PERFORM freehold._network_writer();
  INSERT INTO freehold.network_cycles(kind, currency_code, status, rulebook_id, opened_by)
  VALUES (p_kind, p_currency, 'OPEN', book, p_actor) RETURNING id INTO cycle;
  WITH picked AS (
    SELECT o.id
    FROM freehold.network_obligations o
    JOIN freehold.network_payments p ON p.id = o.payment_id
    JOIN freehold.network_members mo ON mo.institution_id = o.origin_institution_id
    JOIN freehold.network_members mb ON mb.institution_id = o.beneficiary_institution_id
    WHERE o.status = 'OPEN' AND o.eligible AND o.currency_code = p_currency
      AND o.origin_institution_id = ANY (p_members) AND o.beneficiary_institution_id = ANY (p_members)
      AND p.state = 'VALIDATED' AND p.expires_at > clock_timestamp()
      AND mo.status = 'ACTIVE_SIMULATION' AND mb.status = 'ACTIVE_SIMULATION'
    ORDER BY o.payment_id
    FOR UPDATE OF o
  ), marked AS (
    UPDATE freehold.network_obligations o SET status = 'IN_CYCLE', cycle_id = cycle
    FROM picked WHERE o.id = picked.id
    RETURNING o.payment_id
  )
  UPDATE freehold.network_payments p SET state = 'CLEARED', cycle_id = cycle
  FROM marked WHERE p.id = marked.payment_id AND p.state = 'VALIDATED';
  GET DIAGNOSTICS included = ROW_COUNT;
  IF included = 0 THEN
    UPDATE freehold.network_cycles SET status = 'FAILED', failure_reason = 'NO_ELIGIBLE_OBLIGATIONS', finalized_at = clock_timestamp()
    WHERE id = cycle;
    RETURN jsonb_build_object('cycleId', cycle, 'created', false, 'included', 0, 'partial', false, 'reason', 'NO_ELIGIBLE_OBLIGATIONS');
  END IF;
  SELECT count(*) INTO parties FROM (
    SELECT origin_institution_id AS institution_id FROM freehold.network_obligations WHERE cycle_id = cycle
    UNION
    SELECT beneficiary_institution_id FROM freehold.network_obligations WHERE cycle_id = cycle
  ) s;
  IF (p_kind = 'BILATERAL' AND parties <> 2) OR (p_kind = 'MULTILATERAL' AND parties < 3) THEN
    UPDATE freehold.network_payments SET state = 'VALIDATED', cycle_id = NULL
    WHERE cycle_id = cycle AND state = 'CLEARED';
    UPDATE freehold.network_obligations SET status = 'OPEN', cycle_id = NULL
    WHERE cycle_id = cycle AND status = 'IN_CYCLE';
    UPDATE freehold.network_cycles SET status = 'FAILED', failure_reason = 'NETWORK_CYCLE_SHAPE', finalized_at = clock_timestamp()
    WHERE id = cycle;
    RETURN jsonb_build_object('cycleId', cycle, 'created', false, 'partial', false, 'reason', 'NETWORK_CYCLE_SHAPE');
  END IF;
  RETURN jsonb_build_object('cycleId', cycle, 'created', true, 'included', included, 'parties', parties, 'partial', false, 'posted', false);
END $$;

CREATE FUNCTION freehold._network_cycle_fail(p_cycle uuid, p_reason text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE freehold.network_payments SET state = 'VALIDATED', cycle_id = NULL
  WHERE cycle_id = p_cycle AND state = 'CLEARED';
  UPDATE freehold.network_obligations SET status = 'OPEN', cycle_id = NULL
  WHERE cycle_id = p_cycle AND status = 'IN_CYCLE';
  UPDATE freehold.network_cycles SET status = 'FAILED', failure_reason = p_reason, finalized_at = clock_timestamp()
  WHERE id = p_cycle AND status = 'OPEN';
END $$;

CREATE FUNCTION freehold.network_cycle_finalize(p_actor uuid, p_cycle uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE
  cycle freehold.network_cycles;
  net_sum bigint;
  party record;
  reason text := NULL;
  pending bigint;
  available bigint;
  payable bigint;
BEGIN
  PERFORM freehold._network_admin(p_actor);
  PERFORM pg_advisory_xact_lock(hashtext('freehold-network-clearing')::bigint);
  SELECT * INTO cycle FROM freehold.network_cycles WHERE id = p_cycle FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NETWORK_CYCLE' USING ERRCODE = '42501'; END IF;
  IF cycle.status = 'FINALIZED' THEN
    RETURN jsonb_build_object('cycleId', cycle.id, 'status', 'FINALIZED', 'duplicate', true, 'partial', false);
  END IF;
  IF cycle.status IS DISTINCT FROM 'OPEN' THEN RAISE EXCEPTION 'NETWORK_CYCLE' USING ERRCODE = '22023'; END IF;
  IF EXISTS (
    SELECT 1 FROM freehold.network_obligations o
    JOIN freehold.network_members m ON m.institution_id IN (o.origin_institution_id, o.beneficiary_institution_id)
    WHERE o.cycle_id = cycle.id AND o.status = 'IN_CYCLE' AND m.status IS DISTINCT FROM 'ACTIVE_SIMULATION'
  ) THEN reason := 'NETWORK_MEMBER_SUSPENDED'; END IF;
  PERFORM freehold._network_writer();
  IF reason IS NULL THEN
    FOR party IN
      SELECT institution_id,
             COALESCE(sum(amount_minor) FILTER (WHERE origin_institution_id = institution_id), 0) AS gross_out,
             COALESCE(sum(amount_minor) FILTER (WHERE beneficiary_institution_id = institution_id), 0) AS gross_in
      FROM (
        SELECT o.amount_minor, o.origin_institution_id, o.beneficiary_institution_id, ends.institution_id
        FROM freehold.network_obligations o
        JOIN (
          SELECT origin_institution_id AS institution_id FROM freehold.network_obligations WHERE cycle_id = cycle.id AND status = 'IN_CYCLE'
          UNION
          SELECT beneficiary_institution_id FROM freehold.network_obligations WHERE cycle_id = cycle.id AND status = 'IN_CYCLE'
        ) ends ON true
        WHERE o.cycle_id = cycle.id AND o.status = 'IN_CYCLE' AND o.currency_code = cycle.currency_code
          AND ends.institution_id IN (o.origin_institution_id, o.beneficiary_institution_id)
      ) lines
      GROUP BY institution_id
      ORDER BY institution_id
    LOOP
      payable := CASE WHEN party.gross_in < party.gross_out THEN party.gross_out - party.gross_in ELSE 0 END;
      SELECT COALESCE(sum(-i.net_minor), 0) INTO pending
      FROM freehold.network_settlement_instructions i
      JOIN freehold.network_cycles c ON c.id = i.cycle_id
      WHERE i.institution_id = party.institution_id AND i.net_minor < 0 AND i.state <> 'FINAL' AND c.status = 'FINALIZED';
      SELECT LEAST(opening_liquidity_minor, settlement_capacity_minor) - pending,
             net_debit_limit_minor
        INTO available, payable
      FROM freehold.network_members WHERE institution_id = party.institution_id;
      IF available IS NULL THEN reason := 'NETWORK_MEMBER'; EXIT; END IF;
      IF (party.gross_out - party.gross_in) > available THEN reason := 'NETWORK_LIQUIDITY'; EXIT; END IF;
      IF (party.gross_out - party.gross_in) > (
        SELECT net_debit_limit_minor FROM freehold.network_members WHERE institution_id = party.institution_id
      ) AND party.gross_out > party.gross_in THEN reason := 'NETWORK_DEBIT_LIMIT'; EXIT; END IF;
    END LOOP;
  END IF;
  IF reason IS NOT NULL THEN
    PERFORM freehold._network_cycle_fail(cycle.id, reason);
    RETURN jsonb_build_object('cycleId', cycle.id, 'status', 'FAILED', 'reason', reason, 'partial', false, 'posted', false, 'inventedFunding', false);
  END IF;
  INSERT INTO freehold.network_cycle_positions(cycle_id, institution_id, currency_code, gross_outgoing_minor, gross_incoming_minor, net_minor)
  SELECT cycle.id, institution_id, cycle.currency_code, gross_out, gross_in, gross_in - gross_out
  FROM (
    SELECT ends.institution_id,
           COALESCE(sum(o.amount_minor) FILTER (WHERE o.origin_institution_id = ends.institution_id), 0) AS gross_out,
           COALESCE(sum(o.amount_minor) FILTER (WHERE o.beneficiary_institution_id = ends.institution_id), 0) AS gross_in
    FROM (
      SELECT origin_institution_id AS institution_id FROM freehold.network_obligations WHERE cycle_id = cycle.id AND status = 'IN_CYCLE'
      UNION
      SELECT beneficiary_institution_id FROM freehold.network_obligations WHERE cycle_id = cycle.id AND status = 'IN_CYCLE'
    ) ends
    JOIN freehold.network_obligations o ON o.cycle_id = cycle.id AND o.status = 'IN_CYCLE'
     AND o.currency_code = cycle.currency_code
     AND ends.institution_id IN (o.origin_institution_id, o.beneficiary_institution_id)
    GROUP BY ends.institution_id
  ) computed;
  SELECT COALESCE(sum(net_minor), 0) INTO net_sum FROM freehold.network_cycle_positions WHERE cycle_id = cycle.id;
  IF net_sum <> 0 THEN RAISE EXCEPTION 'NETWORK_NET_SUM' USING ERRCODE = '23514'; END IF;
  INSERT INTO freehold.network_settlement_instructions(cycle_id, institution_id, currency_code, net_minor, state)
  SELECT cycle_id, institution_id, currency_code, net_minor, 'PENDING' FROM freehold.network_cycle_positions WHERE cycle_id = cycle.id;
  UPDATE freehold.network_payments SET state = 'SETTLEMENT_PENDING' WHERE cycle_id = cycle.id AND state = 'CLEARED';
  UPDATE freehold.network_cycles SET status = 'FINALIZED', net_sum_minor = 0, finalized_at = clock_timestamp() WHERE id = cycle.id;
  RETURN jsonb_build_object('cycleId', cycle.id, 'status', 'FINALIZED', 'netSumMinor', '0', 'duplicate', false, 'partial', false, 'posted', false);
END $$;

CREATE FUNCTION freehold.network_settlement_submit(p_actor uuid, p_cycle uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE cycle_status text; updated integer;
BEGIN
  PERFORM freehold._network_admin(p_actor);
  SELECT status INTO cycle_status FROM freehold.network_cycles WHERE id = p_cycle;
  IF cycle_status IS DISTINCT FROM 'FINALIZED' THEN RAISE EXCEPTION 'NETWORK_CYCLE' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM freehold.network_settlement_instructions WHERE cycle_id = p_cycle AND state = 'SUBMITTED')
     AND NOT EXISTS (SELECT 1 FROM freehold.network_settlement_instructions WHERE cycle_id = p_cycle AND state = 'PENDING') THEN
    RETURN jsonb_build_object('cycleId', p_cycle, 'state', 'SETTLEMENT_SUBMITTED', 'duplicate', true, 'posted', false);
  END IF;
  PERFORM freehold._network_writer();
  UPDATE freehold.network_settlement_instructions SET state = 'SUBMITTED'
  WHERE cycle_id = p_cycle AND state = 'PENDING';
  GET DIAGNOSTICS updated = ROW_COUNT;
  UPDATE freehold.network_payments SET state = 'SETTLEMENT_SUBMITTED'
  WHERE cycle_id = p_cycle AND state = 'SETTLEMENT_PENDING';
  IF updated = 0 THEN RAISE EXCEPTION 'NETWORK_STATE' USING ERRCODE = '22023'; END IF;
  RETURN jsonb_build_object('cycleId', p_cycle, 'state', 'SETTLEMENT_SUBMITTED', 'instructions', updated, 'duplicate', false, 'posted', false, 'acknowledgmentIsFinal', false);
END $$;

CREATE FUNCTION freehold.network_settlement_confirm(p_actor uuid, p_cycle uuid, p_signature text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE cycle freehold.network_cycles; secret text; payload text; ok boolean;
BEGIN
  PERFORM freehold._network_admin(p_actor);
  SELECT * INTO cycle FROM freehold.network_cycles WHERE id = p_cycle FOR UPDATE;
  IF NOT FOUND OR cycle.status IS DISTINCT FROM 'FINALIZED' THEN RAISE EXCEPTION 'NETWORK_CYCLE' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM freehold.network_settlement_instructions WHERE cycle_id = p_cycle AND state IN ('CONFIRMED_SIMULATED','FINAL'))
     AND NOT EXISTS (SELECT 1 FROM freehold.network_settlement_instructions WHERE cycle_id = p_cycle AND state = 'SUBMITTED') THEN
    RETURN jsonb_build_object('cycleId', p_cycle, 'state', 'SETTLEMENT_CONFIRMED', 'duplicate', true, 'posted', false, 'simulated', true);
  END IF;
  secret := current_setting('freehold.bank_simulator_key', true);
  payload := 'network|' || cycle.id::text || '|' || cycle.currency_code || '|FINAL_SIMULATED';
  ok := secret IS NOT NULL AND secret <> '' AND p_signature = encode(public.hmac(payload::bytea, convert_to(secret, 'utf8'), 'sha256'), 'hex');
  IF NOT ok THEN RAISE EXCEPTION 'NETWORK_SIGNATURE' USING ERRCODE = '42501'; END IF;
  PERFORM freehold._network_writer();
  UPDATE freehold.network_settlement_instructions SET state = 'CONFIRMED_SIMULATED', confirmation_simulated = true
  WHERE cycle_id = p_cycle AND state = 'SUBMITTED';
  UPDATE freehold.network_payments SET state = 'SETTLEMENT_CONFIRMED', simulated_confirmation = true, finality = 'SIMULATED_CONFIRMED_NOT_FINAL'
  WHERE cycle_id = p_cycle AND state = 'SETTLEMENT_SUBMITTED';
  RETURN jsonb_build_object(
    'cycleId', p_cycle, 'state', 'SETTLEMENT_CONFIRMED', 'simulated', true, 'posted', false,
    'finality', 'SIMULATED_CONFIRMED_NOT_FINAL', 'externalSettlement', false, 'duplicate', false);
END $$;

CREATE FUNCTION freehold.network_settlement_unknown(p_actor uuid, p_cycle uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
BEGIN
  PERFORM freehold._network_admin(p_actor);
  IF NOT EXISTS (SELECT 1 FROM freehold.network_settlement_instructions WHERE cycle_id = p_cycle AND state = 'SUBMITTED') THEN
    RAISE EXCEPTION 'NETWORK_STATE' USING ERRCODE = '22023';
  END IF;
  PERFORM freehold._network_writer();
  UPDATE freehold.network_settlement_instructions SET state = 'UNKNOWN' WHERE cycle_id = p_cycle AND state = 'SUBMITTED';
  UPDATE freehold.network_payments SET state = 'UNKNOWN', finality = 'NONE' WHERE cycle_id = p_cycle AND state = 'SETTLEMENT_SUBMITTED';
  INSERT INTO freehold.network_outbox(cycle_id, event_type, state) VALUES (p_cycle, 'network.payment.unknown', 'PENDING');
  RETURN jsonb_build_object('cycleId', p_cycle, 'state', 'UNKNOWN', 'posted', false, 'final', false, 'retryCreatesInstruction', false);
END $$;

CREATE FUNCTION freehold.network_settlement_finalize(p_actor uuid, p_cycle uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE
  pay freehold.network_payments;
  entity uuid := '10000000-0000-4000-8000-000000000001';
  clearing uuid;
  receivable uuid;
  origin_journal uuid;
  beneficiary_journal uuid;
  posted integer := 0;
BEGIN
  PERFORM freehold._network_admin(p_actor);
  IF EXISTS (
    SELECT 1 FROM freehold.network_payments p WHERE p.cycle_id = p_cycle AND p.created_by = p_actor
  ) THEN RAISE EXCEPTION 'NETWORK_SELF_APPROVAL' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM freehold.network_payments WHERE cycle_id = p_cycle AND state = 'FINAL')
     AND NOT EXISTS (SELECT 1 FROM freehold.network_payments WHERE cycle_id = p_cycle AND state IS DISTINCT FROM 'FINAL') THEN
    RETURN jsonb_build_object('cycleId', p_cycle, 'state', 'FINAL', 'duplicate', true, 'posted', false);
  END IF;
  IF EXISTS (
    SELECT 1 FROM freehold.network_payments WHERE cycle_id = p_cycle AND state IS DISTINCT FROM 'SETTLEMENT_CONFIRMED'
  ) OR EXISTS (
    SELECT 1 FROM freehold.network_settlement_instructions WHERE cycle_id = p_cycle AND state IS DISTINCT FROM 'CONFIRMED_SIMULATED'
  ) THEN RAISE EXCEPTION 'NETWORK_NOT_CONFIRMED' USING ERRCODE = '22023'; END IF;
  FOR pay IN SELECT * FROM freehold.network_payments WHERE cycle_id = p_cycle AND state = 'SETTLEMENT_CONFIRMED' ORDER BY id LOOP
    SELECT id INTO clearing FROM freehold.institution_ledger_accounts
    WHERE institution_id = pay.origin_institution_id AND kind = 'CLEARING' AND currency_code = pay.currency_code LIMIT 1;
    SELECT id INTO receivable FROM freehold.institution_ledger_accounts
    WHERE institution_id = pay.beneficiary_institution_id AND kind = 'SETTLEMENT_RECEIVABLE' AND currency_code = pay.currency_code LIMIT 1;
    IF clearing IS NULL OR receivable IS NULL THEN RAISE EXCEPTION 'NETWORK_CLEARING_MISSING' USING ERRCODE = '55000'; END IF;
    origin_journal := freehold._institution_post(
      pay.origin_institution_id, entity, pay.currency_code, 'NETWORK_FINAL',
      'netfinal:' || pay.id::text || ':origin', pay.correlation_id,
      'SIMULATED_NETWORK_SETTLEMENT_NOT_EXTERNAL',
      jsonb_build_array(
        jsonb_build_object('account', pay.origin_account_id, 'side', 'DEBIT', 'amount', pay.amount_minor::text),
        jsonb_build_object('account', clearing, 'side', 'CREDIT', 'amount', pay.amount_minor::text)));
    beneficiary_journal := freehold._institution_post(
      pay.beneficiary_institution_id, entity, pay.currency_code, 'NETWORK_FINAL',
      'netfinal:' || pay.id::text || ':beneficiary', pay.correlation_id,
      'SIMULATED_NETWORK_SETTLEMENT_NOT_EXTERNAL',
      jsonb_build_array(
        jsonb_build_object('account', receivable, 'side', 'DEBIT', 'amount', pay.amount_minor::text),
        jsonb_build_object('account', pay.beneficiary_account_id, 'side', 'CREDIT', 'amount', pay.amount_minor::text)));
    PERFORM freehold._network_writer();
    UPDATE freehold.network_payments SET
      state = 'FINAL', finality = 'SIMULATED_NET_FINAL',
      finality_mechanism = 'SIMULATED_NET_SETTLEMENT_NOT_EXTERNAL',
      origin_journal_id = origin_journal, beneficiary_journal_id = beneficiary_journal
    WHERE id = pay.id AND state = 'SETTLEMENT_CONFIRMED';
    UPDATE freehold.network_obligations SET status = 'SETTLED' WHERE payment_id = pay.id AND status = 'IN_CYCLE';
    PERFORM freehold._institution_emit(
      pay.origin_institution_id, NULL, 'network.payment.final',
      jsonb_build_object('state', 'FINAL', 'simulated', true, 'finality', 'SIMULATED_NET_FINAL', 'externalSettlement', false,
        'networkPaymentId', pay.id, 'amountMinor', pay.amount_minor::text, 'currency', pay.currency_code));
    PERFORM freehold._institution_emit(
      pay.beneficiary_institution_id, NULL, 'network.payment.final',
      jsonb_build_object('state', 'FINAL', 'simulated', true, 'finality', 'SIMULATED_NET_FINAL', 'externalSettlement', false,
        'networkPaymentId', pay.id, 'amountMinor', pay.amount_minor::text, 'currency', pay.currency_code));
    posted := posted + 1;
  END LOOP;
  UPDATE freehold.network_settlement_instructions SET state = 'FINAL'
  WHERE cycle_id = p_cycle AND state = 'CONFIRMED_SIMULATED';
  INSERT INTO freehold.network_outbox(cycle_id, event_type, state) VALUES (p_cycle, 'network.payment.final', 'PENDING');
  RETURN jsonb_build_object('cycleId', p_cycle, 'state', 'FINAL', 'postedPayments', posted, 'duplicate', false,
    'finality', 'SIMULATED_NET_FINAL', 'externalSettlement', false, 'mechanism', 'SIMULATED_NET_SETTLEMENT_NOT_EXTERNAL');
END $$;

CREATE FUNCTION freehold.network_settlement_reverse(p_actor uuid, p_payment uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE
  pay freehold.network_payments;
  entity uuid := '10000000-0000-4000-8000-000000000001';
  clearing uuid;
  receivable uuid;
  origin_journal uuid;
  beneficiary_journal uuid;
BEGIN
  SELECT * INTO pay FROM freehold.network_payments WHERE id = p_payment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NETWORK_PAYMENT' USING ERRCODE = '42501'; END IF;
  PERFORM freehold._network_admin(p_actor);
  IF p_actor = pay.created_by THEN RAISE EXCEPTION 'NETWORK_SELF_APPROVAL' USING ERRCODE = '22023'; END IF;
  IF pay.state = 'REVERSED_BY_NEW_OPERATION' THEN
    RETURN jsonb_build_object('paymentId', pay.id, 'state', pay.state, 'duplicate', true);
  END IF;
  IF pay.state IS DISTINCT FROM 'FINAL' THEN RAISE EXCEPTION 'NETWORK_STATE' USING ERRCODE = '22023'; END IF;
  SELECT id INTO clearing FROM freehold.institution_ledger_accounts
  WHERE institution_id = pay.origin_institution_id AND kind = 'CLEARING' AND currency_code = pay.currency_code LIMIT 1;
  SELECT id INTO receivable FROM freehold.institution_ledger_accounts
  WHERE institution_id = pay.beneficiary_institution_id AND kind = 'SETTLEMENT_RECEIVABLE' AND currency_code = pay.currency_code LIMIT 1;
  origin_journal := freehold._institution_post(
    pay.origin_institution_id, entity, pay.currency_code, 'NETWORK_REVERSAL',
    'netreverse:' || pay.id::text || ':origin', pay.correlation_id,
    'SIMULATED_NETWORK_REVERSAL_NOT_A_DELETE',
    jsonb_build_array(
      jsonb_build_object('account', clearing, 'side', 'DEBIT', 'amount', pay.amount_minor::text),
      jsonb_build_object('account', pay.origin_account_id, 'side', 'CREDIT', 'amount', pay.amount_minor::text)));
  beneficiary_journal := freehold._institution_post(
    pay.beneficiary_institution_id, entity, pay.currency_code, 'NETWORK_REVERSAL',
    'netreverse:' || pay.id::text || ':beneficiary', pay.correlation_id,
    'SIMULATED_NETWORK_REVERSAL_NOT_A_DELETE',
    jsonb_build_array(
      jsonb_build_object('account', pay.beneficiary_account_id, 'side', 'DEBIT', 'amount', pay.amount_minor::text),
      jsonb_build_object('account', receivable, 'side', 'CREDIT', 'amount', pay.amount_minor::text)));
  PERFORM freehold._network_writer();
  UPDATE freehold.network_payments SET
    state = 'REVERSED_BY_NEW_OPERATION',
    reversal_origin_journal_id = origin_journal,
    reversal_beneficiary_journal_id = beneficiary_journal
  WHERE id = pay.id;
  RETURN jsonb_build_object('paymentId', pay.id, 'state', 'REVERSED_BY_NEW_OPERATION', 'originalJournalsKept', true, 'externalSettlement', false);
END $$;

-- NETTED remains a legal payment state. Cycle finalization stores positions and
-- moves payments to SETTLEMENT_PENDING in the same transaction. A NETTED row is
-- not written. Position rows are the netting evidence.

CREATE FUNCTION freehold.network_certificate_public(p_actor uuid, p_cert uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE cert freehold.network_certificates;
BEGIN
  SELECT * INTO cert FROM freehold.network_certificates WHERE id = p_cert;
  IF NOT FOUND THEN RAISE EXCEPTION 'NETWORK_CERT' USING ERRCODE = '42501'; END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, cert.institution_id, 'payments:write');
  RETURN jsonb_build_object(
    'certificateId', cert.id, 'institutionId', cert.institution_id, 'algorithm', cert.algorithm,
    'publicKeyHex', cert.public_key_hex, 'revoked', cert.revoked_at IS NOT NULL,
    'notBefore', cert.not_before, 'notAfter', cert.not_after, 'privateKeyStored', false);
END $$;

CREATE FUNCTION freehold.network_cycle_get(p_actor uuid, p_cycle uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE cycle freehold.network_cycles;
BEGIN
  PERFORM freehold._network_admin(p_actor);
  SELECT * INTO cycle FROM freehold.network_cycles WHERE id = p_cycle;
  IF NOT FOUND THEN RAISE EXCEPTION 'NETWORK_CYCLE' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object(
    'cycleId', cycle.id, 'kind', cycle.kind, 'currency', cycle.currency_code, 'status', cycle.status,
    'failureReason', cycle.failure_reason,
    'netSumMinor', CASE WHEN cycle.net_sum_minor IS NULL THEN NULL ELSE cycle.net_sum_minor::text END,
    'finalizedAtIsFinancialFinality', false, 'externalSettlement', false, 'customerNamesIncluded', false,
    'positions', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'institutionId', institution_id, 'currency', currency_code,
        'grossOutgoingMinor', gross_outgoing_minor::text,
        'grossIncomingMinor', gross_incoming_minor::text,
        'netMinor', net_minor::text
      ) ORDER BY institution_id), '[]'::jsonb)
      FROM freehold.network_cycle_positions WHERE cycle_id = cycle.id),
    'instructions', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'institutionId', institution_id, 'currency', currency_code, 'netMinor', net_minor::text,
        'state', state, 'confirmationSimulated', confirmation_simulated, 'externalSettlement', false
      ) ORDER BY institution_id), '[]'::jsonb)
      FROM freehold.network_settlement_instructions WHERE cycle_id = cycle.id),
    'paymentStates', (
      SELECT COALESCE(jsonb_object_agg(state, n), '{}'::jsonb)
      FROM (SELECT state, count(*) AS n FROM freehold.network_payments WHERE cycle_id = cycle.id GROUP BY state) s));
END $$;

CREATE FUNCTION freehold.network_message_record(
  p_actor uuid, p_payment uuid, p_family text, p_message_id text, p_body text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE pay freehold.network_payments; message uuid;
BEGIN
  SELECT * INTO pay FROM freehold.network_payments WHERE id = p_payment;
  IF NOT FOUND THEN RAISE EXCEPTION 'NETWORK_PAYMENT' USING ERRCODE = '42501'; END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, pay.origin_institution_id, 'payments:write');
  IF p_family NOT IN ('pain.001.001.09','pacs.008.001.08','pacs.002.001.10','pacs.004.001.09','camt.053.001.08') THEN
    RAISE EXCEPTION 'NETWORK_MESSAGE' USING ERRCODE = '22023';
  END IF;
  IF p_message_id IS NULL OR char_length(p_message_id) < 8 OR char_length(p_message_id) > 80
     OR p_body IS NULL OR char_length(p_body) < 1 OR char_length(p_body) > 8000
     OR position(p_family IN p_body) = 0 OR position(p_message_id IN p_body) = 0 THEN
    RAISE EXCEPTION 'NETWORK_MESSAGE' USING ERRCODE = '22023';
  END IF;
  PERFORM freehold._network_writer();
  BEGIN
    INSERT INTO freehold.network_messages(payment_id, family, message_id, body)
    VALUES (pay.id, p_family, p_message_id, p_body)
    RETURNING id INTO message;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'NETWORK_MESSAGE_DUPLICATE' USING ERRCODE = '55000';
  END;
  RETURN jsonb_build_object(
    'messageId', message, 'family', p_family, 'businessMessageId', p_message_id,
    'certification', false, 'liveSend', false, 'schemaScope', 'SIMULATED_SUBSET');
END $$;

CREATE FUNCTION freehold.network_dashboard(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE
  cycles bigint;
  gross text;
  excluded bigint;
  concentration text;
  backlog bigint;
BEGIN
  PERFORM freehold._network_admin(p_actor);
  SELECT count(*) INTO cycles FROM freehold.network_cycles;
  SELECT COALESCE(sum(amount_minor), 0)::text INTO gross
  FROM freehold.network_obligations WHERE status IN ('OPEN','IN_CYCLE','SETTLED');
  SELECT count(*) INTO excluded FROM freehold.network_obligations WHERE status IN ('CANCELED','EXCLUDED') OR NOT eligible;
  SELECT CASE WHEN COALESCE(sum(abs(net_minor)), 0) = 0 THEN '0'
              ELSE (max(abs(net_minor)) * 10000 / sum(abs(net_minor)))::text END
    INTO concentration FROM freehold.network_cycle_positions;
  SELECT count(*) INTO backlog FROM freehold.network_outbox WHERE state IN ('PENDING','LEASED');
  RETURN jsonb_build_object(
    'simulationOnly', true, 'liveRails', false, 'licensedPaymentSystem', false,
    'customerNamesIncluded', false, 'recordedPositionsAreNotIndependentVerification', true,
    'independentVerificationStored', false,
    'emptyMessage', CASE WHEN cycles = 0 THEN 'No simulated network cycle is recorded.' ELSE NULL END,
    'membership', jsonb_build_object(
      'active', (SELECT count(*) FROM freehold.network_members WHERE status = 'ACTIVE_SIMULATION'),
      'suspended', (SELECT count(*) FROM freehold.network_members WHERE status = 'SUSPENDED'),
      'pending', (SELECT count(*) FROM freehold.network_members WHERE status IN ('APPLICANT','UNDER_REVIEW','APPROVED_FOR_SIMULATION')),
      'terminated', (SELECT count(*) FROM freehold.network_members WHERE status = 'TERMINATED'),
      'rulebookAccepted', (SELECT count(*) FROM freehold.network_rulebook_acceptances),
      'members', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'institutionId', institution_id, 'status', status, 'riskClass', risk_class,
          'currencies', currencies, 'rulebookId', rulebook_id, 'liveAuthorized', false
        ) ORDER BY created_at), '[]'::jsonb) FROM freehold.network_members)),
    'payments', jsonb_build_object(
      'instructions', (SELECT count(*) FROM freehold.network_payments),
      'pending', (SELECT count(*) FROM freehold.network_payments WHERE state IN (
        'CREATED','VALIDATED','CLEARED','NETTED','SETTLEMENT_PENDING','SETTLEMENT_SUBMITTED','SETTLEMENT_CONFIRMED')),
      'failed', (SELECT count(*) FROM freehold.network_payments WHERE state IN ('FAILED','REJECTED','CANCELLED','UNKNOWN')),
      'routingExceptions', (SELECT count(*) FROM freehold.network_cycles WHERE failure_reason IS NOT NULL)),
    'clearing', jsonb_build_object(
      'cycles', cycles,
      'openCycles', (SELECT count(*) FROM freehold.network_cycles WHERE status = 'OPEN'),
      'finalizedCycles', (SELECT count(*) FROM freehold.network_cycles WHERE status = 'FINALIZED'),
      'failedCycles', (SELECT count(*) FROM freehold.network_cycles WHERE status = 'FAILED'),
      'grossObligationsMinor', gross,
      'excludedObligations', excluded,
      'positions', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'cycleId', cycle_id, 'institutionId', institution_id, 'currency', currency_code,
          'grossOutgoingMinor', gross_outgoing_minor::text, 'grossIncomingMinor', gross_incoming_minor::text,
          'netMinor', net_minor::text
        ) ORDER BY cycle_id, institution_id), '[]'::jsonb)
        FROM (
          SELECT * FROM freehold.network_cycle_positions ORDER BY cycle_id DESC, institution_id LIMIT 30
        ) recent)),
    'settlement', jsonb_build_object(
      'pendingInstructions', (SELECT count(*) FROM freehold.network_settlement_instructions WHERE state IN ('PENDING','SUBMITTED')),
      'simulatedConfirmations', (SELECT count(*) FROM freehold.network_settlement_instructions WHERE state = 'CONFIRMED_SIMULATED'),
      'final', (SELECT count(*) FROM freehold.network_settlement_instructions WHERE state = 'FINAL'),
      'failed', (SELECT count(*) FROM freehold.network_settlement_instructions WHERE state = 'FAILED'),
      'unknown', (SELECT count(*) FROM freehold.network_settlement_instructions WHERE state = 'UNKNOWN')),
    'risk', jsonb_build_object(
      'zeroOpeningActiveMembers', (SELECT count(*) FROM freehold.network_members WHERE status = 'ACTIVE_SIMULATION' AND opening_liquidity_minor = 0),
      'concentrationBps', concentration,
      'staleSettlementEvidence', (SELECT count(*) FROM freehold.network_settlement_instructions WHERE state IN ('SUBMITTED','UNKNOWN')),
      'runs', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'scenario', scenario, 'inventedFunding', invented_funding, 'mutatedAccounts', mutated_accounts
        ) ORDER BY created_at DESC), '[]'::jsonb)
        FROM (SELECT * FROM freehold.network_risk_runs ORDER BY created_at DESC LIMIT 10) recent)),
    'integrity', jsonb_build_object(
      'workerBacklog', backlog,
      'signatureCheck', 'NOT_RUN_BY_DASHBOARD',
      'independentVerification', 'SEPARATE_READ_ONLY_PROCESS'));
END $$;

CREATE FUNCTION freehold.network_stress(p_actor uuid, p_institution uuid, p_scenario text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE
  member freehold.network_members;
  before_inst numeric;
  after_inst numeric;
  before_cust numeric;
  after_cust numeric;
  before_journals bigint;
  after_journals bigint;
  result jsonb;
  assumptions jsonb;
BEGIN
  PERFORM freehold._network_admin(p_actor);
  IF p_scenario NOT IN (
    'MEMBER_FAILS_TO_SETTLE','LIQUIDITY_LOSS','OUTGOING_SURGE','DEBIT_LIMIT_EXCEEDED',
    'PROVIDER_OUTAGE','SUSPENDED_DURING_CLEARING','DELAYED_CONFIRMATION','DUPLICATE_MESSAGE',
    'UNEXPECTED_RETURN','CORRUPTED_EVIDENCE'
  ) THEN RAISE EXCEPTION 'NETWORK_RISK' USING ERRCODE = '22023'; END IF;
  SELECT * INTO member FROM freehold.network_members WHERE institution_id = p_institution;
  IF NOT FOUND THEN RAISE EXCEPTION 'NETWORK_MEMBER' USING ERRCODE = '42501'; END IF;
  SELECT COALESCE(sum(balance_minor), 0), (SELECT count(*) FROM freehold.institution_journals)
    INTO before_inst, before_journals FROM freehold.institution_ledger_accounts;
  SELECT COALESCE(sum(available_minor), 0) INTO before_cust FROM freehold.accounts;
  assumptions := jsonb_build_object(
    'institutionId', p_institution, 'actualStatus', member.status,
    'actualOpeningMinor', member.opening_liquidity_minor::text,
    'simulationOnly', true, 'centralBankBalanceCreated', false);
  result := CASE p_scenario
    WHEN 'MEMBER_FAILS_TO_SETTLE' THEN jsonb_build_object('modeledOutcome', 'UNSETTLED', 'posted', false)
    WHEN 'LIQUIDITY_LOSS' THEN jsonb_build_object('modeledAvailableMinor', '0', 'openingUnchanged', true, 'posted', false)
    WHEN 'OUTGOING_SURGE' THEN jsonb_build_object(
      'modeledOutgoingMinor', (COALESCE((
        SELECT sum(amount_minor) FROM freehold.network_obligations
        WHERE origin_institution_id = p_institution AND status = 'OPEN'), 0) * 3)::text,
      'posted', false)
    WHEN 'DEBIT_LIMIT_EXCEEDED' THEN jsonb_build_object(
      'modeledPayableMinor', (member.net_debit_limit_minor + 1)::text, 'breach', true, 'limitUnchanged', true, 'posted', false)
    WHEN 'PROVIDER_OUTAGE' THEN jsonb_build_object('modeledFinality', 'UNKNOWN', 'providerAcknowledgementIsFinal', false, 'posted', false)
    WHEN 'SUSPENDED_DURING_CLEARING' THEN jsonb_build_object('modeledStatus', 'SUSPENDED', 'actualStatus', member.status, 'posted', false)
    WHEN 'DELAYED_CONFIRMATION' THEN jsonb_build_object('modeledState', 'SETTLEMENT_SUBMITTED', 'final', false, 'posted', false)
    WHEN 'DUPLICATE_MESSAGE' THEN jsonb_build_object('duplicate', true, 'secondPost', false, 'posted', false)
    WHEN 'UNEXPECTED_RETURN' THEN jsonb_build_object('modeledOperation', 'REVERSED_BY_NEW_OPERATION', 'journalCreated', false, 'posted', false)
    ELSE jsonb_build_object('modeledVerifierOutcome', 'MISMATCH', 'rowCorrupted', false, 'posted', false)
  END;
  result := result || jsonb_build_object(
    'scenario', p_scenario, 'inventedFunding', false, 'mutatedAccounts', false,
    'regulatoryDetermination', false, 'externalSettlement', false);
  PERFORM freehold._network_writer();
  INSERT INTO freehold.network_risk_runs(scenario, assumptions, result)
  VALUES (p_scenario, assumptions, result);
  SELECT COALESCE(sum(balance_minor), 0), (SELECT count(*) FROM freehold.institution_journals)
    INTO after_inst, after_journals FROM freehold.institution_ledger_accounts;
  SELECT COALESCE(sum(available_minor), 0) INTO after_cust FROM freehold.accounts;
  IF before_inst IS DISTINCT FROM after_inst OR before_cust IS DISTINCT FROM after_cust
     OR before_journals IS DISTINCT FROM after_journals OR member.status IS DISTINCT FROM (
       SELECT status FROM freehold.network_members WHERE institution_id = p_institution
     ) THEN
    RAISE EXCEPTION 'NETWORK_RISK' USING ERRCODE = '55000';
  END IF;
  RETURN result || jsonb_build_object('assumptions', assumptions);
END $$;

CREATE FUNCTION freehold.network_activate_live(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
BEGIN
  PERFORM freehold._network_admin(p_actor);
  RAISE EXCEPTION 'LIVE_MONETARY_ACTIVATION_REFUSED' USING ERRCODE = '42501';
END $$;

CREATE FUNCTION freehold.network_outbox_claim(p_worker uuid, p_lease_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE claimed integer; ids jsonb;
BEGIN
  PERFORM freehold._network_writer();
  WITH picked AS (
    SELECT id FROM freehold.network_outbox
    WHERE state = 'PENDING' OR (state = 'LEASED' AND lease_until < clock_timestamp())
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 20
  ), upd AS (
    UPDATE freehold.network_outbox o SET
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

CREATE FUNCTION freehold.network_outbox_complete(p_worker uuid, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE before_count bigint; after_count bigint; updated integer;
BEGIN
  PERFORM freehold._network_writer();
  SELECT count(*) INTO before_count FROM freehold.network_payments;
  UPDATE freehold.network_outbox SET state = 'DONE', lease_until = NULL
  WHERE id = p_id AND state = 'LEASED' AND claimed_by = p_worker;
  GET DIAGNOSTICS updated = ROW_COUNT;
  SELECT count(*) INTO after_count FROM freehold.network_payments;
  IF before_count IS DISTINCT FROM after_count THEN RAISE EXCEPTION 'NETWORK_OUTBOX' USING ERRCODE = '55000'; END IF;
  RETURN jsonb_build_object('outboxId', p_id, 'done', updated = 1, 'paymentRowsUnchanged', true, 'postsPayments', false);
END $$;

REVOKE ALL ON FUNCTION freehold._network_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._network_writer() FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._network_admin(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._network_audit(uuid, uuid, uuid, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._network_rulebook_ok(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._network_payload(uuid, uuid, uuid, uuid, text, bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._network_cycle_fail(uuid, text) FROM PUBLIC;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'network_rulebook_propose(uuid,text,jsonb)',
    'network_rulebook_adopt(uuid,uuid)',
    'network_member_apply(uuid,uuid)',
    'network_member_transition(uuid,uuid,text)',
    'network_member_currencies(uuid,uuid,text[])',
    'network_rulebook_accept(uuid,uuid,uuid)',
    'network_certificate_register(uuid,uuid,text,timestamp with time zone,timestamp with time zone)',
    'network_certificate_revoke(uuid,uuid,uuid)',
    'network_certificate_public(uuid,uuid)',
    'network_liquidity_set(uuid,uuid,bigint,bigint,bigint)',
    'network_payment_open(uuid,uuid,uuid,uuid,uuid,bigint,text,text,uuid,uuid,text,text,integer)',
    'network_payment_validate(uuid,uuid)',
    'network_payment_cancel(uuid,uuid)',
    'network_payment_reject(uuid,uuid)',
    'network_payment_get(uuid,uuid,uuid)',
    'network_cycle_build(uuid,text,text,uuid[])',
    'network_cycle_finalize(uuid,uuid)',
    'network_cycle_get(uuid,uuid)',
    'network_settlement_submit(uuid,uuid)',
    'network_settlement_confirm(uuid,uuid,text)',
    'network_settlement_unknown(uuid,uuid)',
    'network_settlement_finalize(uuid,uuid)',
    'network_settlement_reverse(uuid,uuid)',
    'network_message_record(uuid,uuid,text,text,text)',
    'network_dashboard(uuid)',
    'network_stress(uuid,uuid,text)',
    'network_activate_live(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION freehold.%s FROM PUBLIC, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION freehold.%s TO freehold_api', fn);
  END LOOP;
  EXECUTE 'REVOKE ALL ON FUNCTION freehold.network_outbox_claim(uuid, integer) FROM PUBLIC, freehold_api, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup';
  EXECUTE 'REVOKE ALL ON FUNCTION freehold.network_outbox_complete(uuid, uuid) FROM PUBLIC, freehold_api, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup';
  EXECUTE 'GRANT EXECUTE ON FUNCTION freehold.network_outbox_claim(uuid, integer) TO freehold_worker';
  EXECUTE 'GRANT EXECUTE ON FUNCTION freehold.network_outbox_complete(uuid, uuid) TO freehold_worker';
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA freehold FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._network_guard() FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._network_writer() FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._network_admin(uuid) FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._network_audit(uuid, uuid, uuid, text, text, text, jsonb) FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._network_rulebook_ok(jsonb) FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._network_payload(uuid, uuid, uuid, uuid, text, bigint, text, text) FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._network_cycle_fail(uuid, text) FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;

REVOKE ALL ON TABLE
  freehold.network_rulebooks, freehold.network_members, freehold.network_rulebook_acceptances, freehold.network_member_audit,
  freehold.network_certificates, freehold.network_nonces, freehold.network_cycles, freehold.network_payments,
  freehold.network_obligations, freehold.network_cycle_positions, freehold.network_settlement_instructions,
  freehold.network_messages, freehold.network_risk_runs, freehold.network_outbox
FROM PUBLIC, freehold_api, freehold_worker, freehold_auth, freehold_scheduler, freehold_backup, freehold_app;

GRANT SELECT ON
  freehold.network_rulebooks, freehold.network_members, freehold.network_rulebook_acceptances, freehold.network_member_audit,
  freehold.network_certificates, freehold.network_nonces, freehold.network_cycles, freehold.network_payments,
  freehold.network_obligations, freehold.network_cycle_positions, freehold.network_settlement_instructions,
  freehold.network_messages, freehold.network_risk_runs, freehold.network_outbox
TO freehold_verifier;

RESET ROLE;
