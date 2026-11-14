-- Phase 14 programmable sandbox. Simulation only. No live issuance, no external settlement,
-- no legal escrow, and no distributed atomic commit. Institutional money moves only through
-- freehold._institution_post. Simulated FUSD supply changes only through the existing
-- monetary_issue_request, verify, approve, and execute separation. This file does not edit 001-026.
-- A coordinated external leg records UNKNOWN and posts nothing. That is not atomic settlement
-- across independently administered ledgers.
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;

CREATE TABLE freehold.program_controls (
  institution_id uuid PRIMARY KEY REFERENCES freehold.institutions(id),
  suspended boolean NOT NULL DEFAULT false,
  suspended_by uuid,
  suspended_at timestamptz,
  CHECK ((NOT suspended) OR (suspended_by IS NOT NULL AND suspended_at IS NOT NULL))
);

CREATE TABLE freehold.program_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  domain text NOT NULL CHECK (domain IN (
    'PAYMENT','TREASURY','LIQUIDITY','SETTLEMENT','RESERVE','ASSET_TRANSFER','APPROVAL','RISK','ESCROW','ISSUANCE')),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','RETIRED')),
  body jsonb NOT NULL,
  precedence integer NOT NULL CHECK (precedence >= 0 AND precedence <= 1000),
  max_exposure_minor bigint NOT NULL CHECK (max_exposure_minor > 0),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  effective_from timestamptz NOT NULL,
  effective_until timestamptz NOT NULL,
  snapshot_hash text,
  created_by uuid NOT NULL,
  approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (institution_id, domain, version),
  CHECK (effective_until > effective_from),
  CHECK (status <> 'APPROVED' OR (snapshot_hash IS NOT NULL AND approved_by IS NOT NULL AND approved_by <> created_by)),
  CHECK (snapshot_hash IS NULL OR snapshot_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE freehold.program_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  created_by uuid NOT NULL,
  definition_version integer NOT NULL DEFAULT 1 CHECK (definition_version > 0),
  status text NOT NULL CHECK (status IN (
    'DRAFT','VALIDATING','PENDING_APPROVAL','APPROVED','SCHEDULED','EXECUTING','COMPLETED','FAILED','CANCELLED','EXPIRED','UNKNOWN')),
  definition jsonb NOT NULL,
  definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  policy_id uuid REFERENCES freehold.program_policies(id),
  policy_snapshot_hash text,
  max_exposure_minor bigint NOT NULL CHECK (max_exposure_minor > 0),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  not_before timestamptz,
  deadline timestamptz NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 80),
  required_approvals integer NOT NULL CHECK (required_approvals BETWEEN 1 AND 5),
  approval_count integer NOT NULL DEFAULT 0 CHECK (approval_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (institution_id, idempotency_key),
  CHECK (approval_count <= required_approvals),
  CHECK (status NOT IN ('APPROVED','SCHEDULED','EXECUTING','COMPLETED','FAILED','EXPIRED','UNKNOWN') OR policy_snapshot_hash IS NOT NULL)
);

CREATE TABLE freehold.program_approvals (
  workflow_id uuid NOT NULL REFERENCES freehold.program_workflows(id),
  actor_id uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workflow_id, actor_id)
);

CREATE TABLE freehold.program_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid REFERENCES freehold.program_workflows(id),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 120),
  state text NOT NULL CHECK (state IN ('SCHEDULED','EXECUTING','COMPLETED','FAILED','UNKNOWN','EXPIRED','CANCELLED')),
  atomicity text NOT NULL CHECK (atomicity IN ('SINGLE_DATABASE','COORDINATED_NOT_ATOMIC','NONE')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE (institution_id, idempotency_key)
);

CREATE TABLE freehold.program_legs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL REFERENCES freehold.program_executions(id),
  ordinal integer NOT NULL CHECK (ordinal >= 0 AND ordinal < 16),
  kind text NOT NULL CHECK (kind IN (
    'TRANSFER','HOLD','RELEASE','RETURN','RECONCILE','COORDINATED_EXTERNAL','REVERSAL','FUSD_ISSUE_REQUEST','SETTLEMENT')),
  state text NOT NULL CHECK (state IN ('PENDING','POSTED','FAILED','UNKNOWN','AWAITING_EXTERNAL','RECONCILED','EXPIRED')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  institution_id uuid NOT NULL,
  debit_account_id uuid,
  credit_account_id uuid,
  journal_id uuid,
  coordination text NOT NULL CHECK (coordination IN ('SINGLE_DATABASE','AWAITING_EXTERNAL','NOT_ATOMIC')),
  UNIQUE (execution_id, ordinal),
  CHECK (state <> 'POSTED' OR journal_id IS NOT NULL),
  CHECK (coordination <> 'AWAITING_EXTERNAL' OR journal_id IS NULL)
);

CREATE TABLE freehold.program_escrows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  workflow_id uuid REFERENCES freehold.program_workflows(id),
  source_account_id uuid NOT NULL,
  suspense_account_id uuid NOT NULL,
  beneficiary_institution_id uuid NOT NULL,
  beneficiary_ref text NOT NULL CHECK (char_length(beneficiary_ref) BETWEEN 1 AND 80),
  conditions jsonb NOT NULL,
  reserved_minor bigint NOT NULL CHECK (reserved_minor > 0),
  released_minor bigint NOT NULL DEFAULT 0 CHECK (released_minor >= 0),
  status text NOT NULL CHECK (status IN ('FUNDED','DISPUTED','RELEASED','RETURNED','CANCELLED','EXPIRED')),
  expires_at timestamptz NOT NULL,
  fund_journal_id uuid,
  release_journal_id uuid,
  funded_by uuid NOT NULL,
  released_by uuid,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 80),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (institution_id, idempotency_key),
  CHECK (released_minor <= reserved_minor),
  CHECK (status NOT IN ('RELEASED','RETURNED') OR (released_minor = reserved_minor AND release_journal_id IS NOT NULL AND released_by IS NOT NULL)),
  CHECK (status NOT IN ('FUNDED','DISPUTED','EXPIRED','CANCELLED') OR (released_minor = 0 AND release_journal_id IS NULL))
);

CREATE TABLE freehold.program_treasury (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  recommendation_id uuid,
  kind text NOT NULL CHECK (kind IN ('RECOMMENDATION','EXECUTED')),
  movement text NOT NULL CHECK (movement IN (
    'SWEEP','FUNDING','RESERVE_ALLOCATION','SCHEDULED','QUEUE_PRIORITY','CONCENTRATION_ALERT','REDEMPTION_FORECAST','CASHFLOW_PROJECTION')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  from_kind text,
  to_kind text,
  status text NOT NULL CHECK (status IN ('PROPOSED','APPROVED','EXECUTED','REJECTED')),
  high_risk boolean NOT NULL DEFAULT false,
  policy_id uuid,
  journal_id uuid,
  created_by uuid NOT NULL,
  approved_by uuid,
  executed_by uuid,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (kind <> 'RECOMMENDATION' OR journal_id IS NULL),
  CHECK (kind <> 'EXECUTED' OR (journal_id IS NOT NULL AND executed_by IS NOT NULL AND recommendation_id IS NOT NULL)),
  CHECK (movement NOT IN ('QUEUE_PRIORITY','CONCENTRATION_ALERT','REDEMPTION_FORECAST','CASHFLOW_PROJECTION') OR kind = 'RECOMMENDATION')
);

CREATE TABLE freehold.program_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer_institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  legal_entity_id uuid NOT NULL,
  asset_type text NOT NULL CHECK (asset_type IN (
    'PAYMENT_STABLECOIN_UNIT','TOKENIZED_DEPOSIT','INSTITUTIONAL_DEBT','SECURITY','RECEIVABLE','COMMODITY_CLAIM')),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9-]{3,24}$'),
  denomination text NOT NULL CHECK (denomination ~ '^[A-Z]{3}$'),
  ownership_model text NOT NULL DEFAULT 'INSTITUTION_BOOK' CHECK (ownership_model = 'INSTITUTION_BOOK'),
  transfer_restrictions jsonb NOT NULL DEFAULT '{}'::jsonb,
  settlement_rules jsonb NOT NULL DEFAULT '{"atomic":"SINGLE_DATABASE_ONLY"}'::jsonb,
  valuation_source text NOT NULL DEFAULT 'SIMULATED_INTERNAL' CHECK (valuation_source = 'SIMULATED_INTERNAL'),
  external_evidence text NOT NULL DEFAULT 'EXTERNAL_EVIDENCE_UNAVAILABLE' CHECK (external_evidence = 'EXTERNAL_EVIDENCE_UNAVAILABLE'),
  lifecycle text NOT NULL CHECK (lifecycle IN (
    'REGISTERED','AUTHORIZED','ISSUED','HELD','RELEASED','REDEEMED','RETIRED','CANCELLED')),
  supply_minor bigint NOT NULL DEFAULT 0 CHECK (supply_minor >= 0),
  simulation_only boolean NOT NULL DEFAULT true CHECK (simulation_only),
  live_authorized boolean NOT NULL DEFAULT false CHECK (NOT live_authorized),
  created_by uuid NOT NULL,
  authorized_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (issuer_institution_id, code)
);

CREATE TABLE freehold.program_asset_positions (
  asset_id uuid NOT NULL REFERENCES freehold.program_assets(id),
  holder_institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  available_minor bigint NOT NULL DEFAULT 0 CHECK (available_minor >= 0),
  held_minor bigint NOT NULL DEFAULT 0 CHECK (held_minor >= 0),
  pledged_minor bigint NOT NULL DEFAULT 0 CHECK (pledged_minor >= 0),
  PRIMARY KEY (asset_id, holder_institution_id)
);

CREATE TABLE freehold.program_asset_journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES freehold.program_assets(id),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 120),
  kind text NOT NULL CHECK (kind IN ('ISSUE','TRANSFER','HOLD','RELEASE','PLEDGE','UNPLEDGE','REDEEM','RETIRE')),
  quantity_minor bigint NOT NULL CHECK (quantity_minor > 0),
  from_holder uuid,
  to_holder uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (asset_id, idempotency_key)
);

CREATE TABLE freehold.program_exchange_members (
  institution_id uuid PRIMARY KEY REFERENCES freehold.institutions(id),
  admitted_by uuid NOT NULL,
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  simulation_only boolean NOT NULL DEFAULT true CHECK (simulation_only)
);

CREATE TABLE freehold.program_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quoter_institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  base_asset_id uuid NOT NULL REFERENCES freehold.program_assets(id),
  quote_asset_id uuid NOT NULL REFERENCES freehold.program_assets(id),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor > 0),
  quantity_minor bigint NOT NULL CHECK (quantity_minor > 0),
  kind text NOT NULL CHECK (kind IN ('FIRM','INDICATIVE')),
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN','EXPIRED','EXECUTED','CANCELLED')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (base_asset_id <> quote_asset_id),
  CHECK (kind <> 'INDICATIVE' OR status <> 'EXECUTED')
);

CREATE TABLE freehold.program_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL UNIQUE REFERENCES freehold.program_quotes(id),
  buyer_institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  seller_institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  quantity_minor bigint NOT NULL CHECK (quantity_minor > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor > 0),
  base_journal_id uuid NOT NULL,
  quote_journal_id uuid NOT NULL,
  atomicity text NOT NULL DEFAULT 'SINGLE_DATABASE' CHECK (atomicity = 'SINGLE_DATABASE'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (buyer_institution_id <> seller_institution_id)
);

CREATE TABLE freehold.program_collateral (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES freehold.program_assets(id),
  pledgor_institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  quantity_minor bigint NOT NULL CHECK (quantity_minor > 0),
  haircut_bps integer NOT NULL CHECK (haircut_bps >= 0 AND haircut_bps < 10000),
  arrangement_key text NOT NULL CHECK (char_length(arrangement_key) BETWEEN 3 AND 80),
  status text NOT NULL CHECK (status IN ('PLEDGED','RELEASED','SUBSTITUTED','DEFAULTED_SIMULATION')),
  pledge_journal_id uuid,
  release_journal_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (asset_id, pledgor_institution_id, arrangement_key)
);

CREATE TABLE freehold.program_issuance_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES freehold.institutions(id),
  book_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status text NOT NULL CHECK (status IN ('REQUESTED','REJECTED_COVERAGE','REJECTED_CAP','SCHEDULED','CANCELLED')),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 80),
  changes_supply boolean NOT NULL DEFAULT false CHECK (NOT changes_supply),
  monetary_journal_id uuid CHECK (monetary_journal_id IS NULL),
  not_before timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (book_id, idempotency_key)
);

CREATE TABLE freehold.program_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  actor_id uuid,
  action text NOT NULL,
  object_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION freehold._program_writer() RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM set_config('freehold.program_writer', 'on', true);
END $fn$;

