-- Phase 10 simulation only. This migration does not alter customer journals,
-- accounts, or historical rows. Live issuance cannot be turned on here:
-- the book checks reject it, and monetary_activate_live always raises.
-- A superuser can drop those checks. That is an infrastructure trust boundary,
-- not a control this schema claims to defeat.
-- The supply cap is a cap on outstanding units plus pending issuance, not on
-- lifetime issuance. Coverage compares eligible simulated reserves with
-- outstanding plus pending issuance. Reserves are not decremented when units
-- are issued.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;

CREATE TABLE freehold.legal_entities (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('SOFTWARE_PROVIDER','BANKING_PARTNER','PAYMENT_STABLECOIN_ISSUER','RESERVE_CUSTODIAN','EXPERIMENTAL_MONETARY_SANDBOX')),
  display_name text NOT NULL,
  simulation_only boolean NOT NULL CHECK (simulation_only),
  live_authorized boolean NOT NULL CHECK (NOT live_authorized),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE freehold.monetary_products (
  code text PRIMARY KEY,
  liability_domain text NOT NULL,
  insured boolean NOT NULL CHECK (NOT insured),
  legal_tender boolean NOT NULL CHECK (NOT legal_tender),
  government_guaranteed boolean NOT NULL CHECK (NOT government_guaranteed),
  authorized_payment_stablecoin boolean NOT NULL CHECK (NOT authorized_payment_stablecoin)
);

CREATE TABLE freehold.monetary_books (
  id uuid PRIMARY KEY,
  entity_id uuid NOT NULL REFERENCES freehold.legal_entities(id),
  product_code text NOT NULL REFERENCES freehold.monetary_products(code),
  code text NOT NULL UNIQUE,
  unit_code text NOT NULL,
  cap_basis text NOT NULL CHECK (cap_basis = 'OUTSTANDING'),
  authorized_max_outstanding bigint NOT NULL CHECK (authorized_max_outstanding >= 0),
  simulation_only boolean NOT NULL CHECK (simulation_only),
  live_issuance_enabled boolean NOT NULL CHECK (NOT live_issuance_enabled),
  issuance_suspended boolean NOT NULL DEFAULT false,
  redemption_suspended boolean NOT NULL DEFAULT false,
  suspended_by uuid
);

CREATE TABLE freehold.monetary_supply (
  book_id uuid PRIMARY KEY REFERENCES freehold.monetary_books(id),
  issued_lifetime bigint NOT NULL DEFAULT 0 CHECK (issued_lifetime >= 0),
  redeemed_lifetime bigint NOT NULL DEFAULT 0 CHECK (redeemed_lifetime >= 0),
  outstanding bigint NOT NULL DEFAULT 0 CHECK (outstanding >= 0),
  pending_issuance bigint NOT NULL DEFAULT 0 CHECK (pending_issuance >= 0),
  pending_redemption bigint NOT NULL DEFAULT 0 CHECK (pending_redemption >= 0),
  frozen_units bigint NOT NULL DEFAULT 0 CHECK (frozen_units >= 0),
  treasury_units bigint NOT NULL DEFAULT 0 CHECK (treasury_units >= 0),
  customer_units bigint NOT NULL DEFAULT 0 CHECK (customer_units >= 0),
  corrections bigint NOT NULL DEFAULT 0,
  CHECK (outstanding = issued_lifetime - redeemed_lifetime + corrections),
  CHECK (outstanding = customer_units + treasury_units + frozen_units + pending_redemption)
);

CREATE TABLE freehold.monetary_holders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES freehold.monetary_books(id),
  holder_kind text NOT NULL CHECK (holder_kind IN ('CUSTOMER','TREASURY','FROZEN','PENDING_REDEMPTION')),
  holder_ref uuid,
  units bigint NOT NULL DEFAULT 0 CHECK (units >= 0)
);
CREATE UNIQUE INDEX monetary_holder_ref_uidx ON freehold.monetary_holders (book_id, holder_kind, holder_ref) WHERE holder_ref IS NOT NULL;
CREATE UNIQUE INDEX monetary_holder_pool_uidx ON freehold.monetary_holders (book_id, holder_kind) WHERE holder_ref IS NULL;

CREATE TABLE freehold.monetary_journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES freehold.monetary_books(id),
  entity_id uuid NOT NULL REFERENCES freehold.legal_entities(id),
  operation_id uuid NOT NULL UNIQUE,
  kind text NOT NULL,
  memo text NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE freehold.monetary_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id uuid NOT NULL REFERENCES freehold.monetary_journals(id),
  entity_id uuid NOT NULL REFERENCES freehold.legal_entities(id),
  account_code text NOT NULL,
  side text NOT NULL CHECK (side IN ('DEBIT','CREDIT')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0)
);

CREATE TABLE freehold.monetary_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid,
  book_id uuid,
  action text NOT NULL,
  actor_id uuid,
  detail jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE freehold.reserve_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES freehold.monetary_books(id),
  legal_owner_entity_id uuid NOT NULL REFERENCES freehold.legal_entities(id),
  custodian_entity_id uuid NOT NULL REFERENCES freehold.legal_entities(id),
  category text NOT NULL CHECK (category IN (
    'USD_CASH','FED_BALANCE','DEMAND_DEPOSIT_INSURED','TREASURY_MAX_93_DAYS',
    'OVERNIGHT_TREASURY_REPO','OVERNIGHT_TREASURY_REVERSE_REPO','GOVERNMENT_MMF',
    'TOKENIZED_CASH','TOKENIZED_DEPOSIT','TOKENIZED_TREASURY','TOKENIZED_MMF','TOKENIZED_REPO',
    'REGULATOR_APPROVED_LIQUID','OTHER_INELIGIBLE')),
  asset_ref text NOT NULL UNIQUE,
  currency_code text NOT NULL CHECK (currency_code = 'USD'),
  quantity_minor bigint NOT NULL CHECK (quantity_minor >= 0),
  valuation_minor bigint NOT NULL CHECK (valuation_minor >= 0 AND valuation_minor <= quantity_minor),
  valuation_date date NOT NULL,
  maturity_date date,
  encumbered boolean NOT NULL DEFAULT false,
  evidence_state text NOT NULL CHECK (evidence_state IN ('UNVERIFIED','PENDING_CONFIRMATION','VERIFIED','REJECTED','STALE')),
  evidence_scope text NOT NULL CHECK (evidence_scope = 'SIMULATED'),
  same_rights boolean NOT NULL DEFAULT false,
  insured_depository boolean NOT NULL DEFAULT false,
  proposer_id uuid NOT NULL,
  reviewer_id uuid,
  verified_at timestamptz,
  CHECK (custodian_entity_id <> legal_owner_entity_id),
  CHECK (reviewer_id IS NULL OR reviewer_id <> proposer_id),
  CHECK (evidence_state <> 'VERIFIED' OR (reviewer_id IS NOT NULL AND verified_at IS NOT NULL))
);

CREATE TABLE freehold.issuer_capital (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES freehold.legal_entities(id),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  note text NOT NULL,
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE freehold.monetary_capabilities (
  principal_id uuid NOT NULL REFERENCES freehold.users(id),
  capability text NOT NULL CHECK (capability IN (
    'ISSUANCE_AUTHORITY','REDEMPTION_AUTHORITY','RESERVE_MANAGEMENT','TREASURY',
    'COMPLIANCE_OFFICER','FINANCIAL_RISK','SECURITY_ADMIN','INDEPENDENT_AUDIT',
    'EMERGENCY_CONTROL','GOVERNANCE_POLICY')),
  granted_by uuid,
  grant_source text NOT NULL CHECK (grant_source IN ('SIMULATION_BOOTSTRAP','GRANT')),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY (principal_id, capability),
  CHECK (granted_by IS NULL OR granted_by <> principal_id),
  CHECK (grant_source <> 'SELF')
);

CREATE TABLE freehold.issuance_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES freehold.monetary_books(id),
  idempotency_key text NOT NULL,
  requester_id uuid NOT NULL,
  approver_id uuid,
  executor_id uuid,
  unknown_marked_by uuid,
  holder_ref uuid,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  state text NOT NULL CHECK (state IN (
    'REQUESTED','PENDING_RESERVE_VERIFICATION','PENDING_APPROVAL','APPROVED',
    'EXECUTING','ISSUED','REJECTED','FAILED','UNKNOWN')),
  journal_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (book_id, idempotency_key),
  CHECK (approver_id IS NULL OR approver_id <> requester_id),
  CHECK (executor_id IS NULL OR (executor_id <> requester_id AND executor_id IS DISTINCT FROM approver_id))
);
CREATE TABLE freehold.redemption_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES freehold.monetary_books(id),
  idempotency_key text NOT NULL,
  requester_id uuid NOT NULL,
  holder_ref uuid,
  settlement_actor uuid,
  finalizer_id uuid,
  unknown_marked_by uuid,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  state text NOT NULL CHECK (state IN (
    'REQUESTED','VALIDATING','UNITS_SECURED','PENDING_SETTLEMENT','SETTLEMENT_CONFIRMED',
    'REDEEMED','FAILED','EXCEPTION','UNKNOWN')),
  journal_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (book_id, idempotency_key),
  CHECK (settlement_actor IS NULL OR settlement_actor <> requester_id),
  CHECK (finalizer_id IS NULL OR (finalizer_id <> requester_id AND finalizer_id IS DISTINCT FROM settlement_actor))
);
CREATE TABLE freehold.settlement_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  redemption_id uuid NOT NULL REFERENCES freehold.redemption_operations(id),
  evidence_scope text NOT NULL CHECK (evidence_scope = 'SIMULATED'),
  external_final boolean NOT NULL CHECK (NOT external_final),
  outcome text NOT NULL CHECK (outcome IN ('SETTLEMENT_CONFIRMED','FAILED','EXCEPTION')),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE freehold.bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES freehold.legal_entities(id),
  customer_account_id uuid NOT NULL REFERENCES freehold.accounts(id),
  external_ref text NOT NULL,
  state text NOT NULL CHECK (state IN ('CREATED','ACKNOWLEDGED','FAILED')),
  simulation_only boolean NOT NULL CHECK (simulation_only),
  UNIQUE (customer_account_id)
);
CREATE TABLE freehold.bank_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id uuid NOT NULL REFERENCES freehold.bank_accounts(id),
  kind text NOT NULL CHECK (kind IN ('ACCOUNT_OPEN','DEPOSIT','WITHDRAWAL','RETURN')),
  external_id text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  state text NOT NULL CHECK (state IN ('CREATED','PENDING','SUBMITTED','ACKNOWLEDGED','SETTLED','FAILED','RETURNED','UNKNOWN')),
  signature_ok boolean NOT NULL,
  evidence_scope text NOT NULL CHECK (evidence_scope = 'SIMULATED'),
  internal_journal_id uuid CHECK (internal_journal_id IS NULL),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (bank_account_id, external_id)
);