CREATE FUNCTION freehold._program_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
BEGIN
  IF current_setting('freehold.program_writer', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'PROGRAM_DIRECT_WRITE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PROGRAM_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'program_policies' THEN
      IF OLD.status = 'RETIRED' THEN
        RAISE EXCEPTION 'PROGRAM_POLICY_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
      IF OLD.status = 'APPROVED' AND (
        NEW.body IS DISTINCT FROM OLD.body OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
        OR NEW.max_exposure_minor IS DISTINCT FROM OLD.max_exposure_minor OR NEW.domain IS DISTINCT FROM OLD.domain
        OR NEW.version IS DISTINCT FROM OLD.version OR NEW.precedence IS DISTINCT FROM OLD.precedence
        OR NEW.currency_code IS DISTINCT FROM OLD.currency_code OR NEW.institution_id IS DISTINCT FROM OLD.institution_id
        OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
      ) THEN
        RAISE EXCEPTION 'PROGRAM_POLICY_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
      IF OLD.status = 'APPROVED' AND NEW.status IS DISTINCT FROM 'APPROVED' AND NEW.status IS DISTINCT FROM 'RETIRED' THEN
        RAISE EXCEPTION 'PROGRAM_POLICY_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'program_workflows' THEN
      IF OLD.institution_id IS DISTINCT FROM NEW.institution_id OR OLD.created_by IS DISTINCT FROM NEW.created_by
         OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key OR OLD.max_exposure_minor IS DISTINCT FROM NEW.max_exposure_minor
         OR OLD.currency_code IS DISTINCT FROM NEW.currency_code OR OLD.deadline IS DISTINCT FROM NEW.deadline
         OR OLD.required_approvals IS DISTINCT FROM NEW.required_approvals OR OLD.not_before IS DISTINCT FROM NEW.not_before
         OR OLD.definition_version IS DISTINCT FROM NEW.definition_version THEN
        RAISE EXCEPTION 'PROGRAM_DEFINITION_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
      IF OLD.status IS DISTINCT FROM 'DRAFT' AND NEW.definition IS DISTINCT FROM OLD.definition THEN
        RAISE EXCEPTION 'PROGRAM_DEFINITION_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
      IF OLD.definition_hash IS DISTINCT FROM NEW.definition_hash THEN
        RAISE EXCEPTION 'PROGRAM_DEFINITION_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
      IF OLD.policy_snapshot_hash IS NOT NULL AND NEW.policy_snapshot_hash IS DISTINCT FROM OLD.policy_snapshot_hash THEN
        RAISE EXCEPTION 'PROGRAM_DEFINITION_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
      IF OLD.status IN ('COMPLETED','FAILED','CANCELLED','EXPIRED','UNKNOWN') AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'PROGRAM_STATE' USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'program_executions' THEN
      IF OLD.workflow_id IS DISTINCT FROM NEW.workflow_id OR OLD.institution_id IS DISTINCT FROM NEW.institution_id
         OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key OR OLD.atomicity IS DISTINCT FROM NEW.atomicity THEN
        RAISE EXCEPTION 'PROGRAM_STATE' USING ERRCODE = '55000';
      END IF;
      IF OLD.state IN ('COMPLETED','FAILED','UNKNOWN','EXPIRED','CANCELLED') AND NEW.state IS DISTINCT FROM OLD.state THEN
        RAISE EXCEPTION 'PROGRAM_STATE' USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'program_legs' THEN
      IF OLD.execution_id IS DISTINCT FROM NEW.execution_id OR OLD.ordinal IS DISTINCT FROM NEW.ordinal
         OR OLD.amount_minor IS DISTINCT FROM NEW.amount_minor OR OLD.kind IS DISTINCT FROM NEW.kind THEN
        RAISE EXCEPTION 'PROGRAM_STATE' USING ERRCODE = '55000';
      END IF;
      IF OLD.journal_id IS NOT NULL AND NEW.journal_id IS DISTINCT FROM OLD.journal_id THEN
        RAISE EXCEPTION 'PROGRAM_STATE' USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'program_escrows' THEN
      IF OLD.conditions IS DISTINCT FROM NEW.conditions OR OLD.reserved_minor IS DISTINCT FROM NEW.reserved_minor
         OR OLD.institution_id IS DISTINCT FROM NEW.institution_id OR OLD.source_account_id IS DISTINCT FROM NEW.source_account_id
         OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key OR OLD.expires_at IS DISTINCT FROM NEW.expires_at THEN
        RAISE EXCEPTION 'PROGRAM_ESCROW_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
      IF OLD.released_minor <> 0 AND NEW.released_minor IS DISTINCT FROM OLD.released_minor THEN
        RAISE EXCEPTION 'PROGRAM_ESCROW_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
      IF OLD.status IN ('RELEASED','RETURNED','CANCELLED','EXPIRED') AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'PROGRAM_ESCROW' USING ERRCODE = '55000';
      END IF;
      IF OLD.fund_journal_id IS NOT NULL AND NEW.fund_journal_id IS DISTINCT FROM OLD.fund_journal_id THEN
        RAISE EXCEPTION 'PROGRAM_ESCROW_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'program_treasury' THEN
      IF OLD.amount_minor IS DISTINCT FROM NEW.amount_minor OR OLD.kind IS DISTINCT FROM NEW.kind
         OR OLD.movement IS DISTINCT FROM NEW.movement OR OLD.institution_id IS DISTINCT FROM NEW.institution_id THEN
        RAISE EXCEPTION 'PROGRAM_TREASURY' USING ERRCODE = '55000';
      END IF;
      IF OLD.journal_id IS NOT NULL AND NEW.journal_id IS DISTINCT FROM OLD.journal_id THEN
        RAISE EXCEPTION 'PROGRAM_TREASURY' USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'program_asset_journals' THEN
      RAISE EXCEPTION 'PROGRAM_ASSET_IMMUTABLE' USING ERRCODE = '55000';
    ELSIF TG_TABLE_NAME = 'program_audit' THEN
      RAISE EXCEPTION 'PROGRAM_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
    ELSIF TG_TABLE_NAME = 'program_assets' THEN
      IF NEW.live_authorized OR NOT NEW.simulation_only OR NEW.valuation_source IS DISTINCT FROM 'SIMULATED_INTERNAL'
         OR NEW.external_evidence IS DISTINCT FROM 'EXTERNAL_EVIDENCE_UNAVAILABLE' THEN
        RAISE EXCEPTION 'PROGRAM_ASSET' USING ERRCODE = '55000';
      END IF;
      IF OLD.issuer_institution_id IS DISTINCT FROM NEW.issuer_institution_id OR OLD.asset_type IS DISTINCT FROM NEW.asset_type
         OR OLD.code IS DISTINCT FROM NEW.code OR OLD.legal_entity_id IS DISTINCT FROM NEW.legal_entity_id THEN
        RAISE EXCEPTION 'PROGRAM_ASSET_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'program_quotes' THEN
      IF OLD.unit_price_minor IS DISTINCT FROM NEW.unit_price_minor OR OLD.quantity_minor IS DISTINCT FROM NEW.quantity_minor
         OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.quoter_institution_id IS DISTINCT FROM NEW.quoter_institution_id THEN
        RAISE EXCEPTION 'PROGRAM_QUOTE' USING ERRCODE = '55000';
      END IF;
      IF OLD.status = 'EXECUTED' AND NEW.status IS DISTINCT FROM 'EXECUTED' THEN
        RAISE EXCEPTION 'PROGRAM_QUOTE' USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'program_collateral' THEN
      IF OLD.quantity_minor IS DISTINCT FROM NEW.quantity_minor OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
         OR OLD.pledgor_institution_id IS DISTINCT FROM NEW.pledgor_institution_id OR OLD.haircut_bps IS DISTINCT FROM NEW.haircut_bps THEN
        RAISE EXCEPTION 'PROGRAM_COLLATERAL' USING ERRCODE = '55000';
      END IF;
      IF OLD.status <> 'PLEDGED' AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'PROGRAM_COLLATERAL' USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'program_issuance_requests' THEN
      IF OLD.amount_minor IS DISTINCT FROM NEW.amount_minor OR NEW.changes_supply OR NEW.monetary_journal_id IS NOT NULL THEN
        RAISE EXCEPTION 'PROGRAM_POLICY' USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER program_controls_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.program_controls
  FOR EACH ROW EXECUTE FUNCTION freehold._program_guard();
CREATE TRIGGER program_policies_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.program_policies
  FOR EACH ROW EXECUTE FUNCTION freehold._program_guard();
CREATE TRIGGER program_workflows_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.program_workflows
  FOR EACH ROW EXECUTE FUNCTION freehold._program_guard();
CREATE TRIGGER program_approvals_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.program_approvals
  FOR EACH ROW EXECUTE FUNCTION freehold._program_guard();
CREATE TRIGGER program_executions_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.program_executions
  FOR EACH ROW EXECUTE FUNCTION freehold._program_guard();
CREATE TRIGGER program_legs_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.program_legs
  FOR EACH ROW EXECUTE FUNCTION freehold._program_guard();
CREATE TRIGGER program_escrows_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.program_escrows
  FOR EACH ROW EXECUTE FUNCTION freehold._program_guard();
CREATE TRIGGER program_treasury_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.program_treasury
  FOR EACH ROW EXECUTE FUNCTION freehold._program_guard();
CREATE TRIGGER program_assets_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.program_assets
  FOR EACH ROW EXECUTE FUNCTION freehold._program_guard();
CREATE TRIGGER program_asset_positions_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.program_asset_positions
  FOR EACH ROW EXECUTE FUNCTION freehold._program_guard();
CREATE TRIGGER program_asset_journals_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.program_asset_journals
  FOR EACH ROW EXECUTE FUNCTION freehold._program_guard();
CREATE TRIGGER program_exchange_members_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.program_exchange_members
  FOR EACH ROW EXECUTE FUNCTION freehold._program_guard();
CREATE TRIGGER program_quotes_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.program_quotes
  FOR EACH ROW EXECUTE FUNCTION freehold._program_guard();
CREATE TRIGGER program_trades_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.program_trades
  FOR EACH ROW EXECUTE FUNCTION freehold._program_guard();
CREATE TRIGGER program_collateral_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.program_collateral
  FOR EACH ROW EXECUTE FUNCTION freehold._program_guard();
CREATE TRIGGER program_issuance_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.program_issuance_requests
  FOR EACH ROW EXECUTE FUNCTION freehold._program_guard();
CREATE TRIGGER program_audit_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.program_audit
  FOR EACH ROW EXECUTE FUNCTION freehold._program_guard();

CREATE FUNCTION freehold._program_audit(p_institution uuid, p_actor uuid, p_action text, p_object uuid, p_detail jsonb) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM freehold._program_writer();
  INSERT INTO freehold.program_audit(institution_id, actor_id, action, object_id, detail)
  VALUES (p_institution, p_actor, p_action, p_object, COALESCE(p_detail, '{}'::jsonb));
END $fn$;

CREATE FUNCTION freehold._program_open(p_institution uuid) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  IF COALESCE((SELECT writes_suspended FROM freehold.institutional_control WHERE singleton), false) THEN
    RAISE EXCEPTION 'PROGRAM_SUSPENDED' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM freehold.program_controls WHERE institution_id = p_institution AND suspended) THEN
    RAISE EXCEPTION 'PROGRAM_SUSPENDED' USING ERRCODE = '55000';
  END IF;
END $fn$;

CREATE FUNCTION freehold._program_hash(p_body jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT encode(public.digest(convert_to(p_body::text, 'UTF8'), 'sha256'), 'hex');
$fn$;

CREATE FUNCTION freehold._program_forbidden(p_value jsonb) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  key_name text;
  child jsonb;
BEGIN
  IF p_value IS NULL THEN RETURN; END IF;
  IF jsonb_typeof(p_value) = 'object' THEN
    FOR key_name, child IN SELECT * FROM jsonb_each(p_value) LOOP
      IF lower(key_name) IN ('sql','script','eval','function','shell','javascript','code','query','exec') THEN
        RAISE EXCEPTION 'PROGRAM_LANGUAGE' USING ERRCODE = '22023';
      END IF;
      PERFORM freehold._program_forbidden(child);
    END LOOP;
  ELSIF jsonb_typeof(p_value) = 'array' THEN
    FOR child IN SELECT value FROM jsonb_array_elements(p_value) LOOP
      PERFORM freehold._program_forbidden(child);
    END LOOP;
  ELSIF jsonb_typeof(p_value) = 'string' THEN
    IF p_value #>> '{}' ~* '(select |insert |update |delete |drop |alter |javascript:|/\*|eval\()' THEN
      RAISE EXCEPTION 'PROGRAM_LANGUAGE' USING ERRCODE = '22023';
    END IF;
  END IF;
END $fn$;

CREATE FUNCTION freehold._program_definition_ok(p_definition jsonb, p_max bigint) RETURNS bigint
LANGUAGE plpgsql AS $fn$
DECLARE
  step jsonb;
  steps jsonb;
  op text;
  key_name text;
  allowed text[];
  exposure bigint := 0;
  amount bigint;
  n integer := 0;
  fusd integer := 0;
  external_steps integer := 0;
BEGIN
  PERFORM freehold._program_forbidden(p_definition);
  IF p_definition->>'language' IS DISTINCT FROM 'fh-workflow-1' OR jsonb_typeof(p_definition->'steps') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'PROGRAM_LANGUAGE' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_definition->>'domain', 'PAYMENT') NOT IN (
    'PAYMENT','TREASURY','LIQUIDITY','SETTLEMENT','RESERVE','ASSET_TRANSFER','APPROVAL','RISK','ESCROW','ISSUANCE'
  ) THEN
    RAISE EXCEPTION 'PROGRAM_POLICY' USING ERRCODE = '22023';
  END IF;
  steps := p_definition->'steps';
  IF jsonb_array_length(steps) < 1 OR jsonb_array_length(steps) > 16 OR char_length(p_definition::text) > 8000 THEN
    RAISE EXCEPTION 'PROGRAM_LIMIT' USING ERRCODE = '22023';
  END IF;
  FOR step IN SELECT value FROM jsonb_array_elements(steps) LOOP
    n := n + 1;
    IF jsonb_typeof(step) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'PROGRAM_LANGUAGE' USING ERRCODE = '22023'; END IF;
    op := step->>'op';
    IF op = 'TRANSFER' THEN allowed := ARRAY['op','fromAccount','toAccount','amountMinor','notBefore'];
    ELSIF op = 'HOLD' THEN allowed := ARRAY['op','ref','fromAccount','amountMinor','beneficiaryInstitutionId','beneficiaryRef','notBefore'];
    ELSIF op = 'RELEASE' THEN allowed := ARRAY['op','ref','toAccount','notBefore'];
    ELSIF op = 'RETURN' THEN allowed := ARRAY['op','ref','notBefore'];
    ELSIF op = 'RECONCILE' THEN allowed := ARRAY['op','notBefore'];
    ELSIF op = 'COORDINATED_EXTERNAL' THEN allowed := ARRAY['op','amountMinor','note'];
    ELSIF op = 'REVERSAL' THEN allowed := ARRAY['op','executionId'];
    ELSIF op = 'FUSD_ISSUE_REQUEST' THEN allowed := ARRAY['op','bookId','amountMinor'];
    ELSE RAISE EXCEPTION 'PROGRAM_LANGUAGE' USING ERRCODE = '22023';
    END IF;
    FOR key_name IN SELECT jsonb_object_keys(step) LOOP
      IF NOT (key_name = ANY (allowed)) THEN RAISE EXCEPTION 'PROGRAM_LANGUAGE' USING ERRCODE = '22023'; END IF;
    END LOOP;
    IF op IN ('TRANSFER','HOLD','COORDINATED_EXTERNAL','FUSD_ISSUE_REQUEST') THEN
      IF COALESCE(step->>'amountMinor', '') !~ '^[1-9][0-9]{0,18}$' THEN
        RAISE EXCEPTION 'PROGRAM_LIMIT' USING ERRCODE = '22023';
      END IF;
      amount := (step->>'amountMinor')::bigint;
      exposure := exposure + amount;
    END IF;
    IF op = 'FUSD_ISSUE_REQUEST' THEN fusd := fusd + 1; END IF;
    IF op = 'COORDINATED_EXTERNAL' THEN external_steps := external_steps + 1; END IF;
    IF step ? 'notBefore' AND step->>'notBefore' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN
      RAISE EXCEPTION 'PROGRAM_LANGUAGE' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF fusd > 0 AND n <> 1 THEN RAISE EXCEPTION 'PROGRAM_POLICY' USING ERRCODE = '22023'; END IF;
  IF external_steps > 0 AND n <> 1 THEN RAISE EXCEPTION 'PROGRAM_NOT_ATOMIC' USING ERRCODE = '22023'; END IF;
  IF exposure > p_max THEN RAISE EXCEPTION 'PROGRAM_LIMIT' USING ERRCODE = '22023'; END IF;
  RETURN exposure;