CREATE TABLE freehold.monetary_cap_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES freehold.monetary_books(id),
  idempotency_key text NOT NULL,
  requester_id uuid NOT NULL,
  approver_id uuid,
  proposed_max bigint NOT NULL CHECK (proposed_max >= 0),
  state text NOT NULL CHECK (state IN ('PENDING','APPROVED','REJECTED')),
  UNIQUE (book_id, idempotency_key),
  CHECK (approver_id IS NULL OR approver_id <> requester_id)
);

CREATE TABLE freehold.cross_entity_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  obligor_entity_id uuid NOT NULL REFERENCES freehold.legal_entities(id),
  obligee_entity_id uuid REFERENCES freehold.legal_entities(id),
  counterparty_user_id uuid,
  book_id uuid NOT NULL REFERENCES freehold.monetary_books(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  state text NOT NULL CHECK (state IN ('SIMULATED_OPEN','SIMULATED_FAILED','CANCELLED')),
  claim_kind text NOT NULL,
  CHECK (obligee_entity_id IS NULL OR obligor_entity_id <> obligee_entity_id),
  CHECK (counterparty_user_id IS NOT NULL OR obligee_entity_id IS NOT NULL)
);

CREATE TABLE freehold.chain_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES freehold.monetary_books(id),
  network text NOT NULL CHECK (network IN ('MOCK','LOCAL_DEV')),
  kind text NOT NULL CHECK (kind IN ('ISSUE','BURN','TRANSFER')),
  tx_ref text NOT NULL,
  finality text NOT NULL CHECK (finality IN ('NOT_FINAL','FINAL','REORGED','INTERRUPTED','REPLACED')),
  confirmation_depth integer NOT NULL CHECK (confirmation_depth >= 0),
  observed_amount bigint NOT NULL,
  observed_by uuid NOT NULL,
  UNIQUE (network, tx_ref)
);
CREATE TABLE freehold.monetary_signing_posts (
  id uuid PRIMARY KEY,
  book_id uuid NOT NULL REFERENCES freehold.monetary_books(id),
  purpose text NOT NULL CHECK (purpose IN ('UNASSIGNED_HSM','UNASSIGNED_KMS')),
  key_material_present boolean NOT NULL CHECK (NOT key_material_present)
);

CREATE TABLE freehold.regulatory_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES freehold.legal_entities(id),
  book_id uuid NOT NULL REFERENCES freehold.monetary_books(id),
  framework text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  state text NOT NULL CHECK (state IN (
    'DRAFT','PENDING_REVIEW','APPROVED_INTERNALLY','EXTERNAL_REVIEW_REQUIRED',
    'READY_FOR_AUTHORIZED_SUBMISSION','SUBMITTED_WITH_EVIDENCE','REJECTED','INCOMPLETE')),
  submission_status text NOT NULL CHECK (submission_status = 'NOT_SUBMITTED'),
  certification_status text NOT NULL CHECK (certification_status = 'NOT_CERTIFIED'),
  external_evidence_status text NOT NULL CHECK (external_evidence_status = 'UNAVAILABLE'),
  body jsonb NOT NULL,
  created_by uuid NOT NULL,
  CHECK (period_end >= period_start)
);

CREATE TABLE freehold.monetary_compliance_profiles (
  user_id uuid PRIMARY KEY REFERENCES freehold.users(id),
  risk_class text NOT NULL CHECK (risk_class IN ('UNRATED','LOW','MEDIUM','HIGH')),
  identity_status text NOT NULL CHECK (identity_status IN ('UNVERIFIED','SIMULATED_REVIEW','SIMULATED_MATCH')),
  beneficial_owner_status text NOT NULL CHECK (beneficial_owner_status IN ('NOT_REVIEWED','SIMULATED_ATTESTATION')),
  program_status text NOT NULL CHECK (program_status = 'NOT_A_BSA_PROGRAM')
);
CREATE TABLE freehold.monetary_screenings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_ref text NOT NULL,
  provider text NOT NULL CHECK (provider = 'SIMULATED'),
  disposition text NOT NULL CHECK (disposition IN ('SIMULATED_NO_HIT','POTENTIAL_MATCH','PROVIDER_ERROR')),
  human_review_required boolean NOT NULL CHECK (human_review_required),
  determination text NOT NULL CHECK (determination = 'NOT_AN_OFAC_DETERMINATION'),
  idempotency_key text NOT NULL UNIQUE,
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE freehold.monetary_restrictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id uuid NOT NULL REFERENCES freehold.users(id),
  kind text NOT NULL CHECK (kind IN ('REVIEW','BLOCK_SIMULATED_ISSUANCE','BLOCK_SIMULATED_REDEMPTION')),
  reason text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  CHECK (created_by <> subject_user_id)
);
CREATE TABLE freehold.regulator_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES freehold.legal_entities(id),
  status text NOT NULL CHECK (status IN ('OPEN','IN_REVIEW','RESPONDED_INTERNALLY','NOT_SUBMITTED')),
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE freehold.product_disclosures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code text NOT NULL REFERENCES freehold.monetary_products(code),
  version text NOT NULL,
  body text NOT NULL,
  UNIQUE (product_code, version)
);
CREATE TABLE freehold.supply_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES freehold.monetary_books(id),
  amount_minor bigint NOT NULL,
  reason text NOT NULL,
  requester_id uuid NOT NULL,
  approver_id uuid NOT NULL,
  CHECK (approver_id <> requester_id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE freehold.monetary_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES freehold.monetary_books(id),
  severity text NOT NULL CHECK (severity = 'CRITICAL'),
  code text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acknowledged_by uuid,
  acknowledged_at timestamptz
);
CREATE TABLE freehold.conversion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES freehold.accounts(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  state text NOT NULL CHECK (state = 'REJECTED'),
  reason text NOT NULL CHECK (reason = 'UNBACKED_CONVERSION_REFUSED'),
  idempotency_key text NOT NULL UNIQUE,
  available_before bigint NOT NULL,
  available_after bigint NOT NULL,
  CHECK (available_before = available_after)
);

INSERT INTO freehold.legal_entities(id, code, kind, display_name, simulation_only, live_authorized) VALUES
  ('10000000-0000-4000-8000-000000000001','FREEHOLD_TECHNOLOGIES','SOFTWARE_PROVIDER','Freehold Technologies (software only)',true,false),
  ('10000000-0000-4000-8000-000000000002','BANK_PARTNER_UNASSIGNED','BANKING_PARTNER','No banking partner is appointed',true,false),
  ('10000000-0000-4000-8000-000000000003','FUSD_ISSUER_PROPOSED','PAYMENT_STABLECOIN_ISSUER','Proposed FUSD issuer (not approved)',true,false),
  ('10000000-0000-4000-8000-000000000004','RESERVE_CUSTODIAN_UNASSIGNED','RESERVE_CUSTODIAN','No reserve custodian is appointed',true,false),
  ('10000000-0000-4000-8000-000000000005','FHU_SANDBOX','EXPERIMENTAL_MONETARY_SANDBOX','FHU experimental sandbox',true,false);
INSERT INTO freehold.monetary_products(code, liability_domain, insured, legal_tender, government_guaranteed, authorized_payment_stablecoin) VALUES
  ('USD_BANK_DEPOSIT','BANK_PARTNER_DEPOSIT',false,false,false,false),
  ('NONDEPOSIT_STORED_VALUE','STORED_VALUE',false,false,false,false),
  ('PAYMENT_STABLECOIN','ISSUER_REDEMPTION_LIABILITY',false,false,false,false),
  ('EXPERIMENTAL_UNIT','SANDBOX_EXPERIMENT',false,false,false,false);
INSERT INTO freehold.monetary_books(id, entity_id, product_code, code, unit_code, cap_basis, authorized_max_outstanding, simulation_only, live_issuance_enabled) VALUES
  ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','PAYMENT_STABLECOIN','FUSD_SIM','FUSD','OUTSTANDING',1000000000000,true,false),
  ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000005','EXPERIMENTAL_UNIT','FHU_SIM','FHU','OUTSTANDING',1000000,true,false);
INSERT INTO freehold.monetary_supply(book_id) VALUES
  ('20000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000002');
INSERT INTO freehold.monetary_holders(book_id, holder_kind, holder_ref, units)
SELECT b.id, k.kind, NULL, 0
FROM freehold.monetary_books b
CROSS JOIN (VALUES ('TREASURY'),('FROZEN'),('PENDING_REDEMPTION')) AS k(kind);
INSERT INTO freehold.monetary_signing_posts(id, book_id, purpose, key_material_present) VALUES
  ('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','UNASSIGNED_HSM',false),
  ('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','UNASSIGNED_KMS',false);
INSERT INTO freehold.product_disclosures(product_code, version, body) VALUES
  ('USD_BANK_DEPOSIT','phase10-1','A USD account in this application is a ledger balance. No bank partner is appointed. A simulated bank event is not a deposit and is not FDIC insurance.'),
  ('NONDEPOSIT_STORED_VALUE','phase10-1','Stored value, if offered later, would be a different claim from a bank deposit and from a payment stablecoin. None is offered here.'),
  ('PAYMENT_STABLECOIN','phase10-1','Simulated FUSD is not a payment stablecoin issued under the GENIUS Act. It is not FDIC insured, not a United States government obligation, and not legal tender. Freehold is not a bank. Outstanding simulated units are not backed by verified external reserves.'),
  ('EXPERIMENTAL_UNIT','phase10-1','FHU is an experimental sandbox unit. It is not a GENIUS Act payment stablecoin, not a USD claim, and not evidence that issuance created value.');
INSERT INTO freehold.regulator_requests(entity_id, status, summary) VALUES
  ('10000000-0000-4000-8000-000000000003','NOT_SUBMITTED','No regulator request has been submitted. This row records that fact.');