END $fn$;

CREATE FUNCTION freehold._program_policy_ok(p_domain text, p_body jsonb, p_max bigint, p_currency text) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE key_name text;
BEGIN
  PERFORM freehold._program_forbidden(p_body);
  IF p_body->>'language' IS DISTINCT FROM 'fh-policy-1' OR p_body->>'domain' IS DISTINCT FROM p_domain THEN
    RAISE EXCEPTION 'PROGRAM_POLICY' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_body->>'maxExposureMinor', '') IS DISTINCT FROM p_max::text OR COALESCE(p_body->>'currency', '') IS DISTINCT FROM p_currency THEN
    RAISE EXCEPTION 'PROGRAM_POLICY' USING ERRCODE = '22023';
  END IF;
  IF char_length(p_body::text) > 4000 THEN RAISE EXCEPTION 'PROGRAM_LIMIT' USING ERRCODE = '22023'; END IF;
  FOR key_name IN SELECT jsonb_object_keys(p_body) LOOP
    IF key_name NOT IN ('language','domain','maxExposureMinor','currency','currencies','highRiskMinor','approvalThresholdMinor','counterparties') THEN
      RAISE EXCEPTION 'PROGRAM_POLICY' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF NOT (p_body->'currencies' ? p_currency) THEN RAISE EXCEPTION 'PROGRAM_POLICY' USING ERRCODE = '22023'; END IF;
END $fn$;

CREATE FUNCTION freehold._program_leg(p_institution uuid, p_debit uuid, p_credit uuid, p_amount bigint, p_key text) RETURNS uuid
LANGUAGE plpgsql AS $fn$
DECLARE
  debit_row freehold.institution_ledger_accounts;
  credit_row freehold.institution_ledger_accounts;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_debit = p_credit THEN
    RAISE EXCEPTION 'PROGRAM_LIMIT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO debit_row FROM freehold.institution_ledger_accounts WHERE id = p_debit;
  SELECT * INTO credit_row FROM freehold.institution_ledger_accounts WHERE id = p_credit;
  IF debit_row.id IS NULL OR credit_row.id IS NULL
     OR debit_row.institution_id IS DISTINCT FROM p_institution OR credit_row.institution_id IS DISTINCT FROM p_institution
     OR debit_row.currency_code IS DISTINCT FROM credit_row.currency_code
     OR debit_row.legal_entity_id IS DISTINCT FROM credit_row.legal_entity_id THEN
    RAISE EXCEPTION 'PROGRAM_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN freehold._institution_post(
    p_institution, debit_row.legal_entity_id, debit_row.currency_code, 'PROGRAM_LEG', p_key, gen_random_uuid(),
    'SIMULATED_PROGRAM_POSTING_NOT_EXTERNAL_SETTLEMENT',
    jsonb_build_array(
      jsonb_build_object('account', p_debit, 'side', 'DEBIT', 'amount', p_amount::text),
      jsonb_build_object('account', p_credit, 'side', 'CREDIT', 'amount', p_amount::text)));
END $fn$;

CREATE FUNCTION freehold._program_move(p_institution uuid, p_from uuid, p_to uuid, p_amount bigint, p_key text) RETURNS uuid
LANGUAGE plpgsql AS $fn$
DECLARE
  src freehold.institution_ledger_accounts;
  dst freehold.institution_ledger_accounts;
  from_side text;
  to_side text;
BEGIN
  SELECT * INTO src FROM freehold.institution_ledger_accounts WHERE id = p_from;
  SELECT * INTO dst FROM freehold.institution_ledger_accounts WHERE id = p_to;
  IF src.id IS NULL OR dst.id IS NULL OR src.institution_id IS DISTINCT FROM p_institution OR dst.institution_id IS DISTINCT FROM p_institution THEN
    RAISE EXCEPTION 'PROGRAM_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT (
    (src.kind IN ('TREASURY','OPERATING','RESERVE','SETTLEMENT_RECEIVABLE') AND dst.kind IN ('TREASURY','OPERATING','RESERVE','SETTLEMENT_RECEIVABLE'))
    OR (src.kind IN ('CUSTOMER','CLEARING','SETTLEMENT_PAYABLE','SUSPENSE') AND dst.kind IN ('CUSTOMER','CLEARING','SETTLEMENT_PAYABLE','SUSPENSE'))
  ) THEN
    RAISE EXCEPTION 'PROGRAM_POLICY' USING ERRCODE = '22023';
  END IF;
  IF src.kind IN ('TREASURY','OPERATING','RESERVE','SETTLEMENT_RECEIVABLE') THEN from_side := 'CREDIT'; ELSE from_side := 'DEBIT'; END IF;
  IF dst.kind IN ('TREASURY','OPERATING','RESERVE','SETTLEMENT_RECEIVABLE') THEN to_side := 'DEBIT'; ELSE to_side := 'CREDIT'; END IF;
  IF from_side = 'DEBIT' THEN
    RETURN freehold._program_leg(p_institution, p_from, p_to, p_amount, p_key);
  END IF;
  RETURN freehold._program_leg(p_institution, p_to, p_from, p_amount, p_key);
END $fn$;

CREATE FUNCTION freehold._program_bridge(p_institution uuid, p_entity uuid, p_currency text, p_kind text) RETURNS uuid
LANGUAGE plpgsql AS $fn$
DECLARE acct uuid;
BEGIN
  IF p_kind NOT IN ('SETTLEMENT_RECEIVABLE','SETTLEMENT_PAYABLE') THEN
    RAISE EXCEPTION 'PROGRAM_POLICY' USING ERRCODE = '22023';
  END IF;
  SELECT id INTO acct FROM freehold.institution_ledger_accounts
  WHERE institution_id = p_institution AND kind = p_kind AND currency_code = p_currency AND legal_entity_id = p_entity
  LIMIT 1;
  IF acct IS NOT NULL THEN RETURN acct; END IF;
  PERFORM set_config('freehold.institution_writer', 'on', true);
  INSERT INTO freehold.institution_ledger_accounts(
    institution_id, legal_entity_id, kind, currency_code, evidence_state, counts_as_external_asset)
  VALUES (p_institution, p_entity, p_kind, p_currency, 'EXTERNAL_UNAVAILABLE', false)
  RETURNING id INTO acct;
  RETURN acct;
END $fn$;

CREATE FUNCTION freehold._program_asset_move(
  p_asset uuid, p_kind text, p_key text, p_from uuid, p_to uuid, p_qty bigint
) RETURNS uuid LANGUAGE plpgsql AS $fn$
DECLARE
  existing uuid;
  asset freehold.program_assets;
  first_holder uuid;
  second_holder uuid;
  from_available bigint;
  from_held bigint;
  from_pledged bigint;
  journal uuid;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 OR p_key IS NULL THEN RAISE EXCEPTION 'PROGRAM_ASSET' USING ERRCODE = '22023'; END IF;
  SELECT id INTO existing FROM freehold.program_asset_journals WHERE asset_id = p_asset AND idempotency_key = p_key;
  IF existing IS NOT NULL THEN RETURN existing; END IF;
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
  INSERT INTO freehold.program_asset_journals(asset_id, idempotency_key, kind, quantity_minor, from_holder, to_holder)
  VALUES (p_asset, p_key, p_kind, p_qty, p_from, p_to)
  RETURNING id INTO journal;
  RETURN journal;
END $fn$;


CREATE FUNCTION freehold._program_not_before(p_definition jsonb) RETURNS timestamptz
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT min((value->>'notBefore')::timestamptz)
  FROM jsonb_array_elements(p_definition->'steps') AS step(value)
  WHERE value ? 'notBefore' AND COALESCE(value->>'notBefore', '') <> '';
$fn$;

CREATE FUNCTION freehold._program_pick_policy(p_institution uuid, p_domain text, p_exposure bigint, p_currency text) RETURNS uuid
LANGUAGE plpgsql AS $fn$
DECLARE pol freehold.program_policies;
BEGIN
  SELECT * INTO pol FROM freehold.program_policies
  WHERE institution_id = p_institution AND domain = p_domain AND status = 'APPROVED'
    AND effective_from <= clock_timestamp() AND effective_until > clock_timestamp()
    AND currency_code = p_currency AND max_exposure_minor >= GREATEST(p_exposure, 1)
  ORDER BY precedence ASC, version DESC
  LIMIT 1;
  IF NOT FOUND OR pol.snapshot_hash IS DISTINCT FROM freehold._program_hash(pol.body) THEN
    RAISE EXCEPTION 'PROGRAM_POLICY' USING ERRCODE = '22023';
  END IF;
  RETURN pol.id;
END $fn$;

CREATE FUNCTION freehold.program_policy_draft(
  p_actor uuid, p_institution uuid, p_domain text, p_body jsonb, p_precedence integer,
  p_max bigint, p_currency text, p_from timestamptz, p_until timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE pol uuid; ver integer;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'governance:write');
  PERFORM freehold._program_policy_ok(p_domain, p_body, p_max, p_currency);
  IF p_from IS NULL OR p_until IS NULL OR p_until <= p_from OR p_precedence < 0 THEN
    RAISE EXCEPTION 'PROGRAM_POLICY' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(max(version), 0) + 1 INTO ver FROM freehold.program_policies WHERE institution_id = p_institution AND domain = p_domain;
  PERFORM freehold._program_writer();
  INSERT INTO freehold.program_policies(
    institution_id, domain, version, status, body, precedence, max_exposure_minor, currency_code, effective_from, effective_until, created_by)
  VALUES (p_institution, p_domain, ver, 'DRAFT', p_body, p_precedence, p_max, p_currency, p_from, p_until, p_actor)
  RETURNING id INTO pol;
  PERFORM freehold._program_audit(p_institution, p_actor, 'POLICY_DRAFT', pol, jsonb_build_object('domain', p_domain, 'version', ver));
  RETURN jsonb_build_object('policyId', pol, 'status', 'DRAFT', 'version', ver, 'simulationOnly', true);
END $fn$;

CREATE FUNCTION freehold.program_policy_approve(p_actor uuid, p_policy uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE pol freehold.program_policies; digest text;
BEGIN
  PERFORM freehold._program_writer();
  SELECT * INTO pol FROM freehold.program_policies WHERE id = p_policy FOR UPDATE;
  IF NOT FOUND OR pol.status IS DISTINCT FROM 'DRAFT' THEN RAISE EXCEPTION 'PROGRAM_POLICY' USING ERRCODE = '22023'; END IF;
  IF p_actor = pol.created_by THEN RAISE EXCEPTION 'PROGRAM_SELF_APPROVAL' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, pol.institution_id, 'governance:write');
  IF EXISTS (
    SELECT 1 FROM freehold.program_policies
    WHERE institution_id = pol.institution_id AND domain = pol.domain AND status = 'APPROVED'
      AND precedence = pol.precedence AND effective_from <= clock_timestamp() AND effective_until > clock_timestamp()
  ) THEN RAISE EXCEPTION 'PROGRAM_POLICY' USING ERRCODE = '22023'; END IF;
  digest := freehold._program_hash(pol.body);
  UPDATE freehold.program_policies SET status = 'APPROVED', snapshot_hash = digest, approved_by = p_actor WHERE id = pol.id;
  PERFORM freehold._program_audit(pol.institution_id, p_actor, 'POLICY_APPROVE', pol.id, jsonb_build_object('snapshotHash', digest));
  RETURN jsonb_build_object('policyId', pol.id, 'status', 'APPROVED', 'snapshotHash', digest, 'rollbackByNewVersionOnly', true);
END $fn$;

CREATE FUNCTION freehold.program_policy_retire(p_actor uuid, p_policy uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE pol freehold.program_policies;
BEGIN
  PERFORM freehold._program_writer();
  SELECT * INTO pol FROM freehold.program_policies WHERE id = p_policy FOR UPDATE;
  IF NOT FOUND OR pol.status IS DISTINCT FROM 'APPROVED' THEN RAISE EXCEPTION 'PROGRAM_POLICY' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, pol.institution_id, 'governance:write');
  UPDATE freehold.program_policies SET status = 'RETIRED' WHERE id = pol.id;
  PERFORM freehold._program_audit(pol.institution_id, p_actor, 'POLICY_RETIRE', pol.id, jsonb_build_object('newVersionRequired', true));
  RETURN jsonb_build_object('policyId', pol.id, 'status', 'RETIRED', 'bodyUnchanged', true);
END $fn$;

CREATE FUNCTION freehold.program_workflow_draft(
  p_actor uuid, p_institution uuid, p_definition jsonb, p_max bigint, p_currency text,
  p_deadline timestamptz, p_key text, p_required integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE wf uuid; exposure bigint;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'payments:write');
  IF p_deadline IS NULL OR p_deadline <= clock_timestamp() OR p_required IS NULL THEN
    RAISE EXCEPTION 'PROGRAM_EXPIRED' USING ERRCODE = '22023';
  END IF;
  exposure := freehold._program_definition_ok(p_definition, p_max);
  PERFORM freehold._program_writer();
  INSERT INTO freehold.program_workflows(
    institution_id, created_by, status, definition, definition_hash, max_exposure_minor, currency_code,
    not_before, deadline, idempotency_key, required_approvals)
  VALUES (
    p_institution, p_actor, 'DRAFT', p_definition, freehold._program_hash(p_definition), p_max, p_currency,
    freehold._program_not_before(p_definition), p_deadline, p_key, p_required)
  RETURNING id INTO wf;
  PERFORM freehold._program_audit(p_institution, p_actor, 'WORKFLOW_DRAFT', wf, jsonb_build_object('exposureMinor', exposure::text));
  RETURN jsonb_build_object('workflowId', wf, 'status', 'DRAFT', 'exposureMinor', exposure::text, 'language', 'fh-workflow-1', 'executed', false);
END $fn$;

CREATE FUNCTION freehold.program_workflow_submit(p_actor uuid, p_workflow uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE wf freehold.program_workflows;
BEGIN
  PERFORM freehold._program_writer();
  SELECT * INTO wf FROM freehold.program_workflows WHERE id = p_workflow FOR UPDATE;
  IF NOT FOUND OR wf.status IS DISTINCT FROM 'DRAFT' THEN RAISE EXCEPTION 'PROGRAM_STATE' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, wf.institution_id, 'payments:write');
  IF p_actor IS DISTINCT FROM wf.created_by THEN RAISE EXCEPTION 'PROGRAM_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  PERFORM freehold._program_definition_ok(wf.definition, wf.max_exposure_minor);
  UPDATE freehold.program_workflows SET status = 'VALIDATING' WHERE id = wf.id;
  UPDATE freehold.program_workflows SET status = 'PENDING_APPROVAL' WHERE id = wf.id;
  PERFORM freehold._program_audit(wf.institution_id, p_actor, 'WORKFLOW_SUBMIT', wf.id, jsonb_build_object('passedThrough', 'VALIDATING'));
  RETURN jsonb_build_object('workflowId', wf.id, 'status', 'PENDING_APPROVAL', 'executed', false);
END $fn$;

CREATE FUNCTION freehold.program_workflow_approve(p_actor uuid, p_workflow uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE wf freehold.program_workflows; exposure bigint; pol uuid; digest text; domain text;
BEGIN
  PERFORM freehold._program_writer();
  SELECT * INTO wf FROM freehold.program_workflows WHERE id = p_workflow FOR UPDATE;
  IF NOT FOUND OR wf.status IS DISTINCT FROM 'PENDING_APPROVAL' THEN RAISE EXCEPTION 'PROGRAM_STATE' USING ERRCODE = '22023'; END IF;
  IF p_actor = wf.created_by THEN RAISE EXCEPTION 'PROGRAM_SELF_APPROVAL' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, wf.institution_id, 'governance:write');
  IF wf.deadline <= clock_timestamp() THEN RAISE EXCEPTION 'PROGRAM_EXPIRED' USING ERRCODE = '22023'; END IF;
  exposure := freehold._program_definition_ok(wf.definition, wf.max_exposure_minor);
  domain := COALESCE(wf.definition->>'domain', 'PAYMENT');
  pol := freehold._program_pick_policy(wf.institution_id, domain, exposure, wf.currency_code);
  SELECT snapshot_hash INTO digest FROM freehold.program_policies WHERE id = pol;
  INSERT INTO freehold.program_approvals(workflow_id, actor_id) VALUES (wf.id, p_actor)
  ON CONFLICT DO NOTHING;
  UPDATE freehold.program_workflows SET
    approval_count = (SELECT count(*) FROM freehold.program_approvals WHERE workflow_id = wf.id),
    policy_id = pol,
    policy_snapshot_hash = digest
  WHERE id = wf.id;
  UPDATE freehold.program_workflows SET status = 'APPROVED'
  WHERE id = wf.id AND approval_count >= required_approvals;
  PERFORM freehold._program_audit(wf.institution_id, p_actor, 'WORKFLOW_APPROVE', wf.id, jsonb_build_object('policyId', pol, 'snapshotHash', digest));
  RETURN jsonb_build_object('workflowId', wf.id, 'status', (SELECT status FROM freehold.program_workflows WHERE id = wf.id), 'policyId', pol, 'executed', false);
END $fn$;