CREATE FUNCTION freehold._monetary_guard_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('freehold.monetary_writer', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'MONETARY_DIRECT_WRITE_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MONETARY_HISTORY_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  -- Field access is not short-circuited. Check the table before reading its columns.
  IF TG_TABLE_NAME = 'regulatory_reports' THEN
    IF NEW.state = 'SUBMITTED_WITH_EVIDENCE' THEN
      RAISE EXCEPTION 'MONETARY_SUBMISSION_REFUSED' USING ERRCODE='22023';
    END IF;
  ELSIF TG_TABLE_NAME = 'reserve_assets' THEN
    IF NEW.evidence_scope IS DISTINCT FROM 'SIMULATED' THEN
      RAISE EXCEPTION 'MONETARY_EVIDENCE_SCOPE' USING ERRCODE='22023';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION freehold._monetary_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MONETARY_HISTORY_IMMUTABLE' USING ERRCODE='55000';
END $$;

CREATE FUNCTION freehold._monetary_journal_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad FROM (
    SELECT journal_id FROM freehold.monetary_entries WHERE journal_id = COALESCE(NEW.journal_id, OLD.journal_id)
    GROUP BY journal_id
    HAVING COALESCE(sum(amount_minor) FILTER (WHERE side='DEBIT'),0)
        <> COALESCE(sum(amount_minor) FILTER (WHERE side='CREDIT'),0)
        OR count(DISTINCT entity_id) <> 1
  ) s;
  IF bad > 0 THEN
    RAISE EXCEPTION 'MONETARY_JOURNAL_UNBALANCED' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER monetary_books_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.monetary_books
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER monetary_supply_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.monetary_supply
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER monetary_holders_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.monetary_holders
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER monetary_journals_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.monetary_journals
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER monetary_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.monetary_entries
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER reserve_assets_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.reserve_assets
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER issuance_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.issuance_operations
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER redemption_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.redemption_operations
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER bank_accounts_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.bank_accounts
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER bank_events_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.bank_events
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER cap_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.monetary_cap_requests
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER obligations_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.cross_entity_obligations
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER chain_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.chain_observations
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER reports_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.regulatory_reports
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER screen_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.monetary_screenings
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER restriction_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.monetary_restrictions
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER capital_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.issuer_capital
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER alert_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.monetary_alerts
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER conversion_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.conversion_requests
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER settlement_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.settlement_evidence
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER capability_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.monetary_capabilities
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER audit_append BEFORE UPDATE OR DELETE ON freehold.monetary_audit
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_append_only();
CREATE TRIGGER audit_guard BEFORE INSERT OR DELETE ON freehold.monetary_audit
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER corrections_append BEFORE UPDATE OR DELETE ON freehold.supply_corrections
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_append_only();
CREATE CONSTRAINT TRIGGER monetary_entries_balanced
  AFTER INSERT OR UPDATE OR DELETE ON freehold.monetary_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_journal_balance();

CREATE FUNCTION freehold._monetary_audit(p_entity uuid, p_book uuid, p_action text, p_actor uuid, p_detail jsonb) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('freehold.monetary_writer','on',true);
  INSERT INTO freehold.monetary_audit(entity_id, book_id, action, actor_id, detail)
  VALUES (p_entity, p_book, p_action, p_actor, p_detail);
END $$;

CREATE FUNCTION freehold._monetary_lock(p_book uuid) RETURNS freehold.monetary_books
LANGUAGE plpgsql AS $$
DECLARE b freehold.monetary_books;
BEGIN
  PERFORM set_config('freehold.monetary_writer','on',true);
  SELECT * INTO b FROM freehold.monetary_books WHERE id = p_book FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM freehold.monetary_supply WHERE book_id = p_book FOR UPDATE;
  IF b.live_issuance_enabled OR NOT b.simulation_only THEN
    RAISE EXCEPTION 'LIVE_MONETARY_ACTIVATION_REFUSED' USING ERRCODE='22023';
  END IF;
  RETURN b;
END $$;

CREATE FUNCTION freehold._monetary_capability(p_actor uuid, p_capability text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM freehold._require_bound_session(p_actor);
  IF NOT EXISTS (
    SELECT 1 FROM freehold.monetary_capabilities
    WHERE principal_id = p_actor AND capability = p_capability AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'MONETARY_FORBIDDEN' USING ERRCODE='42501';
  END IF;
END $$;

CREATE FUNCTION freehold._monetary_writes_open() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT writes_suspended FROM freehold.institutional_control WHERE singleton) THEN
    RAISE EXCEPTION 'FINANCIAL_WRITES_SUSPENDED' USING ERRCODE='55000';
  END IF;
END $$;

CREATE FUNCTION freehold._monetary_refresh_stale(p_book uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('freehold.monetary_writer','on',true);
  UPDATE freehold.reserve_assets
     SET evidence_state = 'STALE'
   WHERE book_id = p_book AND evidence_state = 'VERIFIED'
     AND verified_at < clock_timestamp() - interval '32 days';
END $$;

CREATE FUNCTION freehold._monetary_eligible(p_book uuid) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE total bigint;
BEGIN
  SELECT COALESCE(sum(r.valuation_minor), 0) INTO total
  FROM freehold.reserve_assets r
  JOIN freehold.monetary_books b ON b.id = r.book_id
  WHERE r.book_id = p_book
    AND b.simulation_only
    AND NOT b.live_issuance_enabled
    AND r.evidence_state = 'VERIFIED'
    AND r.evidence_scope = 'SIMULATED'
    AND NOT r.encumbered
    AND r.verified_at > clock_timestamp() - interval '32 days'
    AND r.legal_owner_entity_id = b.entity_id
    AND r.custodian_entity_id <> r.legal_owner_entity_id
    AND r.valuation_minor <= r.quantity_minor
    AND (
      r.category IN ('USD_CASH','FED_BALANCE')
      OR (r.category = 'DEMAND_DEPOSIT_INSURED' AND r.insured_depository)
      OR (r.category = 'TREASURY_MAX_93_DAYS'
          AND r.maturity_date IS NOT NULL
          AND r.maturity_date >= r.valuation_date
          AND r.maturity_date <= r.valuation_date + 93)
    );
  RETURN total;
END $$;

CREATE FUNCTION freehold._monetary_recompute(p_book uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  b freehold.monetary_books;
  issued bigint; redeemed bigint; pending_i bigint; pending_r bigint; corr bigint;
  customer bigint; treasury bigint; frozen bigint; pending_h bigint;
  next_outstanding bigint;
BEGIN
  PERFORM set_config('freehold.monetary_writer','on',true);
  SELECT * INTO b FROM freehold.monetary_books WHERE id = p_book;
  SELECT
    COALESCE(sum(amount_minor) FILTER (WHERE state = 'ISSUED'), 0),
    COALESCE(sum(amount_minor) FILTER (WHERE state IN (
      'REQUESTED','PENDING_RESERVE_VERIFICATION','PENDING_APPROVAL','APPROVED','EXECUTING','UNKNOWN')), 0)
  INTO issued, pending_i
  FROM freehold.issuance_operations WHERE book_id = p_book;
  SELECT
    COALESCE(sum(amount_minor) FILTER (WHERE state = 'REDEEMED'), 0),
    COALESCE(sum(amount_minor) FILTER (WHERE state IN (
      'REQUESTED','VALIDATING','UNITS_SECURED','PENDING_SETTLEMENT','SETTLEMENT_CONFIRMED','EXCEPTION','UNKNOWN')), 0)
  INTO redeemed, pending_r
  FROM freehold.redemption_operations WHERE book_id = p_book;
  SELECT COALESCE(sum(amount_minor), 0) INTO corr FROM freehold.supply_corrections WHERE book_id = p_book;
  SELECT
    COALESCE(sum(units) FILTER (WHERE holder_kind = 'CUSTOMER'), 0),
    COALESCE(sum(units) FILTER (WHERE holder_kind = 'TREASURY'), 0),
    COALESCE(sum(units) FILTER (WHERE holder_kind = 'FROZEN'), 0),
    COALESCE(sum(units) FILTER (WHERE holder_kind = 'PENDING_REDEMPTION'), 0)
  INTO customer, treasury, frozen, pending_h
  FROM freehold.monetary_holders WHERE book_id = p_book;
  next_outstanding := issued - redeemed + corr;
  IF next_outstanding <> customer + treasury + frozen + pending_h OR next_outstanding < 0 OR pending_h <> pending_r THEN
    RAISE EXCEPTION 'MONETARY_SUPPLY_MISMATCH' USING ERRCODE='55000';
  END IF;
  UPDATE freehold.monetary_supply AS supply SET
    issued_lifetime = issued,
    redeemed_lifetime = redeemed,
    outstanding = next_outstanding,
    pending_issuance = pending_i,
    pending_redemption = pending_r,
    frozen_units = frozen,
    treasury_units = treasury,
    customer_units = customer,
    corrections = corr
  WHERE supply.book_id = p_book;
  IF next_outstanding + pending_i > b.authorized_max_outstanding THEN
    RAISE EXCEPTION 'MONETARY_CAP' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object(
    'outstanding', next_outstanding::text,
    'pendingIssuance', pending_i::text,
    'pendingRedemption', pending_r::text,
    'issuedLifetime', issued::text,
    'redeemedLifetime', redeemed::text,
    'customerUnits', customer::text,
    'treasuryUnits', treasury::text,
    'frozenUnits', frozen::text,
    'corrections', corr::text,
    'cap', b.authorized_max_outstanding::text,
    'capBasis', 'OUTSTANDING');
END $$;

CREATE FUNCTION freehold._monetary_coverage_alert(p_book uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE eligible bigint; outstanding bigint;
BEGIN
  eligible := freehold._monetary_eligible(p_book);
  SELECT s.outstanding INTO outstanding FROM freehold.monetary_supply s WHERE s.book_id = p_book;
  IF outstanding > eligible AND NOT EXISTS (
    SELECT 1 FROM freehold.monetary_alerts
    WHERE book_id = p_book AND code = 'RESERVE_DEFICIT' AND acknowledged_at IS NULL
  ) THEN
    INSERT INTO freehold.monetary_alerts(book_id, severity, code)
    VALUES (p_book, 'CRITICAL', 'RESERVE_DEFICIT');
  END IF;
END $$;

CREATE FUNCTION freehold._monetary_post(
  p_book uuid, p_operation uuid, p_kind text, p_memo text, p_debit text, p_credit text, p_amount bigint
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE b freehold.monetary_books; jid uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('freehold.monetary_writer','on',true);
  SELECT * INTO b FROM freehold.monetary_books WHERE id = p_book;
  INSERT INTO freehold.monetary_journals(id, book_id, entity_id, operation_id, kind, memo)
  VALUES (jid, p_book, b.entity_id, p_operation, p_kind, p_memo);
  INSERT INTO freehold.monetary_entries(journal_id, entity_id, account_code, side, amount_minor) VALUES
    (jid, b.entity_id, p_debit, 'DEBIT', p_amount),
    (jid, b.entity_id, p_credit, 'CREDIT', p_amount);
  RETURN jid;
END $$;

CREATE FUNCTION freehold._monetary_holder_add(p_book uuid, p_kind text, p_ref uuid, p_delta bigint) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('freehold.monetary_writer','on',true);
  IF p_ref IS NULL THEN
    UPDATE freehold.monetary_holders SET units = units + p_delta
     WHERE book_id = p_book AND holder_kind = p_kind AND holder_ref IS NULL;
  ELSE
    INSERT INTO freehold.monetary_holders(book_id, holder_kind, holder_ref, units)
    VALUES (p_book, p_kind, p_ref, 0)
    ON CONFLICT (book_id, holder_kind, holder_ref) WHERE holder_ref IS NOT NULL DO NOTHING;
    UPDATE freehold.monetary_holders SET units = units + p_delta
     WHERE book_id = p_book AND holder_kind = p_kind AND holder_ref = p_ref;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
END $$;

CREATE FUNCTION freehold.monetary_bootstrap_capability(p_principal uuid, p_capability text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE super boolean;
BEGIN
  SELECT rolsuper INTO super FROM pg_roles WHERE rolname = session_user;
  IF session_user IS DISTINCT FROM 'freehold_owner' AND NOT COALESCE(super, false) THEN
    RAISE EXCEPTION 'MONETARY_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM freehold.monetary_books WHERE NOT live_issuance_enabled AND simulation_only) THEN
    RAISE EXCEPTION 'LIVE_MONETARY_ACTIVATION_REFUSED' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('freehold.monetary_writer','on',true);
  INSERT INTO freehold.monetary_capabilities(principal_id, capability, granted_by, grant_source)
  VALUES (p_principal, p_capability, NULL, 'SIMULATION_BOOTSTRAP')
  ON CONFLICT (principal_id, capability) DO NOTHING;
  PERFORM freehold._monetary_audit(NULL, NULL, 'BOOTSTRAP_CAPABILITY', p_principal, jsonb_build_object('capability', p_capability));
END $$;

CREATE FUNCTION freehold.monetary_grant_capability(p_actor uuid, p_principal uuid, p_capability text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
  PERFORM freehold._require_bound_session(p_actor);
  IF p_actor = p_principal THEN RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM freehold.monetary_capabilities
    WHERE principal_id = p_actor AND capability IN ('GOVERNANCE_POLICY','SECURITY_ADMIN') AND revoked_at IS NULL
  ) THEN RAISE EXCEPTION 'MONETARY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  PERFORM set_config('freehold.monetary_writer','on',true);
  INSERT INTO freehold.monetary_capabilities(principal_id, capability, granted_by, grant_source)
  VALUES (p_principal, p_capability, p_actor, 'GRANT')
  ON CONFLICT (principal_id, capability) DO NOTHING;
  PERFORM freehold._monetary_audit(NULL, NULL, 'GRANT_CAPABILITY', p_actor, jsonb_build_object('principal', p_principal, 'capability', p_capability));
  RETURN jsonb_build_object('granted', true, 'capability', p_capability);
END $$;

CREATE FUNCTION freehold.monetary_overview(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
  PERFORM freehold._require_bound_session(p_actor);
  RETURN jsonb_build_object(
    'simulationOnly', true,
    'liveIssuanceEnabled', false,
    'institutionStatus', 'NOT_A_BANK',
    'fusdStatus', 'SIMULATED_NOT_AUTHORIZED',
    'fhuStatus', 'EXPERIMENTAL_NOT_A_PAYMENT_STABLECOIN',
    'capBasis', 'OUTSTANDING',
    'externalReserveEvidence', 'UNAVAILABLE',
    'conversionAvailable', false,
    'conversionReason', 'UNBACKED_CONVERSION_REFUSED',
    'disclosures', (SELECT COALESCE(jsonb_agg(jsonb_build_object('product', product_code, 'version', version, 'body', body)), '[]'::jsonb) FROM freehold.product_disclosures),
    'books', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'code', b.code, 'unit', b.unit_code, 'product', b.product_code,
        'entity', e.code, 'outstanding', s.outstanding::text,
        'pendingIssuance', s.pending_issuance::text,
        'pendingRedemption', s.pending_redemption::text,
        'customerUnits', s.customer_units::text,
        'treasuryUnits', s.treasury_units::text,
        'frozenUnits', s.frozen_units::text,
        'issuedLifetime', s.issued_lifetime::text,
        'redeemedLifetime', s.redeemed_lifetime::text,
        'authorizedMaxOutstanding', b.authorized_max_outstanding::text,
        'issuanceSuspended', b.issuance_suspended,
        'redemptionSuspended', b.redemption_suspended,
        'simulatedEligibleReserves', CASE WHEN b.code = 'FUSD_SIM' THEN freehold._monetary_eligible(b.id)::text ELSE '0' END
      ) ORDER BY b.code), '[]'::jsonb)
      FROM freehold.monetary_books b
      JOIN freehold.legal_entities e ON e.id = b.entity_id
      JOIN freehold.monetary_supply s ON s.book_id = b.id
    ),
    'customerUnits', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('book', b.code, 'units', h.units::text, 'kind', h.holder_kind)), '[]'::jsonb)
      FROM freehold.monetary_holders h JOIN freehold.monetary_books b ON b.id = h.book_id
      WHERE h.holder_ref = p_actor AND h.units > 0
    ),
    'bankAccounts', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', a.id, 'state', a.state, 'simulationOnly', a.simulation_only, 'customerAccountId', a.customer_account_id
      )), '[]'::jsonb)
      FROM freehold.bank_accounts a
      JOIN freehold.accounts c ON c.id = a.customer_account_id
      WHERE c.owner_user_id = p_actor
    )
  );
END $$;

CREATE FUNCTION freehold.monetary_reserve_propose(
  p_actor uuid, p_book uuid, p_category text, p_amount bigint, p_asset_ref text, p_maturity date, p_key text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE b freehold.monetary_books; existing uuid; rid uuid;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'RESERVE_MANAGEMENT');
  PERFORM freehold._monetary_writes_open();
  b := freehold._monetary_lock(p_book);
  IF b.product_code <> 'PAYMENT_STABLECOIN' THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT id INTO existing FROM freehold.reserve_assets WHERE asset_ref = p_asset_ref;
  IF existing IS NOT NULL THEN RAISE EXCEPTION 'MONETARY_DUPLICATE_RESERVE' USING ERRCODE='22023'; END IF;
  IF p_category NOT IN (
    'USD_CASH','FED_BALANCE','DEMAND_DEPOSIT_INSURED','TREASURY_MAX_93_DAYS',
    'OVERNIGHT_TREASURY_REPO','OVERNIGHT_TREASURY_REVERSE_REPO','GOVERNMENT_MMF',
    'TOKENIZED_CASH','TOKENIZED_DEPOSIT','TOKENIZED_TREASURY','TOKENIZED_MMF','TOKENIZED_REPO',
    'REGULATOR_APPROVED_LIQUID','OTHER_INELIGIBLE') THEN
    RAISE EXCEPTION 'MONETARY_INELIGIBLE_RESERVE' USING ERRCODE='22023';
  END IF;
  INSERT INTO freehold.reserve_assets(
    book_id, legal_owner_entity_id, custodian_entity_id, category, asset_ref, currency_code,
    quantity_minor, valuation_minor, valuation_date, maturity_date, evidence_state, evidence_scope,
    insured_depository, proposer_id)
  VALUES (
    p_book, b.entity_id, '10000000-0000-4000-8000-000000000004', p_category, p_asset_ref, 'USD',
    p_amount, p_amount, current_date, p_maturity, 'UNVERIFIED', 'SIMULATED',
    p_category = 'DEMAND_DEPOSIT_INSURED', p_actor)
  RETURNING id INTO rid;
  PERFORM freehold._monetary_audit(b.entity_id, p_book, 'RESERVE_PROPOSE', p_actor,
    jsonb_build_object('reserveId', rid, 'category', p_category, 'amount', p_amount::text, 'key', p_key, 'evidenceScope', 'SIMULATED'));
  RETURN jsonb_build_object('reserveId', rid, 'evidenceState', 'UNVERIFIED', 'evidenceScope', 'SIMULATED', 'eligible', false);
END $$;

CREATE FUNCTION freehold.monetary_reserve_review(p_actor uuid, p_reserve uuid, p_decision text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE r freehold.reserve_assets; b freehold.monetary_books;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'TREASURY');
  PERFORM freehold._monetary_writes_open();
  SELECT * INTO r FROM freehold.reserve_assets WHERE id = p_reserve FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  b := freehold._monetary_lock(r.book_id);
  IF p_actor = r.proposer_id THEN RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023'; END IF;
  IF p_decision NOT IN ('VERIFIED','REJECTED') THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  IF r.evidence_state NOT IN ('UNVERIFIED','PENDING_CONFIRMATION') THEN
    RETURN jsonb_build_object('reserveId', r.id, 'evidenceState', r.evidence_state, 'evidenceScope', 'SIMULATED');
  END IF;
  UPDATE freehold.reserve_assets SET
    evidence_state = p_decision,
    reviewer_id = p_actor,
    verified_at = CASE WHEN p_decision = 'VERIFIED' THEN clock_timestamp() ELSE NULL END
  WHERE id = r.id;
  PERFORM freehold._monetary_audit(b.entity_id, r.book_id, 'RESERVE_REVIEW', p_actor,
    jsonb_build_object('reserveId', r.id, 'decision', p_decision, 'evidenceScope', 'SIMULATED'));
  RETURN jsonb_build_object('reserveId', r.id, 'evidenceState', p_decision, 'evidenceScope', 'SIMULATED', 'externalEvidence', false);
END $$;

CREATE FUNCTION freehold.monetary_reserve_encumber(p_actor uuid, p_reserve uuid, p_encumbered boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE r freehold.reserve_assets;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'TREASURY');
  SELECT * INTO r FROM freehold.reserve_assets WHERE id = p_reserve;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM freehold._monetary_lock(r.book_id);
  UPDATE freehold.reserve_assets SET encumbered = p_encumbered WHERE id = r.id;
  PERFORM freehold._monetary_coverage_alert(r.book_id);
  PERFORM freehold._monetary_audit(r.legal_owner_entity_id, r.book_id, 'RESERVE_ENCUMBER', p_actor,
    jsonb_build_object('reserveId', r.id, 'encumbered', p_encumbered));
  RETURN jsonb_build_object('reserveId', r.id, 'encumbered', p_encumbered);
END $$;

CREATE FUNCTION freehold.monetary_reserve_mark_stale(p_actor uuid, p_reserve uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE r freehold.reserve_assets;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'TREASURY');
  SELECT * INTO r FROM freehold.reserve_assets WHERE id = p_reserve;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM freehold._monetary_lock(r.book_id);
  UPDATE freehold.reserve_assets SET evidence_state = 'STALE' WHERE id = r.id;
  PERFORM freehold._monetary_coverage_alert(r.book_id);
  PERFORM freehold._monetary_audit(r.legal_owner_entity_id, r.book_id, 'RESERVE_STALE', p_actor, jsonb_build_object('reserveId', r.id));
  RETURN jsonb_build_object('reserveId', r.id, 'evidenceState', 'STALE');
END $$;

CREATE FUNCTION freehold.monetary_record_capital(p_actor uuid, p_amount bigint, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE cid uuid;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'TREASURY');
  PERFORM set_config('freehold.monetary_writer','on',true);
  INSERT INTO freehold.issuer_capital(entity_id, amount_minor, note, recorded_by)
  VALUES ('10000000-0000-4000-8000-000000000003', p_amount, p_key, p_actor)
  RETURNING id INTO cid;
  PERFORM freehold._monetary_audit('10000000-0000-4000-8000-000000000003', NULL, 'CAPITAL_RECORDED', p_actor,
    jsonb_build_object('capitalId', cid, 'amount', p_amount::text, 'countsAsReserve', false));
  RETURN jsonb_build_object('capitalId', cid, 'countsAsReserve', false);
END $$;