CREATE FUNCTION freehold.program_workflow_cancel(p_actor uuid, p_workflow uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE wf freehold.program_workflows;
BEGIN
  PERFORM freehold._program_writer();
  SELECT * INTO wf FROM freehold.program_workflows WHERE id = p_workflow FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROGRAM_STATE' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, wf.institution_id, 'governance:write');
  IF wf.status NOT IN ('DRAFT','VALIDATING','PENDING_APPROVAL','APPROVED','SCHEDULED') THEN
    RAISE EXCEPTION 'PROGRAM_STATE' USING ERRCODE = '22023';
  END IF;
  UPDATE freehold.program_workflows SET status = 'CANCELLED' WHERE id = wf.id;
  RETURN jsonb_build_object('workflowId', wf.id, 'status', 'CANCELLED', 'executed', false);
END $fn$;

CREATE FUNCTION freehold.program_workflow_preview(p_actor uuid, p_workflow uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE wf freehold.program_workflows; exposure bigint; journals bigint; after_journals bigint;
BEGIN
  SELECT * INTO wf FROM freehold.program_workflows WHERE id = p_workflow;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROGRAM_STATE' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, wf.institution_id, 'payments:read');
  exposure := freehold._program_definition_ok(wf.definition, wf.max_exposure_minor);
  SELECT count(*) INTO journals FROM freehold.institution_journals;
  SELECT count(*) INTO after_journals FROM freehold.institution_journals;
  IF journals IS DISTINCT FROM after_journals THEN RAISE EXCEPTION 'PROGRAM_PREVIEW' USING ERRCODE = '55000'; END IF;
  RETURN jsonb_build_object(
    'workflowId', wf.id, 'preview', true, 'executed', false, 'status', wf.status,
    'exposureMinor', exposure::text, 'language', 'fh-workflow-1',
    'committedSandboxAccounting', false, 'legalEffect', false);
END $fn$;

CREATE FUNCTION freehold.program_workflow_get(p_actor uuid, p_workflow uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE wf freehold.program_workflows; execs jsonb;
BEGIN
  SELECT * INTO wf FROM freehold.program_workflows WHERE id = p_workflow;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROGRAM_STATE' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, wf.institution_id, 'accounts:read');
  SELECT COALESCE(jsonb_agg(jsonb_build_object('executionId', id, 'state', state, 'atomicity', atomicity, 'idempotencyKey', idempotency_key) ORDER BY started_at), '[]'::jsonb)
  INTO execs FROM freehold.program_executions WHERE workflow_id = wf.id;
  RETURN jsonb_build_object(
    'workflowId', wf.id, 'status', wf.status, 'definitionHash', wf.definition_hash,
    'policySnapshotHash', wf.policy_snapshot_hash, 'maxExposureMinor', wf.max_exposure_minor::text,
    'deadline', wf.deadline, 'executed', wf.status = 'COMPLETED', 'executions', execs, 'simulationOnly', true);
END $fn$;

CREATE FUNCTION freehold._program_escrow_finish(p_escrow uuid, p_mode text, p_to uuid, p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql AS $fn$
DECLARE
  row freehold.program_escrows;
  src freehold.institution_ledger_accounts;
  dest freehold.institution_ledger_accounts;
  payer_journal uuid;
  receive_journal uuid;
  payer_bridge uuid;
  beneficiary_bridge uuid;
BEGIN
  PERFORM freehold._program_open( (SELECT institution_id FROM freehold.program_escrows WHERE id = p_escrow) );
  PERFORM freehold._program_writer();
  SELECT * INTO row FROM freehold.program_escrows WHERE id = p_escrow FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROGRAM_ESCROW' USING ERRCODE = '22023'; END IF;
  IF row.status = 'DISPUTED' THEN RAISE EXCEPTION 'PROGRAM_ESCROW' USING ERRCODE = '55000'; END IF;
  IF row.status <> 'FUNDED' THEN RAISE EXCEPTION 'PROGRAM_ESCROW' USING ERRCODE = '55000'; END IF;
  IF row.expires_at <= clock_timestamp() THEN
    UPDATE freehold.program_escrows SET status = 'EXPIRED' WHERE id = row.id;
    RETURN jsonb_build_object('escrowId', row.id, 'status', 'EXPIRED', 'released', false, 'journalId', NULL);
  END IF;
  IF row.conditions->>'release' = 'TIME' AND (row.conditions->>'notBefore')::timestamptz > clock_timestamp() THEN
    RAISE EXCEPTION 'PROGRAM_CONDITION' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO src FROM freehold.institution_ledger_accounts WHERE id = row.source_account_id;
  IF p_mode = 'RETURN' THEN
    dest := src;
  ELSE
    SELECT * INTO dest FROM freehold.institution_ledger_accounts WHERE id = p_to;
    IF dest.id IS NULL THEN RAISE EXCEPTION 'PROGRAM_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  END IF;
  IF dest.institution_id = row.institution_id THEN
    payer_journal := freehold._program_leg(row.institution_id, dest.id, row.suspense_account_id, row.reserved_minor, 'escrow-' || lower(p_mode) || ':' || row.id::text);
  ELSE
    IF dest.institution_id IS DISTINCT FROM row.beneficiary_institution_id OR dest.currency_code IS DISTINCT FROM src.currency_code THEN
      RAISE EXCEPTION 'PROGRAM_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    PERFORM freehold._program_open(dest.institution_id);
    payer_bridge := freehold._program_bridge(row.institution_id, src.legal_entity_id, src.currency_code, 'SETTLEMENT_RECEIVABLE');
    beneficiary_bridge := freehold._program_bridge(dest.institution_id, dest.legal_entity_id, dest.currency_code, 'SETTLEMENT_PAYABLE');
    payer_journal := freehold._program_leg(row.institution_id, payer_bridge, row.suspense_account_id, row.reserved_minor, 'escrow-' || lower(p_mode) || ':' || row.id::text);
    receive_journal := freehold._program_leg(dest.institution_id, dest.id, beneficiary_bridge, row.reserved_minor, 'escrow-receive:' || row.id::text);
  END IF;
  UPDATE freehold.program_escrows SET
    status = CASE WHEN p_mode = 'RETURN' THEN 'RETURNED' ELSE 'RELEASED' END,
    released_minor = reserved_minor,
    release_journal_id = payer_journal,
    released_by = p_actor
  WHERE id = row.id;
  RETURN jsonb_build_object('escrowId', row.id, 'released', true, 'journalId', payer_journal, 'receiveJournalId', receive_journal, 'legalEscrow', false);
END $fn$;

CREATE FUNCTION freehold.program_escrow_fund(
  p_actor uuid, p_institution uuid, p_source uuid, p_amount bigint, p_beneficiary uuid, p_ref text,
  p_conditions jsonb, p_expires timestamptz, p_key text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE
  src freehold.institution_ledger_accounts;
  suspense uuid;
  journal uuid;
  escrow uuid;
  existing uuid;
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
  SELECT id INTO existing FROM freehold.program_escrows WHERE institution_id = p_institution AND idempotency_key = p_key;
  IF existing IS NOT NULL THEN
    RETURN jsonb_build_object('escrowId', existing, 'duplicate', true, 'legalEscrow', false);
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
    conditions, reserved_minor, status, expires_at, fund_journal_id, funded_by, idempotency_key)
  VALUES (p_institution, p_source, suspense, p_beneficiary, p_ref, p_conditions, p_amount, 'FUNDED', p_expires, journal, p_actor, p_key)
  RETURNING id INTO escrow;
  PERFORM freehold._program_audit(p_institution, p_actor, 'ESCROW_FUND', escrow, jsonb_build_object('legalEscrow', false, 'amountMinor', p_amount::text));
  RETURN jsonb_build_object('escrowId', escrow, 'status', 'FUNDED', 'journalId', journal, 'duplicate', false, 'legalEscrow', false, 'fiduciaryCustody', false);
END $fn$;

CREATE FUNCTION freehold.program_escrow_release(p_actor uuid, p_escrow uuid, p_to uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE row freehold.program_escrows;
BEGIN
  SELECT * INTO row FROM freehold.program_escrows WHERE id = p_escrow;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROGRAM_ESCROW' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, row.institution_id, 'governance:write');
  IF p_actor = row.funded_by THEN RAISE EXCEPTION 'PROGRAM_SELF_APPROVAL' USING ERRCODE = '22023'; END IF;
  RETURN freehold._program_escrow_finish(p_escrow, 'RELEASE', p_to, p_actor);
END $fn$;

CREATE FUNCTION freehold.program_escrow_return(p_actor uuid, p_escrow uuid, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE row freehold.program_escrows;
BEGIN
  SELECT * INTO row FROM freehold.program_escrows WHERE id = p_escrow;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROGRAM_ESCROW' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, row.institution_id, 'governance:write');
  IF p_actor = row.funded_by THEN RAISE EXCEPTION 'PROGRAM_SELF_APPROVAL' USING ERRCODE = '22023'; END IF;
  RETURN freehold._program_escrow_finish(p_escrow, 'RETURN', NULL, p_actor) || jsonb_build_object('idempotencyKey', p_key);
END $fn$;

CREATE FUNCTION freehold.program_escrow_dispute(p_actor uuid, p_escrow uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE row freehold.program_escrows;
BEGIN
  PERFORM freehold._program_writer();
  SELECT * INTO row FROM freehold.program_escrows WHERE id = p_escrow FOR UPDATE;
  IF NOT FOUND OR row.status IS DISTINCT FROM 'FUNDED' THEN RAISE EXCEPTION 'PROGRAM_ESCROW' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, row.institution_id, 'governance:write');
  IF p_actor = row.funded_by THEN RAISE EXCEPTION 'PROGRAM_SELF_APPROVAL' USING ERRCODE = '22023'; END IF;
  UPDATE freehold.program_escrows SET status = 'DISPUTED' WHERE id = row.id;
  RETURN jsonb_build_object('escrowId', row.id, 'status', 'DISPUTED', 'released', false);
END $fn$;

CREATE FUNCTION freehold.program_fusd_request(
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
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'governance:write');
  PERFORM freehold._program_open(p_institution);
  IF p_amount IS NULL OR p_amount <= 0 OR p_key IS NULL THEN RAISE EXCEPTION 'PROGRAM_LIMIT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO existing FROM freehold.program_issuance_requests WHERE book_id = p_book AND idempotency_key = p_key;
  IF FOUND THEN
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
    institution_id, book_id, amount_minor, status, idempotency_key, changes_supply, not_before, created_by)
  VALUES (p_institution, p_book, p_amount, status_text, p_key, false, p_not_before, p_actor)
  RETURNING id INTO row_id;
  SELECT outstanding INTO after_outstanding FROM freehold.monetary_supply WHERE book_id = p_book;
  IF before_outstanding IS DISTINCT FROM after_outstanding THEN RAISE EXCEPTION 'PROGRAM_POLICY' USING ERRCODE = '55000'; END IF;
  PERFORM freehold._program_audit(p_institution, p_actor, 'FUSD_REQUEST', row_id, jsonb_build_object('status', status_text, 'supplyChanged', false, 'externalReserve', 'EXTERNAL_EVIDENCE_UNAVAILABLE'));
  RETURN jsonb_build_object('requestId', row_id, 'status', status_text, 'duplicate', false, 'supplyChanged', false, 'liveIssuance', false, 'changesOutstanding', false);
END $fn$;

CREATE FUNCTION freehold._program_execute(p_workflow uuid, p_key text) RETURNS jsonb
LANGUAGE plpgsql AS $fn$
DECLARE
  wf freehold.program_workflows;
  existing freehold.program_executions;
  exec_id uuid;
  step jsonb;
  ordinal integer := 0;
  exposure bigint;
  journal uuid;
  escrow uuid;
  pol freehold.program_policies;
  digest text;
  step_not timestamptz;
  release_to uuid;
  approver uuid;
  outcome text;
  prior record;
  lines jsonb;
  prior_exec freehold.program_executions;
BEGIN
  PERFORM freehold._program_writer();
  SELECT * INTO wf FROM freehold.program_workflows WHERE id = p_workflow FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROGRAM_STATE' USING ERRCODE = '22023'; END IF;
  SELECT * INTO existing FROM freehold.program_executions
  WHERE institution_id = wf.institution_id AND idempotency_key = p_key FOR UPDATE;
  IF existing.id IS NOT NULL THEN
    IF existing.state = 'COMPLETED' THEN
      RETURN jsonb_build_object('workflowId', wf.id, 'executionId', existing.id, 'duplicate', true, 'state', 'COMPLETED', 'executed', true);
    ELSIF existing.state = 'UNKNOWN' THEN
      RAISE EXCEPTION 'PROGRAM_UNKNOWN_BLOCKED' USING ERRCODE = '55000';
    ELSIF existing.state = 'EXPIRED' THEN
      RETURN jsonb_build_object('workflowId', wf.id, 'executionId', existing.id, 'duplicate', true, 'state', 'EXPIRED', 'executed', false);
    ELSIF existing.state = 'SCHEDULED' AND (wf.not_before IS NULL OR wf.not_before <= clock_timestamp()) AND wf.deadline > clock_timestamp() THEN
      exec_id := existing.id;
      UPDATE freehold.program_executions SET state = 'EXECUTING' WHERE id = exec_id;
    ELSIF existing.state = 'SCHEDULED' THEN
      RETURN jsonb_build_object('workflowId', wf.id, 'executionId', existing.id, 'duplicate', true, 'state', 'SCHEDULED', 'executed', false);
    ELSE
      RAISE EXCEPTION 'PROGRAM_STATE' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF wf.status = 'UNKNOWN' OR EXISTS (SELECT 1 FROM freehold.program_executions WHERE workflow_id = wf.id AND state = 'UNKNOWN') THEN
    RAISE EXCEPTION 'PROGRAM_UNKNOWN_BLOCKED' USING ERRCODE = '55000';
  END IF;
  IF wf.deadline <= clock_timestamp() AND wf.status IN ('APPROVED','SCHEDULED') THEN
    UPDATE freehold.program_workflows SET status = 'EXPIRED' WHERE id = wf.id;
    IF exec_id IS NULL THEN
      INSERT INTO freehold.program_executions(workflow_id, institution_id, idempotency_key, state, atomicity, finished_at)
      VALUES (wf.id, wf.institution_id, p_key, 'EXPIRED', 'NONE', clock_timestamp()) RETURNING id INTO exec_id;
    ELSE
      UPDATE freehold.program_executions SET state = 'EXPIRED', finished_at = clock_timestamp() WHERE id = exec_id;
    END IF;
    RETURN jsonb_build_object('workflowId', wf.id, 'executionId', exec_id, 'state', 'EXPIRED', 'executed', false);
  END IF;
  IF wf.not_before IS NOT NULL AND wf.not_before > clock_timestamp() AND wf.status IN ('APPROVED','SCHEDULED') THEN
    UPDATE freehold.program_workflows SET status = 'SCHEDULED' WHERE id = wf.id;
    IF exec_id IS NULL THEN
      INSERT INTO freehold.program_executions(workflow_id, institution_id, idempotency_key, state, atomicity)
      VALUES (wf.id, wf.institution_id, p_key, 'SCHEDULED',
        CASE WHEN wf.definition->'steps'->0->>'op' = 'COORDINATED_EXTERNAL' THEN 'COORDINATED_NOT_ATOMIC' ELSE 'SINGLE_DATABASE' END)
      RETURNING id INTO exec_id;
    END IF;
    RETURN jsonb_build_object('workflowId', wf.id, 'executionId', exec_id, 'state', 'SCHEDULED', 'executed', false);
  END IF;
  IF wf.status NOT IN ('APPROVED','SCHEDULED') THEN RAISE EXCEPTION 'PROGRAM_STATE' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._program_open(wf.institution_id);
  exposure := freehold._program_definition_ok(wf.definition, wf.max_exposure_minor);
  SELECT * INTO pol FROM freehold.program_policies WHERE id = wf.policy_id;
  digest := freehold._program_hash(pol.body);
  IF pol.status NOT IN ('APPROVED','RETIRED') OR pol.snapshot_hash IS DISTINCT FROM wf.policy_snapshot_hash OR digest IS DISTINCT FROM wf.policy_snapshot_hash THEN
    RAISE EXCEPTION 'PROGRAM_POLICY' USING ERRCODE = '22023';
  END IF;
  IF exposure > pol.max_exposure_minor THEN RAISE EXCEPTION 'PROGRAM_LIMIT' USING ERRCODE = '22023'; END IF;
  SELECT actor_id INTO approver FROM freehold.program_approvals WHERE workflow_id = wf.id AND actor_id <> wf.created_by LIMIT 1;
  IF approver IS NULL THEN RAISE EXCEPTION 'PROGRAM_SELF_APPROVAL' USING ERRCODE = '22023'; END IF;
  IF wf.definition->'steps'->0->>'op' = 'COORDINATED_EXTERNAL' THEN
    UPDATE freehold.program_workflows SET status = 'UNKNOWN' WHERE id = wf.id;
    IF exec_id IS NULL THEN
      INSERT INTO freehold.program_executions(workflow_id, institution_id, idempotency_key, state, atomicity, finished_at)
      VALUES (wf.id, wf.institution_id, p_key, 'UNKNOWN', 'COORDINATED_NOT_ATOMIC', clock_timestamp()) RETURNING id INTO exec_id;
    ELSE
      UPDATE freehold.program_executions SET state = 'UNKNOWN', finished_at = clock_timestamp() WHERE id = exec_id;
    END IF;
    INSERT INTO freehold.program_legs(execution_id, ordinal, kind, state, amount_minor, currency_code, institution_id, coordination)
    VALUES (exec_id, 0, 'COORDINATED_EXTERNAL', 'AWAITING_EXTERNAL', (wf.definition->'steps'->0->>'amountMinor')::bigint, wf.currency_code, wf.institution_id, 'AWAITING_EXTERNAL');
    PERFORM freehold._program_audit(wf.institution_id, NULL, 'WORKFLOW_UNKNOWN', exec_id, jsonb_build_object('distributedAtomicity', false));
    RETURN jsonb_build_object('workflowId', wf.id, 'executionId', exec_id, 'state', 'UNKNOWN', 'distributedAtomicity', false, 'executed', false);
  END IF;
  IF exec_id IS NULL THEN
    INSERT INTO freehold.program_executions(workflow_id, institution_id, idempotency_key, state, atomicity)
    VALUES (wf.id, wf.institution_id, p_key, 'EXECUTING', 'SINGLE_DATABASE') RETURNING id INTO exec_id;
  END IF;
  UPDATE freehold.program_workflows SET status = 'EXECUTING' WHERE id = wf.id;
  IF wf.definition->'steps'->0->>'op' = 'FUSD_ISSUE_REQUEST' THEN
    outcome := (freehold.program_fusd_request(
      wf.created_by, wf.institution_id, (wf.definition->'steps'->0->>'bookId')::uuid,
      (wf.definition->'steps'->0->>'amountMinor')::bigint, 'wf:' || wf.id::text, NULL)->>'status');
    INSERT INTO freehold.program_legs(execution_id, ordinal, kind, state, amount_minor, currency_code, institution_id, coordination)
    VALUES (exec_id, 0, 'FUSD_ISSUE_REQUEST', CASE WHEN outcome = 'REQUESTED' THEN 'RECONCILED' ELSE 'FAILED' END,
      (wf.definition->'steps'->0->>'amountMinor')::bigint, 'USD', wf.institution_id, 'NOT_ATOMIC');
    UPDATE freehold.program_executions SET state = CASE WHEN outcome = 'REQUESTED' THEN 'COMPLETED' ELSE 'FAILED' END, finished_at = clock_timestamp() WHERE id = exec_id;
    UPDATE freehold.program_workflows SET status = CASE WHEN outcome = 'REQUESTED' THEN 'COMPLETED' ELSE 'FAILED' END WHERE id = wf.id;
    PERFORM freehold._program_audit(wf.institution_id, approver, 'WORKFLOW_EXECUTE', exec_id, jsonb_build_object('atomicity', 'NOT_ATOMIC', 'supplyChanged', false, 'fusdStatus', outcome));
    RETURN jsonb_build_object('workflowId', wf.id, 'executionId', exec_id, 'state', CASE WHEN outcome = 'REQUESTED' THEN 'COMPLETED' ELSE 'FAILED' END, 'supplyChanged', false, 'fusdStatus', outcome);
  END IF;
  FOR step IN SELECT value FROM jsonb_array_elements(wf.definition->'steps') LOOP
    IF step ? 'notBefore' THEN step_not := (step->>'notBefore')::timestamptz; ELSE step_not := NULL; END IF;
    IF step_not IS NOT NULL AND step_not > clock_timestamp() THEN
      RAISE EXCEPTION 'PROGRAM_STATE' USING ERRCODE = '22023';
    END IF;
    IF step->>'op' = 'TRANSFER' THEN
      journal := freehold._program_move(wf.institution_id, (step->>'fromAccount')::uuid, (step->>'toAccount')::uuid, (step->>'amountMinor')::bigint, 'p14:' || exec_id::text || ':' || ordinal::text);
      INSERT INTO freehold.program_legs(execution_id, ordinal, kind, state, amount_minor, currency_code, institution_id, journal_id, coordination)
      VALUES (exec_id, ordinal, 'TRANSFER', 'POSTED', (step->>'amountMinor')::bigint, wf.currency_code, wf.institution_id, journal, 'SINGLE_DATABASE');
    ELSIF step->>'op' = 'HOLD' THEN
      journal := (freehold.program_escrow_fund(
        wf.created_by, wf.institution_id, (step->>'fromAccount')::uuid, (step->>'amountMinor')::bigint,
        COALESCE((step->>'beneficiaryInstitutionId')::uuid, wf.institution_id), step->>'ref',
        jsonb_build_object('language','fh-workflow-1','release','AUTHORIZED'), wf.deadline,
        'hold:' || wf.id::text || ':' || (step->>'ref'))->>'journalId')::uuid;
      SELECT id INTO escrow FROM freehold.program_escrows WHERE institution_id = wf.institution_id AND idempotency_key = 'hold:' || wf.id::text || ':' || (step->>'ref');
      UPDATE freehold.program_escrows SET workflow_id = wf.id WHERE id = escrow;
      INSERT INTO freehold.program_legs(execution_id, ordinal, kind, state, amount_minor, currency_code, institution_id, journal_id, coordination)
      VALUES (exec_id, ordinal, 'HOLD', 'POSTED', (step->>'amountMinor')::bigint, wf.currency_code, wf.institution_id, journal, 'SINGLE_DATABASE');
    ELSIF step->>'op' = 'RELEASE' THEN
      SELECT id INTO escrow FROM freehold.program_escrows WHERE workflow_id = wf.id AND beneficiary_ref = step->>'ref' AND status = 'FUNDED';
      release_to := (step->>'toAccount')::uuid;
      PERFORM freehold._program_escrow_finish(escrow, 'RELEASE', release_to, approver);
      SELECT release_journal_id INTO journal FROM freehold.program_escrows WHERE id = escrow;
      IF journal IS NULL THEN RAISE EXCEPTION 'PROGRAM_EXPIRED' USING ERRCODE = '22023'; END IF;
      INSERT INTO freehold.program_legs(execution_id, ordinal, kind, state, amount_minor, currency_code, institution_id, journal_id, coordination)
      VALUES (exec_id, ordinal, 'RELEASE', 'POSTED', 0, wf.currency_code, wf.institution_id, journal, 'SINGLE_DATABASE');
    ELSIF step->>'op' = 'RETURN' THEN
      SELECT id INTO escrow FROM freehold.program_escrows WHERE workflow_id = wf.id AND beneficiary_ref = step->>'ref' AND status = 'FUNDED';
      PERFORM freehold._program_escrow_finish(escrow, 'RETURN', NULL, approver);
      SELECT release_journal_id INTO journal FROM freehold.program_escrows WHERE id = escrow;
      IF journal IS NULL THEN RAISE EXCEPTION 'PROGRAM_EXPIRED' USING ERRCODE = '22023'; END IF;
      INSERT INTO freehold.program_legs(execution_id, ordinal, kind, state, amount_minor, currency_code, institution_id, journal_id, coordination)
      VALUES (exec_id, ordinal, 'RETURN', 'POSTED', 0, wf.currency_code, wf.institution_id, journal, 'SINGLE_DATABASE');
    ELSIF step->>'op' = 'RECONCILE' THEN
      IF EXISTS (
        WITH signed AS (
          SELECT e.account_id, CASE
            WHEN a.kind IN ('TREASURY','OPERATING','RESERVE','SETTLEMENT_RECEIVABLE') AND e.side='DEBIT' THEN e.amount_minor
            WHEN a.kind IN ('TREASURY','OPERATING','RESERVE','SETTLEMENT_RECEIVABLE') AND e.side='CREDIT' THEN -e.amount_minor
            WHEN a.kind IN ('CUSTOMER','CLEARING','SETTLEMENT_PAYABLE','SUSPENSE') AND e.side='CREDIT' THEN e.amount_minor
            WHEN a.kind IN ('CUSTOMER','CLEARING','SETTLEMENT_PAYABLE','SUSPENSE') AND e.side='DEBIT' THEN -e.amount_minor
          END AS signed_minor
          FROM freehold.institution_entries e JOIN freehold.institution_ledger_accounts a ON a.id = e.account_id
          WHERE a.institution_id = wf.institution_id)
        SELECT 1 FROM freehold.institution_ledger_accounts a
        LEFT JOIN (SELECT account_id, sum(signed_minor) AS total FROM signed GROUP BY account_id) s ON s.account_id = a.id
        WHERE a.institution_id = wf.institution_id AND a.balance_minor IS DISTINCT FROM COALESCE(s.total, 0)
      ) THEN RAISE EXCEPTION 'PROGRAM_RECONCILE' USING ERRCODE = '55000'; END IF;
      INSERT INTO freehold.program_legs(execution_id, ordinal, kind, state, amount_minor, currency_code, institution_id, coordination)
      VALUES (exec_id, ordinal, 'RECONCILE', 'RECONCILED', 0, wf.currency_code, wf.institution_id, 'NOT_ATOMIC');
    ELSIF step->>'op' = 'REVERSAL' THEN
      SELECT * INTO prior_exec FROM freehold.program_executions WHERE id = (step->>'executionId')::uuid;
      IF prior_exec.id IS NULL OR prior_exec.state IS DISTINCT FROM 'COMPLETED' OR prior_exec.institution_id IS DISTINCT FROM wf.institution_id THEN
        RAISE EXCEPTION 'PROGRAM_STATE' USING ERRCODE = '22023';
      END IF;
      FOR prior IN
        SELECT l.journal_id, l.amount_minor, j.legal_entity_id, j.currency_code
        FROM freehold.program_legs l JOIN freehold.institution_journals j ON j.id = l.journal_id
        WHERE l.execution_id = prior_exec.id AND l.journal_id IS NOT NULL
      LOOP
        SELECT jsonb_agg(jsonb_build_object(
          'account', e.account_id, 'side', CASE WHEN e.side = 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END, 'amount', e.amount_minor::text)
          ORDER BY e.account_id) INTO lines
        FROM freehold.institution_entries e WHERE e.journal_id = prior.journal_id;
        journal := freehold._institution_post(
          wf.institution_id, prior.legal_entity_id, prior.currency_code, 'PROGRAM_REVERSAL',
          'p14rev:' || exec_id::text || ':' || prior.journal_id::text, gen_random_uuid(),
          'SIMULATED_REVERSAL_NOT_DELETION', lines);
        INSERT INTO freehold.program_legs(execution_id, ordinal, kind, state, amount_minor, currency_code, institution_id, journal_id, coordination)
        VALUES (exec_id, ordinal, 'REVERSAL', 'POSTED', prior.amount_minor, wf.currency_code, wf.institution_id, journal, 'SINGLE_DATABASE');
        EXIT;
      END LOOP;
    ELSE
      RAISE EXCEPTION 'PROGRAM_LANGUAGE' USING ERRCODE = '22023';
    END IF;
    ordinal := ordinal + 1;
  END LOOP;
  UPDATE freehold.program_executions SET state = 'COMPLETED', finished_at = clock_timestamp() WHERE id = exec_id;
  UPDATE freehold.program_workflows SET status = 'COMPLETED' WHERE id = wf.id;
  PERFORM freehold._program_audit(wf.institution_id, approver, 'WORKFLOW_EXECUTE', exec_id, jsonb_build_object('atomicity', 'SINGLE_DATABASE', 'exposureMinor', exposure::text));
  RETURN jsonb_build_object('workflowId', wf.id, 'executionId', exec_id, 'state', 'COMPLETED', 'duplicate', false, 'atomicity', 'SINGLE_DATABASE', 'executed', true);
END $fn$;

CREATE FUNCTION freehold.program_workflow_execute(p_actor uuid, p_workflow uuid, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE inst uuid;
BEGIN
  SELECT institution_id INTO inst FROM freehold.program_workflows WHERE id = p_workflow;
  IF inst IS NULL THEN RAISE EXCEPTION 'PROGRAM_STATE' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, inst, 'payments:write');
  RETURN freehold._program_execute(p_workflow, p_key);
END $fn$;

CREATE FUNCTION freehold.program_workflow_run_due(p_worker uuid, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE rec record; ran integer := 0; failed integer := 0;
BEGIN
  IF p_worker IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 20 THEN
    RAISE EXCEPTION 'PROGRAM_LIMIT' USING ERRCODE = '22023';
  END IF;
  FOR rec IN
    SELECT id FROM freehold.program_workflows
    WHERE status IN ('APPROVED','SCHEDULED')
      AND (not_before IS NULL OR not_before <= clock_timestamp())
      AND deadline > clock_timestamp()
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  LOOP
    BEGIN
      PERFORM freehold._program_execute(rec.id, 'due:' || rec.id::text);
      ran := ran + 1;
    EXCEPTION WHEN OTHERS THEN
      failed := failed + 1;
      IF SQLERRM = 'PROGRAM_UNKNOWN_BLOCKED' THEN
        UPDATE freehold.program_workflows SET status = 'UNKNOWN' WHERE id = rec.id AND status IN ('APPROVED','SCHEDULED','EXECUTING');
      ELSE
        UPDATE freehold.program_workflows SET status = 'FAILED' WHERE id = rec.id AND status IN ('APPROVED','SCHEDULED','EXECUTING');
      END IF;
    END;
  END LOOP;
  RETURN jsonb_build_object('ran', ran, 'failed', failed, 'workerPosts', false, 'databaseFunctionMayPost', true);
END $fn$;

CREATE FUNCTION freehold.program_settle_atomic(
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
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'payments:write');
  PERFORM freehold._program_open(p_institution);
  IF p_legs IS NULL OR jsonb_typeof(p_legs) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'PROGRAM_LANGUAGE' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._program_forbidden(p_legs);
  n := jsonb_array_length(p_legs);
  IF n < 1 OR n > 16 THEN RAISE EXCEPTION 'PROGRAM_LIMIT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO existing FROM freehold.program_executions WHERE institution_id = p_institution AND idempotency_key = p_key FOR UPDATE;
  IF existing.id IS NOT NULL THEN
    IF existing.state = 'UNKNOWN' THEN RAISE EXCEPTION 'PROGRAM_UNKNOWN_BLOCKED' USING ERRCODE = '55000'; END IF;
    RETURN jsonb_build_object('executionId', existing.id, 'duplicate', true, 'state', existing.state, 'atomicity', existing.atomicity);
  END IF;
  IF p_deadline IS NOT NULL AND p_deadline <= clock_timestamp() THEN
    PERFORM freehold._program_writer();
    INSERT INTO freehold.program_executions(institution_id, idempotency_key, state, atomicity, finished_at)
    VALUES (p_institution, p_key, 'EXPIRED', 'NONE', clock_timestamp()) RETURNING id INTO exec_id;
    RETURN jsonb_build_object('executionId', exec_id, 'state', 'EXPIRED', 'executed', false, 'posted', false);
  END IF;
  FOR leg IN SELECT value FROM jsonb_array_elements(p_legs) LOOP
    IF leg ? 'coordination' OR leg ? 'sql' THEN RAISE EXCEPTION 'PROGRAM_NOT_ATOMIC' USING ERRCODE = '22023'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(leg) AS key_name WHERE key_name NOT IN ('institutionId','debitAccount','creditAccount','amountMinor')) THEN
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
      SELECT (value->>'creditAccount')::uuid FROM jsonb_array_elements(p_legs)
    ) ids WHERE account_id IS NOT NULL ORDER BY account_id
  LOOP
    PERFORM 1 FROM freehold.institution_ledger_accounts WHERE id = acct FOR UPDATE;
  END LOOP;
  PERFORM freehold._program_writer();
  INSERT INTO freehold.program_executions(institution_id, idempotency_key, state, atomicity)
  VALUES (p_institution, p_key, 'EXECUTING', 'SINGLE_DATABASE') RETURNING id INTO exec_id;
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

CREATE FUNCTION freehold.program_settle_coordinate(p_actor uuid, p_institution uuid, p_key text, p_legs jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE existing freehold.program_executions; exec_id uuid; leg jsonb; ordinal integer := 0;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'payments:write');
  PERFORM freehold._program_forbidden(p_legs);
  SELECT * INTO existing FROM freehold.program_executions WHERE institution_id = p_institution AND idempotency_key = p_key;
  IF existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('executionId', existing.id, 'duplicate', true, 'state', existing.state, 'distributedAtomicity', false, 'posted', false);
  END IF;
  PERFORM freehold._program_writer();
  INSERT INTO freehold.program_executions(institution_id, idempotency_key, state, atomicity, finished_at)
  VALUES (p_institution, p_key, 'UNKNOWN', 'COORDINATED_NOT_ATOMIC', clock_timestamp()) RETURNING id INTO exec_id;
  FOR leg IN SELECT value FROM jsonb_array_elements(p_legs) LOOP
    INSERT INTO freehold.program_legs(execution_id, ordinal, kind, state, amount_minor, currency_code, institution_id, coordination)
    VALUES (exec_id, ordinal, 'COORDINATED_EXTERNAL', 'AWAITING_EXTERNAL', COALESCE((leg->>'amountMinor')::bigint, 0), 'USD', p_institution, 'AWAITING_EXTERNAL');
    ordinal := ordinal + 1;
  END LOOP;
  PERFORM freehold._program_audit(p_institution, p_actor, 'SETTLE_COORDINATE', exec_id, jsonb_build_object('distributedAtomicity', false, 'posted', false));
  RETURN jsonb_build_object('executionId', exec_id, 'state', 'UNKNOWN', 'distributedAtomicity', false, 'posted', false, 'externalFinality', 'EXTERNAL_EVIDENCE_UNAVAILABLE');
END $fn$;

CREATE FUNCTION freehold.program_execution_unknown(p_actor uuid, p_workflow uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE wf freehold.program_workflows; exec_id uuid;
BEGIN
  PERFORM freehold._program_writer();
  SELECT * INTO wf FROM freehold.program_workflows WHERE id = p_workflow FOR UPDATE;
  IF NOT FOUND OR wf.status NOT IN ('APPROVED','SCHEDULED') THEN RAISE EXCEPTION 'PROGRAM_STATE' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, wf.institution_id, 'governance:write');
  UPDATE freehold.program_workflows SET status = 'UNKNOWN' WHERE id = wf.id;
  INSERT INTO freehold.program_executions(workflow_id, institution_id, idempotency_key, state, atomicity, finished_at)
  VALUES (wf.id, wf.institution_id, 'unknown:' || wf.id::text, 'UNKNOWN', 'NONE', clock_timestamp())
  ON CONFLICT (institution_id, idempotency_key) DO UPDATE SET state = freehold.program_executions.state
  RETURNING id INTO exec_id;
  RETURN jsonb_build_object('workflowId', wf.id, 'executionId', exec_id, 'state', 'UNKNOWN', 'posted', false);
END $fn$;

CREATE FUNCTION freehold.program_treasury_recommend(
  p_actor uuid, p_institution uuid, p_movement text, p_amount bigint, p_currency text, p_from text, p_to text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE row_id uuid; journals bigint; after_journals bigint;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'treasury:read');
  IF p_movement NOT IN ('SWEEP','FUNDING','RESERVE_ALLOCATION','SCHEDULED','QUEUE_PRIORITY','CONCENTRATION_ALERT','REDEMPTION_FORECAST','CASHFLOW_PROJECTION') THEN
    RAISE EXCEPTION 'PROGRAM_TREASURY' USING ERRCODE = '22023';
  END IF;
  IF p_amount < 0 THEN RAISE EXCEPTION 'PROGRAM_LIMIT' USING ERRCODE = '22023'; END IF;
  SELECT count(*) INTO journals FROM freehold.institution_journals;
  PERFORM freehold._program_writer();
  INSERT INTO freehold.program_treasury(
    institution_id, kind, movement, amount_minor, currency_code, from_kind, to_kind, status, created_by)
  VALUES (p_institution, 'RECOMMENDATION', p_movement, p_amount, p_currency, p_from, p_to, 'PROPOSED', p_actor)
  RETURNING id INTO row_id;
  SELECT count(*) INTO after_journals FROM freehold.institution_journals;
  IF journals IS DISTINCT FROM after_journals THEN RAISE EXCEPTION 'PROGRAM_TREASURY' USING ERRCODE = '55000'; END IF;
  PERFORM freehold._program_audit(p_institution, p_actor, 'TREASURY_RECOMMEND', row_id, jsonb_build_object('executed', false));
  RETURN jsonb_build_object('treasuryId', row_id, 'kind', 'RECOMMENDATION', 'executed', false, 'journalId', NULL);
END $fn$;

CREATE FUNCTION freehold.program_treasury_approve(p_actor uuid, p_treasury uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE row freehold.program_treasury; pol uuid;
BEGIN
  PERFORM freehold._program_writer();
  SELECT * INTO row FROM freehold.program_treasury WHERE id = p_treasury FOR UPDATE;
  IF NOT FOUND OR row.kind IS DISTINCT FROM 'RECOMMENDATION' OR row.status IS DISTINCT FROM 'PROPOSED' THEN
    RAISE EXCEPTION 'PROGRAM_TREASURY' USING ERRCODE = '22023';
  END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, row.institution_id, 'governance:write');
  IF p_actor = row.created_by THEN RAISE EXCEPTION 'PROGRAM_SELF_APPROVAL' USING ERRCODE = '22023'; END IF;
  pol := freehold._program_pick_policy(row.institution_id, 'TREASURY', GREATEST(row.amount_minor, 1), row.currency_code);
  UPDATE freehold.program_treasury SET status = 'APPROVED', approved_by = p_actor, policy_id = pol,
    high_risk = row.amount_minor >= COALESCE((SELECT (body->>'highRiskMinor')::bigint FROM freehold.program_policies WHERE id = pol), row.amount_minor)
  WHERE id = row.id;
  RETURN jsonb_build_object('treasuryId', row.id, 'status', 'APPROVED', 'executed', false);
END $fn$;

CREATE FUNCTION freehold.program_treasury_execute(p_actor uuid, p_treasury uuid, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE
  row freehold.program_treasury;
  pol freehold.program_policies;
  from_acct uuid;
  to_acct uuid;
  journal uuid;
  executed uuid;
BEGIN
  PERFORM freehold._program_writer();
  SELECT * INTO row FROM freehold.program_treasury WHERE id = p_treasury FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROGRAM_TREASURY' USING ERRCODE = '22023'; END IF;
  IF row.kind = 'EXECUTED' THEN
    RETURN jsonb_build_object('treasuryId', row.id, 'duplicate', true, 'executed', true, 'journalId', row.journal_id, 'kind', 'EXECUTED');
  END IF;
  IF row.status = 'EXECUTED' THEN
    SELECT id, journal_id INTO executed, journal FROM freehold.program_treasury
    WHERE recommendation_id = row.id AND kind = 'EXECUTED' LIMIT 1;
    IF journal IS NULL THEN RAISE EXCEPTION 'PROGRAM_TREASURY' USING ERRCODE = '22023'; END IF;
    RETURN jsonb_build_object('treasuryId', executed, 'duplicate', true, 'executed', true, 'journalId', journal, 'kind', 'EXECUTED');
  END IF;
  IF row.kind IS DISTINCT FROM 'RECOMMENDATION' OR row.status IS DISTINCT FROM 'APPROVED' THEN
    RAISE EXCEPTION 'PROGRAM_TREASURY' USING ERRCODE = '22023';
  END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, row.institution_id, 'payments:write');
  PERFORM freehold._program_open(row.institution_id);
  IF row.movement NOT IN ('SWEEP','FUNDING','RESERVE_ALLOCATION','SCHEDULED') THEN
    RAISE EXCEPTION 'PROGRAM_TREASURY' USING ERRCODE = '22023';
  END IF;
  IF p_actor = row.approved_by OR row.approved_by IS NULL OR row.approved_by = row.created_by THEN
    RAISE EXCEPTION 'PROGRAM_SELF_APPROVAL' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO pol FROM freehold.program_policies WHERE id = row.policy_id;
  IF pol.id IS NULL OR row.amount_minor > pol.max_exposure_minor OR pol.currency_code IS DISTINCT FROM row.currency_code THEN
    RAISE EXCEPTION 'PROGRAM_LIMIT' USING ERRCODE = '22023';
  END IF;
  SELECT id INTO from_acct FROM freehold.institution_ledger_accounts
  WHERE institution_id = row.institution_id AND kind = row.from_kind AND currency_code = row.currency_code LIMIT 1;
  SELECT id INTO to_acct FROM freehold.institution_ledger_accounts
  WHERE institution_id = row.institution_id AND kind = row.to_kind AND currency_code = row.currency_code LIMIT 1;
  journal := freehold._program_move(row.institution_id, from_acct, to_acct, row.amount_minor, 'treasury:' || p_key);
  INSERT INTO freehold.program_treasury(
    institution_id, recommendation_id, kind, movement, amount_minor, currency_code, from_kind, to_kind,
    status, high_risk, policy_id, journal_id, created_by, approved_by, executed_by, idempotency_key)
  VALUES (
    row.institution_id, row.id, 'EXECUTED', row.movement, row.amount_minor, row.currency_code, row.from_kind, row.to_kind,
    'EXECUTED', row.high_risk, row.policy_id, journal, row.created_by, row.approved_by, p_actor, p_key)
  RETURNING id INTO executed;
  UPDATE freehold.program_treasury SET status = 'EXECUTED', journal_id = NULL WHERE id = row.id AND kind = 'RECOMMENDATION';
  PERFORM freehold._program_audit(row.institution_id, p_actor, 'TREASURY_EXECUTE', executed, jsonb_build_object('journalId', journal, 'recommendation', false));
  RETURN jsonb_build_object('treasuryId', executed, 'journalId', journal, 'executed', true, 'duplicate', false, 'kind', 'EXECUTED');
END $fn$;

CREATE FUNCTION freehold.program_treasury_monitor(p_actor uuid, p_institution uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE journals bigint; after_journals bigint; body jsonb;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'treasury:read');
  SELECT count(*) INTO journals FROM freehold.institution_journals;
  SELECT jsonb_build_object(
    'balances', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'currency', currency_code, 'balanceMinor', balance_minor::text) ORDER BY kind) FROM freehold.institution_ledger_accounts WHERE institution_id = p_institution), '[]'::jsonb),
    'concentrationBps', COALESCE((
      SELECT (max(balance_minor) * 10000) / NULLIF(sum(balance_minor), 0)
      FROM freehold.institution_ledger_accounts
      WHERE institution_id = p_institution AND kind IN ('OPERATING','TREASURY','RESERVE')), 0),
    'settlementQueue', (SELECT count(*) FROM freehold.network_payments p WHERE p.origin_institution_id = p_institution AND p.state = 'SETTLEMENT_PENDING'),
    'redemptionForecastMinor', '0',
    'redemptionForecastScope', 'NOT_INSTITUTION_SCOPED',
    'executed', false,
    'inventedLiquidity', false
  ) INTO body;
  SELECT count(*) INTO after_journals FROM freehold.institution_journals;
  IF journals IS DISTINCT FROM after_journals THEN RAISE EXCEPTION 'PROGRAM_TREASURY' USING ERRCODE = '55000'; END IF;
  RETURN body || jsonb_build_object('institutionId', p_institution, 'simulationOnly', true);