CREATE FUNCTION freehold._issue_json(p freehold.issuance_operations) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'issuanceId', p.id, 'state', p.state, 'amountMinor', p.amount_minor::text,
    'journalId', p.journal_id, 'simulationOnly', true, 'liveIssuance', false);
$$;

CREATE FUNCTION freehold.monetary_issue_request(p_actor uuid, p_book uuid, p_amount bigint, p_holder uuid, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE b freehold.monetary_books; existing freehold.issuance_operations; row_id uuid;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'ISSUANCE_AUTHORITY');
  PERFORM freehold._monetary_writes_open();
  IF p_amount IS NULL OR p_amount <= 0 OR p_key IS NULL OR length(p_key) < 8 THEN
    RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023';
  END IF;
  b := freehold._monetary_lock(p_book);
  IF b.product_code <> 'PAYMENT_STABLECOIN' THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  IF b.issuance_suspended THEN RAISE EXCEPTION 'MONETARY_SUSPENDED' USING ERRCODE='22023'; END IF;
  SELECT * INTO existing FROM freehold.issuance_operations WHERE book_id = p_book AND idempotency_key = p_key;
  IF FOUND THEN RETURN freehold._issue_json(existing); END IF;
  IF EXISTS (
    SELECT 1 FROM freehold.monetary_restrictions
    WHERE subject_user_id = COALESCE(p_holder, p_actor) AND active AND kind = 'BLOCK_SIMULATED_ISSUANCE'
  ) THEN RAISE EXCEPTION 'MONETARY_RESTRICTED' USING ERRCODE='22023'; END IF;
  INSERT INTO freehold.issuance_operations(book_id, idempotency_key, requester_id, holder_ref, amount_minor, state)
  VALUES (p_book, p_key, p_actor, p_holder, p_amount, 'PENDING_RESERVE_VERIFICATION')
  RETURNING id INTO row_id;
  BEGIN
    PERFORM freehold._monetary_recompute(p_book);
  EXCEPTION WHEN SQLSTATE '22023' THEN
    IF SQLERRM <> 'MONETARY_CAP' THEN RAISE; END IF;
    UPDATE freehold.issuance_operations SET state = 'REJECTED' WHERE id = row_id;
    PERFORM freehold._monetary_recompute(p_book);
  END;
  SELECT * INTO existing FROM freehold.issuance_operations WHERE id = row_id;
  PERFORM freehold._monetary_audit(b.entity_id, p_book, 'ISSUE_REQUEST', p_actor, freehold._issue_json(existing));
  RETURN freehold._issue_json(existing);
END $$;

CREATE FUNCTION freehold.monetary_issue_verify(p_actor uuid, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE op freehold.issuance_operations; b freehold.monetary_books; eligible bigint; supply freehold.monetary_supply;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'TREASURY');
  PERFORM freehold._monetary_writes_open();
  SELECT * INTO op FROM freehold.issuance_operations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  b := freehold._monetary_lock(op.book_id);
  IF op.state <> 'PENDING_RESERVE_VERIFICATION' THEN RETURN freehold._issue_json(op); END IF;
  IF p_actor = op.requester_id THEN RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023'; END IF;
  PERFORM freehold._monetary_refresh_stale(op.book_id);
  eligible := freehold._monetary_eligible(op.book_id);
  SELECT * INTO supply FROM freehold.monetary_supply WHERE book_id = op.book_id;
  IF eligible < supply.outstanding + supply.pending_issuance THEN
    UPDATE freehold.issuance_operations SET state = 'REJECTED' WHERE id = op.id;
    PERFORM freehold._monetary_recompute(op.book_id);
    PERFORM freehold._monetary_coverage_alert(op.book_id);
  ELSE
    UPDATE freehold.issuance_operations SET state = 'PENDING_APPROVAL' WHERE id = op.id;
  END IF;
  SELECT * INTO op FROM freehold.issuance_operations WHERE id = p_id;
  PERFORM freehold._monetary_audit(b.entity_id, op.book_id, 'ISSUE_VERIFY', p_actor,
    freehold._issue_json(op) || jsonb_build_object('eligibleSimulated', eligible::text));
  RETURN freehold._issue_json(op);
END $$;

CREATE FUNCTION freehold.monetary_issue_approve(p_actor uuid, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE op freehold.issuance_operations; b freehold.monetary_books;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'ISSUANCE_AUTHORITY');
  PERFORM freehold._monetary_writes_open();
  SELECT * INTO op FROM freehold.issuance_operations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  b := freehold._monetary_lock(op.book_id);
  IF op.state <> 'PENDING_APPROVAL' THEN RETURN freehold._issue_json(op); END IF;
  IF p_actor = op.requester_id THEN RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023'; END IF;
  IF EXISTS (
    SELECT 1 FROM freehold.reserve_assets r
    WHERE r.book_id = op.book_id AND r.evidence_state = 'VERIFIED'
      AND (r.proposer_id = p_actor OR r.reviewer_id = p_actor)
  ) THEN RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023'; END IF;
  UPDATE freehold.issuance_operations SET state = 'APPROVED', approver_id = p_actor WHERE id = op.id;
  SELECT * INTO op FROM freehold.issuance_operations WHERE id = p_id;
  PERFORM freehold._monetary_audit(b.entity_id, op.book_id, 'ISSUE_APPROVE', p_actor, freehold._issue_json(op));
  RETURN freehold._issue_json(op);
END $$;

CREATE FUNCTION freehold.monetary_issue_execute(p_actor uuid, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE op freehold.issuance_operations; b freehold.monetary_books; eligible bigint; jid uuid; supply freehold.monetary_supply;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'ISSUANCE_AUTHORITY');
  PERFORM freehold._monetary_writes_open();
  SELECT * INTO op FROM freehold.issuance_operations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  b := freehold._monetary_lock(op.book_id);
  IF op.state = 'UNKNOWN' THEN RAISE EXCEPTION 'MONETARY_UNKNOWN_BLOCKED' USING ERRCODE='22023'; END IF;
  IF op.state = 'ISSUED' THEN RETURN freehold._issue_json(op); END IF;
  IF op.state <> 'APPROVED' THEN RAISE EXCEPTION 'MONETARY_STATE' USING ERRCODE='22023'; END IF;
  IF b.issuance_suspended THEN RAISE EXCEPTION 'MONETARY_SUSPENDED' USING ERRCODE='22023'; END IF;
  IF p_actor = op.requester_id OR p_actor IS NOT DISTINCT FROM op.approver_id THEN
    RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM freehold.reserve_assets r
    WHERE r.book_id = op.book_id AND (r.proposer_id = p_actor OR r.reviewer_id = p_actor)
  ) THEN RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023'; END IF;
  UPDATE freehold.issuance_operations SET state = 'EXECUTING', executor_id = p_actor WHERE id = op.id;
  PERFORM freehold._monetary_refresh_stale(op.book_id);
  eligible := freehold._monetary_eligible(op.book_id);
  SELECT * INTO supply FROM freehold.monetary_supply WHERE book_id = op.book_id;
  IF eligible < supply.outstanding + supply.pending_issuance THEN
    UPDATE freehold.issuance_operations SET state = 'FAILED' WHERE id = op.id;
    PERFORM freehold._monetary_recompute(op.book_id);
    PERFORM freehold._monetary_coverage_alert(op.book_id);
    SELECT * INTO op FROM freehold.issuance_operations WHERE id = p_id;
    RETURN freehold._issue_json(op);
  END IF;
  IF op.holder_ref IS NULL THEN
    PERFORM freehold._monetary_holder_add(op.book_id, 'TREASURY', NULL, op.amount_minor);
  ELSE
    PERFORM freehold._monetary_holder_add(op.book_id, 'CUSTOMER', op.holder_ref, op.amount_minor);
  END IF;
  jid := freehold._monetary_post(op.book_id, op.id, 'ISSUANCE', 'SIMULATED_ISSUANCE_NOT_EXTERNAL_CASH',
    'ISSUANCE_CLEARING', 'STABLECOIN_LIABILITY', op.amount_minor);
  UPDATE freehold.issuance_operations SET state = 'ISSUED', journal_id = jid WHERE id = op.id;
  PERFORM freehold._monetary_recompute(op.book_id);
  SELECT * INTO op FROM freehold.issuance_operations WHERE id = p_id;
  PERFORM freehold._monetary_audit(b.entity_id, op.book_id, 'ISSUE_EXECUTE', p_actor, freehold._issue_json(op));
  RETURN freehold._issue_json(op);
END $$;

CREATE FUNCTION freehold.monetary_issue_mark_unknown(p_actor uuid, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE op freehold.issuance_operations;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'ISSUANCE_AUTHORITY');
  SELECT * INTO op FROM freehold.issuance_operations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM freehold._monetary_lock(op.book_id);
  IF op.state = 'UNKNOWN' THEN RETURN freehold._issue_json(op); END IF;
  IF op.state NOT IN ('APPROVED','EXECUTING','PENDING_APPROVAL') THEN
    RAISE EXCEPTION 'MONETARY_STATE' USING ERRCODE='22023';
  END IF;
  UPDATE freehold.issuance_operations SET state = 'UNKNOWN', unknown_marked_by = p_actor WHERE id = op.id;
  SELECT * INTO op FROM freehold.issuance_operations WHERE id = p_id;
  RETURN freehold._issue_json(op);
END $$;

CREATE FUNCTION freehold.monetary_issue_resolve_unknown(p_actor uuid, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE op freehold.issuance_operations;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'ISSUANCE_AUTHORITY');
  SELECT * INTO op FROM freehold.issuance_operations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM freehold._monetary_lock(op.book_id);
  IF op.state <> 'UNKNOWN' THEN RETURN freehold._issue_json(op); END IF;
  IF p_actor IS NOT DISTINCT FROM op.unknown_marked_by THEN RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023'; END IF;
  IF op.journal_id IS NOT NULL THEN
    UPDATE freehold.issuance_operations SET state = 'ISSUED' WHERE id = op.id;
  ELSE
    UPDATE freehold.issuance_operations SET state = 'FAILED' WHERE id = op.id;
  END IF;
  PERFORM freehold._monetary_recompute(op.book_id);
  SELECT * INTO op FROM freehold.issuance_operations WHERE id = p_id;
  RETURN freehold._issue_json(op);
END $$;

CREATE FUNCTION freehold._redeem_json(p freehold.redemption_operations) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'redemptionId', p.id, 'state', p.state, 'amountMinor', p.amount_minor::text,
    'journalId', p.journal_id, 'simulationOnly', true, 'externalSettlement', false);
$$;

CREATE FUNCTION freehold.monetary_redeem_request(p_actor uuid, p_book uuid, p_amount bigint, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE b freehold.monetary_books; existing freehold.redemption_operations; held bigint; source_kind text; ref uuid; row_id uuid;
BEGIN
  PERFORM freehold._require_bound_session(p_actor);
  PERFORM freehold._monetary_writes_open();
  b := freehold._monetary_lock(p_book);
  IF b.redemption_suspended THEN RAISE EXCEPTION 'MONETARY_SUSPENDED' USING ERRCODE='22023'; END IF;
  SELECT * INTO existing FROM freehold.redemption_operations WHERE book_id = p_book AND idempotency_key = p_key;
  IF FOUND THEN RETURN freehold._redeem_json(existing); END IF;
  IF EXISTS (
    SELECT 1 FROM freehold.monetary_restrictions
    WHERE subject_user_id = p_actor AND active AND monetary_restrictions.kind = 'BLOCK_SIMULATED_REDEMPTION'
  ) THEN RAISE EXCEPTION 'MONETARY_RESTRICTED' USING ERRCODE='22023'; END IF;
  SELECT units INTO held FROM freehold.monetary_holders
   WHERE book_id = p_book AND holder_kind = 'CUSTOMER' AND holder_ref = p_actor;
  IF COALESCE(held, 0) >= p_amount THEN
    source_kind := 'CUSTOMER'; ref := p_actor;
  ELSE
    PERFORM freehold._monetary_capability(p_actor, 'REDEMPTION_AUTHORITY');
    SELECT units INTO held FROM freehold.monetary_holders
     WHERE book_id = p_book AND holder_kind = 'TREASURY' AND holder_ref IS NULL;
    IF COALESCE(held, 0) < p_amount THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
    source_kind := 'TREASURY'; ref := NULL;
  END IF;
  PERFORM freehold._monetary_holder_add(p_book, source_kind, ref, -p_amount);
  PERFORM freehold._monetary_holder_add(p_book, 'PENDING_REDEMPTION', NULL, p_amount);
  INSERT INTO freehold.redemption_operations(book_id, idempotency_key, requester_id, holder_ref, amount_minor, state)
  VALUES (p_book, p_key, p_actor, ref, p_amount, 'UNITS_SECURED')
  RETURNING id INTO row_id;
  PERFORM freehold._monetary_recompute(p_book);
  SELECT * INTO existing FROM freehold.redemption_operations WHERE id = row_id;
  PERFORM freehold._monetary_audit(b.entity_id, p_book, 'REDEEM_REQUEST', p_actor, freehold._redeem_json(existing));
  RETURN freehold._redeem_json(existing);
END $$;

CREATE FUNCTION freehold.monetary_redeem_settlement(p_actor uuid, p_id uuid, p_outcome text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE op freehold.redemption_operations; b freehold.monetary_books;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'TREASURY');
  PERFORM freehold._monetary_writes_open();
  SELECT * INTO op FROM freehold.redemption_operations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  b := freehold._monetary_lock(op.book_id);
  IF op.state = 'UNKNOWN' THEN RAISE EXCEPTION 'MONETARY_UNKNOWN_BLOCKED' USING ERRCODE='22023'; END IF;
  IF op.state IN ('SETTLEMENT_CONFIRMED','FAILED','EXCEPTION','REDEEMED') THEN RETURN freehold._redeem_json(op); END IF;
  IF op.state <> 'UNITS_SECURED' THEN RAISE EXCEPTION 'MONETARY_STATE' USING ERRCODE='22023'; END IF;
  IF p_actor = op.requester_id THEN RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023'; END IF;
  IF p_outcome NOT IN ('SETTLEMENT_CONFIRMED','FAILED','EXCEPTION') THEN
    RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023';
  END IF;
  INSERT INTO freehold.settlement_evidence(redemption_id, evidence_scope, external_final, outcome, recorded_by)
  VALUES (op.id, 'SIMULATED', false, p_outcome, p_actor);
  IF p_outcome = 'FAILED' THEN
    PERFORM freehold._monetary_holder_add(op.book_id, 'PENDING_REDEMPTION', NULL, -op.amount_minor);
    IF op.holder_ref IS NULL THEN
      PERFORM freehold._monetary_holder_add(op.book_id, 'TREASURY', NULL, op.amount_minor);
    ELSE
      PERFORM freehold._monetary_holder_add(op.book_id, 'CUSTOMER', op.holder_ref, op.amount_minor);
    END IF;
    UPDATE freehold.redemption_operations SET state = 'FAILED', settlement_actor = p_actor WHERE id = op.id;
  ELSIF p_outcome = 'EXCEPTION' THEN
    UPDATE freehold.redemption_operations SET state = 'EXCEPTION', settlement_actor = p_actor WHERE id = op.id;
  ELSE
    UPDATE freehold.redemption_operations SET state = 'SETTLEMENT_CONFIRMED', settlement_actor = p_actor WHERE id = op.id;
  END IF;
  PERFORM freehold._monetary_recompute(op.book_id);
  SELECT * INTO op FROM freehold.redemption_operations WHERE id = p_id;
  PERFORM freehold._monetary_audit(b.entity_id, op.book_id, 'REDEEM_SETTLEMENT', p_actor, freehold._redeem_json(op));
  RETURN freehold._redeem_json(op);
END $$;

CREATE FUNCTION freehold.monetary_redeem_finalize(p_actor uuid, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE op freehold.redemption_operations; b freehold.monetary_books; jid uuid;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'REDEMPTION_AUTHORITY');
  PERFORM freehold._monetary_writes_open();
  SELECT * INTO op FROM freehold.redemption_operations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  b := freehold._monetary_lock(op.book_id);
  IF op.state = 'REDEEMED' THEN RETURN freehold._redeem_json(op); END IF;
  IF op.state = 'UNKNOWN' THEN RAISE EXCEPTION 'MONETARY_UNKNOWN_BLOCKED' USING ERRCODE='22023'; END IF;
  IF op.state <> 'SETTLEMENT_CONFIRMED' THEN RAISE EXCEPTION 'MONETARY_STATE' USING ERRCODE='22023'; END IF;
  IF p_actor = op.requester_id OR p_actor IS NOT DISTINCT FROM op.settlement_actor THEN
    RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM freehold.settlement_evidence
    WHERE redemption_id = op.id AND outcome = 'SETTLEMENT_CONFIRMED' AND evidence_scope = 'SIMULATED' AND NOT external_final
  ) THEN RAISE EXCEPTION 'MONETARY_STATE' USING ERRCODE='22023'; END IF;
  PERFORM freehold._monetary_holder_add(op.book_id, 'PENDING_REDEMPTION', NULL, -op.amount_minor);
  jid := freehold._monetary_post(op.book_id, op.id, 'REDEMPTION', 'SIMULATED_REDEMPTION_NOT_A_BANK_PAYMENT',
    'STABLECOIN_LIABILITY', 'REDEMPTION_PAYABLE', op.amount_minor);
  UPDATE freehold.redemption_operations SET state = 'REDEEMED', finalizer_id = p_actor, journal_id = jid WHERE id = op.id;
  INSERT INTO freehold.cross_entity_obligations(
    obligor_entity_id, obligee_entity_id, counterparty_user_id, book_id, amount_minor, state, claim_kind)
  VALUES (b.entity_id, NULL, COALESCE(op.holder_ref, op.requester_id), op.book_id, op.amount_minor, 'SIMULATED_OPEN', 'SIMULATED_REDEMPTION_PAYOUT');
  PERFORM freehold._monetary_recompute(op.book_id);
  SELECT * INTO op FROM freehold.redemption_operations WHERE id = p_id;
  PERFORM freehold._monetary_audit(b.entity_id, op.book_id, 'REDEEM_FINAL', p_actor, freehold._redeem_json(op));
  RETURN freehold._redeem_json(op);
END $$;

CREATE FUNCTION freehold.monetary_redeem_mark_unknown(p_actor uuid, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE op freehold.redemption_operations;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'REDEMPTION_AUTHORITY');
  SELECT * INTO op FROM freehold.redemption_operations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM freehold._monetary_lock(op.book_id);
  IF op.state = 'UNKNOWN' THEN RETURN freehold._redeem_json(op); END IF;
  IF op.state NOT IN ('UNITS_SECURED','PENDING_SETTLEMENT','SETTLEMENT_CONFIRMED') THEN
    RAISE EXCEPTION 'MONETARY_STATE' USING ERRCODE='22023';
  END IF;
  UPDATE freehold.redemption_operations SET state = 'UNKNOWN', unknown_marked_by = p_actor WHERE id = op.id;
  SELECT * INTO op FROM freehold.redemption_operations WHERE id = p_id;
  RETURN freehold._redeem_json(op);
END $$;

CREATE FUNCTION freehold.monetary_redeem_resolve_unknown(p_actor uuid, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE op freehold.redemption_operations;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'REDEMPTION_AUTHORITY');
  SELECT * INTO op FROM freehold.redemption_operations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM freehold._monetary_lock(op.book_id);
  IF op.state <> 'UNKNOWN' THEN RETURN freehold._redeem_json(op); END IF;
  IF p_actor IS NOT DISTINCT FROM op.unknown_marked_by THEN RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023'; END IF;
  IF op.journal_id IS NOT NULL THEN
    UPDATE freehold.redemption_operations SET state = 'REDEEMED' WHERE id = op.id;
  ELSE
    UPDATE freehold.redemption_operations SET state = 'EXCEPTION' WHERE id = op.id;
  END IF;
  PERFORM freehold._monetary_recompute(op.book_id);
  SELECT * INTO op FROM freehold.redemption_operations WHERE id = p_id;
  RETURN freehold._redeem_json(op);
END $$;