END $fn$;

CREATE FUNCTION freehold.program_asset_register(p_actor uuid, p_institution uuid, p_type text, p_code text, p_denomination text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE entity uuid; asset uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'governance:write');
  IF p_type NOT IN ('PAYMENT_STABLECOIN_UNIT','TOKENIZED_DEPOSIT','INSTITUTIONAL_DEBT','SECURITY','RECEIVABLE','COMMODITY_CLAIM') THEN
    RAISE EXCEPTION 'PROGRAM_ASSET' USING ERRCODE = '22023';
  END IF;
  SELECT legal_entity_id INTO entity FROM freehold.institution_ledger_accounts WHERE institution_id = p_institution AND kind = 'OPERATING' LIMIT 1;
  PERFORM freehold._institution_entity_ok(entity);
  PERFORM freehold._program_writer();
  INSERT INTO freehold.program_assets(issuer_institution_id, legal_entity_id, asset_type, code, denomination, lifecycle, created_by)
  VALUES (p_institution, entity, p_type, p_code, p_denomination, 'REGISTERED', p_actor)
  RETURNING id INTO asset;
  PERFORM freehold._program_audit(p_institution, p_actor, 'ASSET_REGISTER', asset, jsonb_build_object('legalInstrument', false, 'externalEvidence', 'EXTERNAL_EVIDENCE_UNAVAILABLE'));
  RETURN jsonb_build_object('assetId', asset, 'lifecycle', 'REGISTERED', 'legalInstrument', false, 'liveAuthorized', false);
END $fn$;

CREATE FUNCTION freehold.program_asset_authorize(p_actor uuid, p_asset uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE asset freehold.program_assets;
BEGIN
  PERFORM freehold._program_writer();
  SELECT * INTO asset FROM freehold.program_assets WHERE id = p_asset FOR UPDATE;
  IF NOT FOUND OR asset.lifecycle IS DISTINCT FROM 'REGISTERED' THEN RAISE EXCEPTION 'PROGRAM_ASSET' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, asset.issuer_institution_id, 'governance:write');
  IF p_actor = asset.created_by THEN RAISE EXCEPTION 'PROGRAM_SELF_APPROVAL' USING ERRCODE = '22023'; END IF;
  UPDATE freehold.program_assets SET lifecycle = 'AUTHORIZED', authorized_by = p_actor WHERE id = asset.id;
  RETURN jsonb_build_object('assetId', asset.id, 'lifecycle', 'AUTHORIZED', 'supplyChanged', false);
END $fn$;

CREATE FUNCTION freehold.program_asset_issue(p_actor uuid, p_institution uuid, p_asset uuid, p_qty bigint, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE asset freehold.program_assets; journal uuid; before_supply bigint;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'payments:write');
  PERFORM freehold._program_open(p_institution);
  SELECT * INTO asset FROM freehold.program_assets WHERE id = p_asset;
  IF asset.issuer_institution_id IS DISTINCT FROM p_institution THEN RAISE EXCEPTION 'PROGRAM_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  PERFORM freehold._program_pick_policy(p_institution, 'ASSET_TRANSFER', p_qty, asset.denomination);
  before_supply := asset.supply_minor;
  journal := freehold._program_asset_move(p_asset, 'ISSUE', p_key, NULL, p_institution, p_qty);
  SELECT supply_minor INTO asset.supply_minor FROM freehold.program_assets WHERE id = p_asset;
  RETURN jsonb_build_object('assetId', p_asset, 'journalId', journal, 'supplyMinor', asset.supply_minor::text, 'duplicate', asset.supply_minor = before_supply, 'externalEvidence', 'EXTERNAL_EVIDENCE_UNAVAILABLE');
END $fn$;

CREATE FUNCTION freehold.program_asset_transfer(p_actor uuid, p_from uuid, p_asset uuid, p_to uuid, p_qty bigint, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE asset freehold.program_assets; journal uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_from, 'payments:write');
  PERFORM freehold._program_open(p_from);
  IF p_from = p_to THEN RAISE EXCEPTION 'PROGRAM_ASSET' USING ERRCODE = '22023'; END IF;
  SELECT * INTO asset FROM freehold.program_assets WHERE id = p_asset;
  PERFORM freehold._program_pick_policy(p_from, 'ASSET_TRANSFER', p_qty, asset.denomination);
  journal := freehold._program_asset_move(p_asset, 'TRANSFER', p_key, p_from, p_to, p_qty);
  RETURN jsonb_build_object('journalId', journal, 'assetId', p_asset, 'legalInstrument', false);
END $fn$;

CREATE FUNCTION freehold.program_asset_hold(p_actor uuid, p_institution uuid, p_asset uuid, p_qty bigint, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE journal uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'payments:write');
  journal := freehold._program_asset_move(p_asset, 'HOLD', p_key, p_institution, NULL, p_qty);
  RETURN jsonb_build_object('journalId', journal, 'held', true);
END $fn$;

CREATE FUNCTION freehold.program_asset_release(p_actor uuid, p_institution uuid, p_asset uuid, p_qty bigint, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE journal uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'payments:write');
  journal := freehold._program_asset_move(p_asset, 'RELEASE', p_key, p_institution, NULL, p_qty);
  RETURN jsonb_build_object('journalId', journal, 'released', true);
END $fn$;

CREATE FUNCTION freehold.program_asset_redeem(p_actor uuid, p_institution uuid, p_asset uuid, p_qty bigint, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE journal uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'governance:write');
  journal := freehold._program_asset_move(p_asset, 'REDEEM', p_key, p_institution, NULL, p_qty);
  RETURN jsonb_build_object('journalId', journal, 'externalCash', false);
END $fn$;

CREATE FUNCTION freehold.program_asset_retire(p_actor uuid, p_institution uuid, p_asset uuid, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE qty bigint; journal uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'governance:write');
  SELECT available_minor INTO qty FROM freehold.program_asset_positions WHERE asset_id = p_asset AND holder_institution_id = p_institution;
  IF qty IS NULL OR qty <= 0 THEN RAISE EXCEPTION 'PROGRAM_ASSET' USING ERRCODE = '22023'; END IF;
  journal := freehold._program_asset_move(p_asset, 'RETIRE', p_key, p_institution, NULL, qty);
  RETURN jsonb_build_object('journalId', journal, 'lifecycle', 'RETIRED');
END $fn$;

CREATE FUNCTION freehold.program_exchange_admit(p_actor uuid, p_institution uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'governance:write');
  PERFORM freehold._program_writer();
  INSERT INTO freehold.program_exchange_members(institution_id, admitted_by) VALUES (p_institution, p_actor)
  ON CONFLICT (institution_id) DO NOTHING;
  RETURN jsonb_build_object('institutionId', p_institution, 'admitted', true, 'publicExchange', false, 'liveMarket', false);
END $fn$;

CREATE FUNCTION freehold.program_quote_open(
  p_actor uuid, p_institution uuid, p_base uuid, p_quote uuid, p_price bigint, p_qty bigint, p_kind text, p_expires timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE quote_id uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'payments:write');
  IF p_kind NOT IN ('FIRM','INDICATIVE') OR p_price <= 0 OR p_qty <= 0 OR p_expires <= clock_timestamp() OR p_base = p_quote THEN
    RAISE EXCEPTION 'PROGRAM_QUOTE' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM freehold.program_exchange_members WHERE institution_id = p_institution) THEN
    RAISE EXCEPTION 'PROGRAM_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM freehold._program_writer();
  INSERT INTO freehold.program_quotes(quoter_institution_id, base_asset_id, quote_asset_id, unit_price_minor, quantity_minor, kind, expires_at, status, created_by)
  VALUES (p_institution, p_base, p_quote, p_price, p_qty, p_kind, p_expires, 'OPEN', p_actor)
  RETURNING id INTO quote_id;
  RETURN jsonb_build_object('quoteId', quote_id, 'kind', p_kind, 'marketQuote', false, 'executableMarket', false);
END $fn$;

CREATE FUNCTION freehold.program_quote_execute(p_actor uuid, p_buyer uuid, p_quote uuid, p_price bigint, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE
  quote freehold.program_quotes;
  quote_qty bigint;
  first_asset uuid;
  second_asset uuid;
  base_journal uuid;
  quote_journal uuid;
  trade uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_buyer, 'payments:write');
  PERFORM freehold._program_open(p_buyer);
  PERFORM freehold._program_writer();
  SELECT * INTO quote FROM freehold.program_quotes WHERE id = p_quote FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROGRAM_QUOTE' USING ERRCODE = '22023'; END IF;
  IF quote.status = 'EXECUTED' THEN
    RETURN jsonb_build_object('quoteId', quote.id, 'duplicate', true, 'executed', true);
  END IF;
  IF quote.kind IS DISTINCT FROM 'FIRM' THEN RAISE EXCEPTION 'PROGRAM_QUOTE' USING ERRCODE = '22023'; END IF;
  IF quote.expires_at <= clock_timestamp() THEN
    UPDATE freehold.program_quotes SET status = 'EXPIRED' WHERE id = quote.id;
    RETURN jsonb_build_object('quoteId', quote.id, 'status', 'EXPIRED', 'executed', false, 'posted', false);
  END IF;
  IF p_price IS DISTINCT FROM quote.unit_price_minor THEN RAISE EXCEPTION 'PROGRAM_PRICE' USING ERRCODE = '22023'; END IF;
  IF p_buyer = quote.quoter_institution_id THEN RAISE EXCEPTION 'PROGRAM_SELF_APPROVAL' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM freehold.program_exchange_members WHERE institution_id = p_buyer)
     OR NOT EXISTS (SELECT 1 FROM freehold.program_exchange_members WHERE institution_id = quote.quoter_institution_id) THEN
    RAISE EXCEPTION 'PROGRAM_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF quote.quantity_minor > 9223372036854775807 / quote.unit_price_minor THEN RAISE EXCEPTION 'PROGRAM_LIMIT' USING ERRCODE = '22023'; END IF;
  quote_qty := quote.quantity_minor * quote.unit_price_minor;
  PERFORM freehold._program_pick_policy(p_buyer, 'ASSET_TRANSFER', quote_qty, 'USD');
  first_asset := LEAST(quote.base_asset_id, quote.quote_asset_id);
  second_asset := GREATEST(quote.base_asset_id, quote.quote_asset_id);
  PERFORM 1 FROM freehold.program_assets WHERE id = first_asset FOR UPDATE;
  PERFORM 1 FROM freehold.program_assets WHERE id = second_asset FOR UPDATE;
  base_journal := freehold._program_asset_move(quote.base_asset_id, 'TRANSFER', p_key || ':base', quote.quoter_institution_id, p_buyer, quote.quantity_minor);
  quote_journal := freehold._program_asset_move(quote.quote_asset_id, 'TRANSFER', p_key || ':quote', p_buyer, quote.quoter_institution_id, quote_qty);
  INSERT INTO freehold.program_trades(
    quote_id, buyer_institution_id, seller_institution_id, quantity_minor, unit_price_minor, base_journal_id, quote_journal_id)
  VALUES (quote.id, p_buyer, quote.quoter_institution_id, quote.quantity_minor, quote.unit_price_minor, base_journal, quote_journal)
  RETURNING id INTO trade;
  UPDATE freehold.program_quotes SET status = 'EXECUTED' WHERE id = quote.id;
  RETURN jsonb_build_object('tradeId', trade, 'atomicity', 'SINGLE_DATABASE', 'marketQuote', false, 'baseJournalId', base_journal, 'quoteJournalId', quote_journal);