CREATE FUNCTION freehold._bank_transition_ok(p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_from = p_to
    OR (p_from = 'CREATED' AND p_to IN ('PENDING','FAILED','UNKNOWN'))
    OR (p_from = 'PENDING' AND p_to IN ('SUBMITTED','FAILED','UNKNOWN'))
    OR (p_from = 'SUBMITTED' AND p_to IN ('ACKNOWLEDGED','FAILED','RETURNED','UNKNOWN'))
    OR (p_from = 'ACKNOWLEDGED' AND p_to IN ('SETTLED','FAILED','RETURNED','UNKNOWN'))
    OR (p_from = 'SETTLED' AND p_to = 'RETURNED');
$$;

CREATE FUNCTION freehold.monetary_bank_open(p_actor uuid, p_account uuid, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE owner uuid; bid uuid; journals bigint;
BEGIN
  PERFORM freehold._require_bound_session(p_actor);
  SELECT owner_user_id INTO owner FROM freehold.accounts WHERE id = p_account;
  IF owner IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'MONETARY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT id INTO bid FROM freehold.bank_accounts WHERE customer_account_id = p_account;
  IF bid IS NOT NULL THEN
    RETURN jsonb_build_object('bankAccountId', bid, 'state', 'ACKNOWLEDGED', 'simulationOnly', true, 'fundsReceived', false);
  END IF;
  PERFORM set_config('freehold.monetary_writer','on',true);
  INSERT INTO freehold.bank_accounts(entity_id, customer_account_id, external_ref, state, simulation_only)
  VALUES ('10000000-0000-4000-8000-000000000002', p_account, p_key, 'ACKNOWLEDGED', true)
  RETURNING id INTO bid;
  INSERT INTO freehold.bank_events(bank_account_id, kind, external_id, amount_minor, state, signature_ok, evidence_scope)
  VALUES (bid, 'ACCOUNT_OPEN', p_key, 0, 'ACKNOWLEDGED', false, 'SIMULATED');
  SELECT count(*) INTO journals FROM freehold.ledger_journals;
  RETURN jsonb_build_object('bankAccountId', bid, 'state', 'ACKNOWLEDGED', 'simulationOnly', true, 'fundsReceived', false, 'customerJournals', journals::text);
END $$;

CREATE FUNCTION freehold.monetary_bank_event(
  p_actor uuid, p_bank uuid, p_kind text, p_external text, p_amount bigint, p_state text, p_signature text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE
  existing freehold.bank_events;
  owner uuid;
  secret text;
  payload text;
  ok boolean;
  next_state text;
  available bigint;
BEGIN
  PERFORM freehold._require_bound_session(p_actor);
  SELECT a.owner_user_id, a.available_minor INTO owner, available
  FROM freehold.bank_accounts b JOIN freehold.accounts a ON a.id = b.customer_account_id
  WHERE b.id = p_bank;
  IF owner IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'MONETARY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO existing FROM freehold.bank_events WHERE bank_account_id = p_bank AND external_id = p_external;
  secret := current_setting('freehold.bank_simulator_key', true);
  payload := p_external || '|' || p_kind || '|' || p_amount::text || '|' || p_state;
  ok := secret IS NOT NULL AND secret <> '' AND p_signature IS NOT NULL
    AND p_signature = encode(public.hmac(payload::bytea, convert_to(secret, 'utf8'), 'sha256'), 'hex');
  next_state := p_state;
  IF p_kind <> 'ACCOUNT_OPEN' AND p_state IN ('ACKNOWLEDGED','SETTLED') AND NOT ok THEN
    next_state := 'FAILED';
  END IF;
  PERFORM set_config('freehold.monetary_writer','on',true);
  IF existing.id IS NOT NULL THEN
    IF existing.kind = p_kind
      AND existing.amount_minor = p_amount
      AND freehold._bank_transition_ok(existing.state, next_state)
      AND existing.state IS DISTINCT FROM next_state THEN
      UPDATE freehold.bank_events SET state = next_state, signature_ok = ok WHERE id = existing.id;
      existing.state := next_state;
    END IF;
    SELECT available_minor INTO available FROM freehold.accounts a
    JOIN freehold.bank_accounts b ON b.customer_account_id = a.id WHERE b.id = p_bank;
    RETURN jsonb_build_object('eventId', existing.id, 'state', existing.state, 'duplicate', true, 'fundsReceived', false, 'availableMinor', available::text);
  END IF;
  INSERT INTO freehold.bank_events(bank_account_id, kind, external_id, amount_minor, state, signature_ok, evidence_scope)
  VALUES (p_bank, p_kind, p_external, p_amount, next_state, ok, 'SIMULATED')
  RETURNING * INTO existing;
  SELECT available_minor INTO available FROM freehold.accounts a
  JOIN freehold.bank_accounts b ON b.customer_account_id = a.id WHERE b.id = p_bank;
  RETURN jsonb_build_object(
    'eventId', existing.id, 'state', existing.state, 'signatureOk', ok,
    'duplicate', false, 'fundsReceived', false, 'evidenceScope', 'SIMULATED',
    'availableMinor', available::text);
END $$;

CREATE FUNCTION freehold.monetary_suspend(p_actor uuid, p_book uuid, p_suspend boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE b freehold.monetary_books;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'EMERGENCY_CONTROL');
  b := freehold._monetary_lock(p_book);
  IF NOT p_suspend AND b.suspended_by IS NOT NULL AND b.suspended_by = p_actor THEN
    RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023';
  END IF;
  UPDATE freehold.monetary_books SET
    issuance_suspended = p_suspend,
    redemption_suspended = p_suspend,
    suspended_by = CASE WHEN p_suspend THEN p_actor ELSE NULL END
  WHERE id = p_book;
  PERFORM freehold._monetary_audit(b.entity_id, p_book, 'SUSPEND', p_actor, jsonb_build_object('suspended', p_suspend));
  RETURN jsonb_build_object('bookId', p_book, 'suspended', p_suspend);
END $$;

CREATE FUNCTION freehold.monetary_cap_request(p_actor uuid, p_book uuid, p_max bigint, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE existing freehold.monetary_cap_requests; rid uuid;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'GOVERNANCE_POLICY');
  PERFORM freehold._monetary_lock(p_book);
  SELECT * INTO existing FROM freehold.monetary_cap_requests WHERE book_id = p_book AND idempotency_key = p_key;
  IF FOUND THEN
    RETURN jsonb_build_object('requestId', existing.id, 'state', existing.state);
  END IF;
  INSERT INTO freehold.monetary_cap_requests(book_id, idempotency_key, requester_id, proposed_max, state)
  VALUES (p_book, p_key, p_actor, p_max, 'PENDING') RETURNING id INTO rid;
  RETURN jsonb_build_object('requestId', rid, 'state', 'PENDING');
END $$;

CREATE FUNCTION freehold.monetary_cap_approve(p_actor uuid, p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE req freehold.monetary_cap_requests; supply freehold.monetary_supply;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'FINANCIAL_RISK');
  SELECT * INTO req FROM freehold.monetary_cap_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM freehold._monetary_lock(req.book_id);
  IF req.state = 'APPROVED' THEN RETURN jsonb_build_object('requestId', req.id, 'state', 'APPROVED'); END IF;
  IF p_actor = req.requester_id THEN RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023'; END IF;
  SELECT * INTO supply FROM freehold.monetary_supply WHERE book_id = req.book_id;
  IF req.proposed_max < supply.outstanding + supply.pending_issuance THEN
    RAISE EXCEPTION 'MONETARY_CAP' USING ERRCODE='22023';
  END IF;
  UPDATE freehold.monetary_books SET authorized_max_outstanding = req.proposed_max WHERE id = req.book_id;
  UPDATE freehold.monetary_cap_requests SET state = 'APPROVED', approver_id = p_actor WHERE id = req.id;
  RETURN jsonb_build_object('requestId', req.id, 'state', 'APPROVED', 'authorizedMaxOutstanding', req.proposed_max::text);
END $$;

CREATE FUNCTION freehold.monetary_report_draft(p_actor uuid, p_book uuid, p_start date, p_end date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE b freehold.monetary_books; rid uuid; body jsonb; supply freehold.monetary_supply; eligible bigint;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'FINANCIAL_RISK');
  SELECT * INTO b FROM freehold.monetary_books WHERE id = p_book;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO supply FROM freehold.monetary_supply WHERE book_id = p_book;
  eligible := CASE WHEN b.product_code = 'PAYMENT_STABLECOIN' THEN freehold._monetary_eligible(p_book) ELSE 0 END;
  body := jsonb_build_object(
    'reportingEntity', (SELECT code FROM freehold.legal_entities WHERE id = b.entity_id),
    'framework', '12 USC 5903 simulation draft',
    'periodStart', p_start, 'periodEnd', p_end,
    'outstanding', supply.outstanding::text,
    'issuedLifetime', supply.issued_lifetime::text,
    'redeemedLifetime', supply.redeemed_lifetime::text,
    'simulatedEligibleReserves', eligible::text,
    'externalEvidenceStatus', 'UNAVAILABLE',
    'certificationStatus', 'NOT_CERTIFIED',
    'submissionStatus', 'NOT_SUBMITTED',
    'accountingSource', 'freehold.monetary_supply');
  PERFORM set_config('freehold.monetary_writer','on',true);
  INSERT INTO freehold.regulatory_reports(
    entity_id, book_id, framework, period_start, period_end, state, submission_status,
    certification_status, external_evidence_status, body, created_by)
  VALUES (b.entity_id, p_book, 'GENIUS_ACT_12_USC_5903', p_start, p_end, 'DRAFT', 'NOT_SUBMITTED',
    'NOT_CERTIFIED', 'UNAVAILABLE', body, p_actor)
  RETURNING id INTO rid;
  RETURN jsonb_build_object('reportId', rid, 'state', 'DRAFT', 'certificationStatus', 'NOT_CERTIFIED', 'submissionStatus', 'NOT_SUBMITTED', 'body', body);
END $$;

CREATE FUNCTION freehold.monetary_report_transition(p_actor uuid, p_report uuid, p_state text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE report freehold.regulatory_reports;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'FINANCIAL_RISK');
  IF p_state = 'SUBMITTED_WITH_EVIDENCE' THEN
    RAISE EXCEPTION 'MONETARY_SUBMISSION_REFUSED' USING ERRCODE='22023';
  END IF;
  IF p_state NOT IN ('PENDING_REVIEW','APPROVED_INTERNALLY','EXTERNAL_REVIEW_REQUIRED','READY_FOR_AUTHORIZED_SUBMISSION','REJECTED','INCOMPLETE') THEN
    RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT * INTO report FROM freehold.regulatory_reports WHERE id = p_report FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM set_config('freehold.monetary_writer','on',true);
  UPDATE freehold.regulatory_reports SET state = p_state WHERE id = p_report;
  RETURN jsonb_build_object('reportId', p_report, 'state', p_state, 'submissionStatus', 'NOT_SUBMITTED', 'certificationStatus', 'NOT_CERTIFIED');
END $$;

CREATE FUNCTION freehold.monetary_activate_live(p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'LIVE_MONETARY_ACTIVATION_REFUSED' USING ERRCODE='22023';
END $$;

CREATE FUNCTION freehold.monetary_chain_observe(
  p_actor uuid, p_book uuid, p_kind text, p_tx text, p_finality text, p_depth integer, p_amount bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE existing freehold.chain_observations; oid uuid; before_outstanding bigint;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'SECURITY_ADMIN');
  PERFORM freehold._monetary_lock(p_book);
  SELECT outstanding INTO before_outstanding FROM freehold.monetary_supply WHERE book_id = p_book;
  SELECT * INTO existing FROM freehold.chain_observations WHERE network = 'MOCK' AND tx_ref = p_tx;
  IF FOUND THEN
    RETURN jsonb_build_object('observationId', existing.id, 'finality', existing.finality, 'duplicate', true, 'supplyChanged', false);
  END IF;
  IF p_finality = 'FINAL' AND p_depth < 12 THEN RAISE EXCEPTION 'MONETARY_STATE' USING ERRCODE='22023'; END IF;
  INSERT INTO freehold.chain_observations(book_id, network, kind, tx_ref, finality, confirmation_depth, observed_amount, observed_by)
  VALUES (p_book, 'MOCK', p_kind, p_tx, p_finality, p_depth, p_amount, p_actor)
  RETURNING id INTO oid;
  RETURN jsonb_build_object('observationId', oid, 'finality', p_finality, 'outstandingUnchanged', before_outstanding::text, 'supplyChanged', false);
END $$;

CREATE FUNCTION freehold.monetary_chain_reorg(p_actor uuid, p_tx text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE row freehold.chain_observations; before_outstanding bigint;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'SECURITY_ADMIN');
  SELECT * INTO row FROM freehold.chain_observations WHERE network = 'MOCK' AND tx_ref = p_tx FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  IF p_actor = row.observed_by THEN RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023'; END IF;
  PERFORM freehold._monetary_lock(row.book_id);
  SELECT outstanding INTO before_outstanding FROM freehold.monetary_supply WHERE book_id = row.book_id;
  UPDATE freehold.chain_observations SET finality = 'REORGED' WHERE id = row.id;
  RETURN jsonb_build_object('txRef', p_tx, 'finality', 'REORGED', 'outstanding', before_outstanding::text, 'supplyChanged', false);
END $$;

CREATE FUNCTION freehold.monetary_fhu_issue(p_actor uuid, p_amount bigint, p_holder uuid, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE book uuid := '20000000-0000-4000-8000-000000000002';
  fusd uuid := '20000000-0000-4000-8000-000000000001';
  existing freehold.issuance_operations; row_id uuid; jid uuid; fusd_before bigint; fusd_after bigint;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'GOVERNANCE_POLICY');
  PERFORM freehold._monetary_writes_open();
  PERFORM freehold._monetary_lock(book);
  SELECT outstanding INTO fusd_before FROM freehold.monetary_supply WHERE book_id = fusd;
  SELECT * INTO existing FROM freehold.issuance_operations WHERE book_id = book AND idempotency_key = p_key;
  IF FOUND THEN RETURN jsonb_build_object('issuanceId', existing.id, 'state', existing.state, 'unit', 'FHU', 'valueClaim', false); END IF;
  INSERT INTO freehold.issuance_operations(book_id, idempotency_key, requester_id, holder_ref, amount_minor, state)
  VALUES (book, p_key, p_actor, p_holder, p_amount, 'APPROVED') RETURNING id INTO row_id;
  IF p_holder IS NULL THEN
    PERFORM freehold._monetary_holder_add(book, 'TREASURY', NULL, p_amount);
  ELSE
    PERFORM freehold._monetary_holder_add(book, 'CUSTOMER', p_holder, p_amount);
  END IF;
  jid := freehold._monetary_post(book, row_id, 'FHU_ISSUE', 'EXPERIMENTAL_UNIT_NO_RESERVE_AND_NO_VALUE_CLAIM',
    'EXPERIMENTAL_CLEARING', 'EXPERIMENTAL_LIABILITY', p_amount);
  UPDATE freehold.issuance_operations SET state = 'ISSUED', journal_id = jid WHERE id = row_id;
  PERFORM freehold._monetary_recompute(book);
  SELECT outstanding INTO fusd_after FROM freehold.monetary_supply WHERE book_id = fusd;
  IF fusd_before IS DISTINCT FROM fusd_after THEN RAISE EXCEPTION 'MONETARY_SUPPLY_MISMATCH' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('issuanceId', row_id, 'state', 'ISSUED', 'unit', 'FHU', 'valueClaim', false, 'fusdOutstanding', fusd_after::text);
END $$;

CREATE FUNCTION freehold.monetary_screen(p_actor uuid, p_subject text, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE existing freehold.monetary_screenings; sid uuid;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'COMPLIANCE_OFFICER');
  SELECT * INTO existing FROM freehold.monetary_screenings WHERE idempotency_key = p_key;
  IF FOUND THEN
    RETURN jsonb_build_object('screeningId', existing.id, 'disposition', existing.disposition, 'determination', existing.determination);
  END IF;
  PERFORM set_config('freehold.monetary_writer','on',true);
  INSERT INTO freehold.monetary_screenings(subject_ref, provider, disposition, human_review_required, determination, idempotency_key, recorded_by)
  VALUES (p_subject, 'SIMULATED', 'POTENTIAL_MATCH', true, 'NOT_AN_OFAC_DETERMINATION', p_key, p_actor)
  RETURNING id INTO sid;
  RETURN jsonb_build_object('screeningId', sid, 'disposition', 'POTENTIAL_MATCH', 'humanReviewRequired', true, 'determination', 'NOT_AN_OFAC_DETERMINATION', 'program', 'NOT_A_BSA_PROGRAM');
END $$;

CREATE FUNCTION freehold.monetary_conversion_request(p_actor uuid, p_account uuid, p_amount bigint, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE owner uuid; available bigint; existing freehold.conversion_requests;
BEGIN
  PERFORM freehold._require_bound_session(p_actor);
  SELECT * INTO existing FROM freehold.conversion_requests WHERE idempotency_key = p_key;
  IF FOUND THEN
    RETURN jsonb_build_object('state', existing.state, 'reason', existing.reason, 'availableMinor', existing.available_after::text);
  END IF;
  SELECT owner_user_id, available_minor INTO owner, available FROM freehold.accounts WHERE id = p_account;
  IF owner IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'MONETARY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  PERFORM set_config('freehold.monetary_writer','on',true);
  INSERT INTO freehold.conversion_requests(actor_id, account_id, amount_minor, state, reason, idempotency_key, available_before, available_after)
  VALUES (p_actor, p_account, p_amount, 'REJECTED', 'UNBACKED_CONVERSION_REFUSED', p_key, available, available);
  RETURN jsonb_build_object('state', 'REJECTED', 'reason', 'UNBACKED_CONVERSION_REFUSED', 'availableMinor', available::text, 'fusdCredited', '0');
END $$;

CREATE FUNCTION freehold.monetary_restriction_set(p_actor uuid, p_subject uuid, p_kind text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE rid uuid;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'COMPLIANCE_OFFICER');
  IF p_actor = p_subject THEN RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023'; END IF;
  PERFORM set_config('freehold.monetary_writer','on',true);
  INSERT INTO freehold.monetary_restrictions(subject_user_id, kind, reason, created_by)
  VALUES (p_subject, p_kind, p_reason, p_actor) RETURNING id INTO rid;
  RETURN jsonb_build_object('restrictionId', rid, 'kind', p_kind, 'active', true);
END $$;

CREATE FUNCTION freehold.monetary_freeze_units(p_actor uuid, p_book uuid, p_holder uuid, p_amount bigint, p_freeze boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM freehold.monetary_capabilities
    WHERE principal_id = p_actor AND capability IN ('COMPLIANCE_OFFICER','EMERGENCY_CONTROL') AND revoked_at IS NULL
  ) THEN RAISE EXCEPTION 'MONETARY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  PERFORM freehold._require_bound_session(p_actor);
  IF p_actor = p_holder THEN RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023'; END IF;
  PERFORM freehold._monetary_lock(p_book);
  IF p_freeze THEN
    PERFORM freehold._monetary_holder_add(p_book, 'CUSTOMER', p_holder, -p_amount);
    PERFORM freehold._monetary_holder_add(p_book, 'FROZEN', p_holder, p_amount);
  ELSE
    PERFORM freehold._monetary_holder_add(p_book, 'FROZEN', p_holder, -p_amount);
    PERFORM freehold._monetary_holder_add(p_book, 'CUSTOMER', p_holder, p_amount);
  END IF;
  PERFORM freehold._monetary_recompute(p_book);
  RETURN jsonb_build_object('frozen', p_freeze, 'amountMinor', p_amount::text);
END $$;

CREATE FUNCTION freehold.monetary_alert_acknowledge(p_actor uuid, p_alert uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE alert freehold.monetary_alerts; before_outstanding bigint; after_outstanding bigint;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'FINANCIAL_RISK');
  SELECT * INTO alert FROM freehold.monetary_alerts WHERE id = p_alert;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT outstanding INTO before_outstanding FROM freehold.monetary_supply WHERE book_id = alert.book_id;
  PERFORM set_config('freehold.monetary_writer','on',true);
  UPDATE freehold.monetary_alerts SET acknowledged_by = p_actor, acknowledged_at = clock_timestamp() WHERE id = p_alert;
  SELECT outstanding INTO after_outstanding FROM freehold.monetary_supply WHERE book_id = alert.book_id;
  IF before_outstanding IS DISTINCT FROM after_outstanding THEN
    RAISE EXCEPTION 'MONETARY_SUPPLY_MISMATCH' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('alertId', p_alert, 'outstandingUnchanged', after_outstanding::text);
END $$;

REVOKE ALL ON FUNCTION freehold.monetary_bootstrap_capability(uuid, text) FROM PUBLIC, freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA freehold FROM PUBLIC;

GRANT EXECUTE ON FUNCTION freehold.monetary_overview(uuid) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_bank_open(uuid, uuid, text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_bank_event(uuid, uuid, text, text, bigint, text, text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_issue_request(uuid, uuid, bigint, uuid, text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_issue_verify(uuid, uuid) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_issue_approve(uuid, uuid) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_issue_execute(uuid, uuid) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_issue_mark_unknown(uuid, uuid) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_issue_resolve_unknown(uuid, uuid) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_redeem_request(uuid, uuid, bigint, text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_redeem_settlement(uuid, uuid, text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_redeem_finalize(uuid, uuid) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_redeem_mark_unknown(uuid, uuid) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_redeem_resolve_unknown(uuid, uuid) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_reserve_propose(uuid, uuid, text, bigint, text, date, text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_reserve_review(uuid, uuid, text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_reserve_encumber(uuid, uuid, boolean) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_reserve_mark_stale(uuid, uuid) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_grant_capability(uuid, uuid, text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_suspend(uuid, uuid, boolean) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_cap_request(uuid, uuid, bigint, text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_cap_approve(uuid, uuid) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_report_draft(uuid, uuid, date, date) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_report_transition(uuid, uuid, text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_activate_live(text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_chain_observe(uuid, uuid, text, text, text, integer, bigint) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_chain_reorg(uuid, text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_fhu_issue(uuid, bigint, uuid, text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_screen(uuid, text, text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_conversion_request(uuid, uuid, bigint, text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_restriction_set(uuid, uuid, text, text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_freeze_units(uuid, uuid, uuid, bigint, boolean) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_record_capital(uuid, bigint, text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_alert_acknowledge(uuid, uuid) TO freehold_api;

GRANT SELECT ON
  freehold.legal_entities, freehold.monetary_products, freehold.monetary_books, freehold.monetary_supply,
  freehold.monetary_holders, freehold.monetary_journals, freehold.monetary_entries, freehold.monetary_audit,
  freehold.reserve_assets, freehold.issuer_capital, freehold.monetary_capabilities, freehold.issuance_operations,
  freehold.redemption_operations, freehold.settlement_evidence, freehold.bank_accounts, freehold.bank_events,
  freehold.monetary_cap_requests, freehold.cross_entity_obligations, freehold.chain_observations,
  freehold.monetary_signing_posts, freehold.regulatory_reports, freehold.monetary_compliance_profiles,
  freehold.monetary_screenings, freehold.monetary_restrictions, freehold.regulator_requests,
  freehold.product_disclosures, freehold.supply_corrections, freehold.monetary_alerts, freehold.conversion_requests
TO freehold_verifier;

RESET ROLE;