END $fn$;

CREATE FUNCTION freehold.program_collateral_pledge(p_actor uuid, p_institution uuid, p_asset uuid, p_qty bigint, p_haircut integer, p_arrangement text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE journal uuid; row_id uuid; exposure bigint;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'payments:write');
  PERFORM freehold._program_open(p_institution);
  IF p_haircut < 0 OR p_haircut >= 10000 OR p_qty <= 0 THEN RAISE EXCEPTION 'PROGRAM_COLLATERAL' USING ERRCODE = '22023'; END IF;
  IF EXISTS (
    SELECT 1 FROM freehold.program_collateral
    WHERE asset_id = p_asset AND pledgor_institution_id = p_institution AND arrangement_key = p_arrangement
  ) THEN RAISE EXCEPTION 'PROGRAM_COLLATERAL' USING ERRCODE = '55000'; END IF;
  exposure := (p_qty * (10000 - p_haircut)) / 10000;
  journal := freehold._program_asset_move(
    p_asset, 'PLEDGE',
    'pledge:' || encode(public.digest(convert_to(p_arrangement || ':' || p_asset::text, 'UTF8'), 'sha256'), 'hex'),
    p_institution, NULL, p_qty);
  PERFORM freehold._program_writer();
  INSERT INTO freehold.program_collateral(asset_id, pledgor_institution_id, quantity_minor, haircut_bps, arrangement_key, status, pledge_journal_id, created_by)
  VALUES (p_asset, p_institution, p_qty, p_haircut, p_arrangement, 'PLEDGED', journal, p_actor)
  RETURNING id INTO row_id;
  RETURN jsonb_build_object('collateralId', row_id, 'status', 'PLEDGED', 'exposureMinor', exposure::text, 'countsAsReserve', false, 'loanCreated', false);
END $fn$;

CREATE FUNCTION freehold.program_collateral_release(p_actor uuid, p_collateral uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE row freehold.program_collateral; journal uuid;
BEGIN
  PERFORM freehold._program_writer();
  SELECT * INTO row FROM freehold.program_collateral WHERE id = p_collateral FOR UPDATE;
  IF NOT FOUND OR row.status IS DISTINCT FROM 'PLEDGED' THEN RAISE EXCEPTION 'PROGRAM_COLLATERAL' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, row.pledgor_institution_id, 'governance:write');
  journal := freehold._program_asset_move(row.asset_id, 'UNPLEDGE', 'unpledge:' || row.id::text, row.pledgor_institution_id, NULL, row.quantity_minor);
  UPDATE freehold.program_collateral SET status = 'RELEASED', release_journal_id = journal WHERE id = row.id;
  RETURN jsonb_build_object('collateralId', row.id, 'status', 'RELEASED', 'journalId', journal);
END $fn$;

CREATE FUNCTION freehold.program_collateral_substitute(p_actor uuid, p_collateral uuid, p_asset uuid, p_qty bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE row freehold.program_collateral; release_journal uuid; pledge_journal uuid; new_id uuid;
BEGIN
  PERFORM freehold._program_writer();
  SELECT * INTO row FROM freehold.program_collateral WHERE id = p_collateral FOR UPDATE;
  IF NOT FOUND OR row.status IS DISTINCT FROM 'PLEDGED' THEN RAISE EXCEPTION 'PROGRAM_COLLATERAL' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, row.pledgor_institution_id, 'governance:write');
  release_journal := freehold._program_asset_move(row.asset_id, 'UNPLEDGE', 'sub-out:' || row.id::text, row.pledgor_institution_id, NULL, row.quantity_minor);
  pledge_journal := freehold._program_asset_move(p_asset, 'PLEDGE', 'sub-in:' || row.id::text, row.pledgor_institution_id, NULL, p_qty);
  UPDATE freehold.program_collateral SET status = 'SUBSTITUTED', release_journal_id = release_journal WHERE id = row.id;
  INSERT INTO freehold.program_collateral(asset_id, pledgor_institution_id, quantity_minor, haircut_bps, arrangement_key, status, pledge_journal_id, created_by)
  VALUES (p_asset, row.pledgor_institution_id, p_qty, row.haircut_bps, row.arrangement_key || '-sub', 'PLEDGED', pledge_journal, p_actor)
  RETURNING id INTO new_id;
  RETURN jsonb_build_object('collateralId', new_id, 'replaced', row.id, 'status', 'PLEDGED');
END $fn$;

CREATE FUNCTION freehold.program_collateral_default(p_actor uuid, p_collateral uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE row freehold.program_collateral; pledged bigint;
BEGIN
  PERFORM freehold._program_writer();
  SELECT * INTO row FROM freehold.program_collateral WHERE id = p_collateral FOR UPDATE;
  IF NOT FOUND OR row.status IS DISTINCT FROM 'PLEDGED' THEN RAISE EXCEPTION 'PROGRAM_COLLATERAL' USING ERRCODE = '22023'; END IF;
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, row.pledgor_institution_id, 'governance:write');
  SELECT pledged_minor INTO pledged FROM freehold.program_asset_positions WHERE asset_id = row.asset_id AND holder_institution_id = row.pledgor_institution_id;
  UPDATE freehold.program_collateral SET status = 'DEFAULTED_SIMULATION' WHERE id = row.id;
  IF (SELECT pledged_minor FROM freehold.program_asset_positions WHERE asset_id = row.asset_id AND holder_institution_id = row.pledgor_institution_id) IS DISTINCT FROM pledged THEN
    RAISE EXCEPTION 'PROGRAM_COLLATERAL' USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object('collateralId', row.id, 'status', 'DEFAULTED_SIMULATION', 'loanCreated', false, 'unitsMoved', false, 'countsAsReserve', false);
END $fn$;

CREATE FUNCTION freehold.program_suspend(p_actor uuid, p_institution uuid, p_suspend boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
DECLARE prior uuid;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'governance:write');
  PERFORM freehold._program_writer();
  SELECT suspended_by INTO prior FROM freehold.program_controls WHERE institution_id = p_institution;
  IF p_suspend IS FALSE AND prior = p_actor THEN RAISE EXCEPTION 'PROGRAM_SELF_APPROVAL' USING ERRCODE = '22023'; END IF;
  INSERT INTO freehold.program_controls(institution_id, suspended, suspended_by, suspended_at)
  VALUES (p_institution, p_suspend, CASE WHEN p_suspend THEN p_actor ELSE NULL END, CASE WHEN p_suspend THEN clock_timestamp() ELSE NULL END)
  ON CONFLICT (institution_id) DO UPDATE SET
    suspended = EXCLUDED.suspended,
    suspended_by = EXCLUDED.suspended_by,
    suspended_at = EXCLUDED.suspended_at;
  RETURN jsonb_build_object('institutionId', p_institution, 'suspended', p_suspend);
END $fn$;

CREATE FUNCTION freehold.program_dashboard(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
BEGIN
  PERFORM freehold._require_bound_session(p_actor);
  IF NOT EXISTS (SELECT 1 FROM freehold.users WHERE id = p_actor AND role = 'ADMIN' AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'PROGRAM_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'simulationOnly', true,
    'liveRails', false,
    'legalEscrow', false,
    'fiduciaryCustody', false,
    'publicExchange', false,
    'liveIssuance', false,
    'previewIsExecution', false,
    'distributedAtomicity', false,
    'recordedTotalsAreNotIndependentVerification', true,
    'workflows', (SELECT count(*) FROM freehold.program_workflows),
    'completed', (SELECT count(*) FROM freehold.program_workflows WHERE status = 'COMPLETED'),
    'unknown', (SELECT count(*) FROM freehold.program_workflows WHERE status = 'UNKNOWN'),
    'escrows', (SELECT count(*) FROM freehold.program_escrows),
    'assets', (SELECT count(*) FROM freehold.program_assets),
    'openQuotes', (SELECT count(*) FROM freehold.program_quotes WHERE status = 'OPEN'),
    'pledged', (SELECT count(*) FROM freehold.program_collateral WHERE status = 'PLEDGED'),
    'emptyMessage', CASE WHEN (SELECT count(*) FROM freehold.program_workflows) = 0 THEN 'No simulated workflow is recorded.' ELSE NULL END
  );
END $fn$;

CREATE FUNCTION freehold.program_activate_live(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $fn$
BEGIN
  PERFORM freehold._require_bound_session(p_actor);
  IF NOT EXISTS (SELECT 1 FROM freehold.users WHERE id = p_actor AND role = 'ADMIN' AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'PROGRAM_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RAISE EXCEPTION 'LIVE_MONETARY_ACTIVATION_REFUSED' USING ERRCODE = '42501';
END $fn$;

REVOKE ALL ON FUNCTION freehold._program_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._program_writer() FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._program_audit(uuid, uuid, text, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._program_open(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._program_hash(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._program_forbidden(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._program_definition_ok(jsonb, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._program_policy_ok(text, jsonb, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._program_leg(uuid, uuid, uuid, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._program_move(uuid, uuid, uuid, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._program_bridge(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._program_asset_move(uuid, text, text, uuid, uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._program_not_before(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._program_pick_policy(uuid, text, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._program_escrow_finish(uuid, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION freehold._program_execute(uuid, text) FROM PUBLIC;

DO $do$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'program_policy_draft(uuid,uuid,text,jsonb,integer,bigint,text,timestamp with time zone,timestamp with time zone)',
    'program_policy_approve(uuid,uuid)',
    'program_policy_retire(uuid,uuid)',
    'program_workflow_draft(uuid,uuid,jsonb,bigint,text,timestamp with time zone,text,integer)',
    'program_workflow_submit(uuid,uuid)',
    'program_workflow_approve(uuid,uuid)',
    'program_workflow_cancel(uuid,uuid)',
    'program_workflow_preview(uuid,uuid)',
    'program_workflow_get(uuid,uuid)',
    'program_workflow_execute(uuid,uuid,text)',
    'program_escrow_fund(uuid,uuid,uuid,bigint,uuid,text,jsonb,timestamp with time zone,text)',
    'program_escrow_release(uuid,uuid,uuid)',
    'program_escrow_return(uuid,uuid,text)',
    'program_escrow_dispute(uuid,uuid)',
    'program_settle_atomic(uuid,uuid,text,timestamp with time zone,jsonb)',
    'program_settle_coordinate(uuid,uuid,text,jsonb)',
    'program_execution_unknown(uuid,uuid)',
    'program_fusd_request(uuid,uuid,uuid,bigint,text,timestamp with time zone)',
    'program_treasury_recommend(uuid,uuid,text,bigint,text,text,text)',
    'program_treasury_approve(uuid,uuid)',
    'program_treasury_execute(uuid,uuid,text)',
    'program_treasury_monitor(uuid,uuid)',
    'program_asset_register(uuid,uuid,text,text,text)',
    'program_asset_authorize(uuid,uuid)',
    'program_asset_issue(uuid,uuid,uuid,bigint,text)',
    'program_asset_transfer(uuid,uuid,uuid,uuid,bigint,text)',
    'program_asset_hold(uuid,uuid,uuid,bigint,text)',
    'program_asset_release(uuid,uuid,uuid,bigint,text)',
    'program_asset_redeem(uuid,uuid,uuid,bigint,text)',
    'program_asset_retire(uuid,uuid,uuid,text)',
    'program_exchange_admit(uuid,uuid)',
    'program_quote_open(uuid,uuid,uuid,uuid,bigint,bigint,text,timestamp with time zone)',
    'program_quote_execute(uuid,uuid,uuid,bigint,text)',
    'program_collateral_pledge(uuid,uuid,uuid,bigint,integer,text)',
    'program_collateral_release(uuid,uuid)',
    'program_collateral_substitute(uuid,uuid,uuid,bigint)',
    'program_collateral_default(uuid,uuid)',
    'program_suspend(uuid,uuid,boolean)',
    'program_dashboard(uuid)',
    'program_activate_live(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION freehold.%s FROM PUBLIC, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION freehold.%s TO freehold_api', fn);
  END LOOP;
  EXECUTE 'REVOKE ALL ON FUNCTION freehold.program_workflow_run_due(uuid, integer) FROM PUBLIC, freehold_api, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup';
  EXECUTE 'GRANT EXECUTE ON FUNCTION freehold.program_workflow_run_due(uuid, integer) TO freehold_worker';
END $do$;

REVOKE ALL ON FUNCTION freehold._program_guard() FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._program_writer() FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._program_audit(uuid, uuid, text, uuid, jsonb) FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._program_open(uuid) FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._program_hash(jsonb) FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._program_forbidden(jsonb) FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._program_definition_ok(jsonb, bigint) FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._program_policy_ok(text, jsonb, bigint, text) FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._program_leg(uuid, uuid, uuid, bigint, text) FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._program_move(uuid, uuid, uuid, bigint, text) FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._program_bridge(uuid, uuid, text, text) FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._program_asset_move(uuid, text, text, uuid, uuid, bigint) FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._program_not_before(jsonb) FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._program_pick_policy(uuid, text, bigint, text) FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._program_escrow_finish(uuid, text, uuid, uuid) FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._program_execute(uuid, text) FROM freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;

REVOKE ALL ON TABLE
  freehold.program_controls, freehold.program_policies, freehold.program_workflows, freehold.program_approvals,
  freehold.program_executions, freehold.program_legs, freehold.program_escrows, freehold.program_treasury,
  freehold.program_assets, freehold.program_asset_positions, freehold.program_asset_journals,
  freehold.program_exchange_members, freehold.program_quotes, freehold.program_trades, freehold.program_collateral,
  freehold.program_issuance_requests, freehold.program_audit
FROM PUBLIC, freehold_api, freehold_worker, freehold_auth, freehold_scheduler, freehold_backup, freehold_app;

GRANT SELECT ON
  freehold.program_controls, freehold.program_policies, freehold.program_workflows, freehold.program_approvals,
  freehold.program_executions, freehold.program_legs, freehold.program_escrows, freehold.program_treasury,
  freehold.program_assets, freehold.program_asset_positions, freehold.program_asset_journals,
  freehold.program_exchange_members, freehold.program_quotes, freehold.program_trades, freehold.program_collateral,
  freehold.program_issuance_requests, freehold.program_audit
TO freehold_verifier;

RESET ROLE;
