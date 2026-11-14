-- Phase 11. Forward only. Migrations 001 through 023 are not edited.
-- Failed settlement is not audited as a success. Duplicate attempts are recorded
-- without a second financial effect. Report review cannot be self-approved, and
-- certification stays NOT_CERTIFIED. Partners stay UNVERIFIED. Disclosures stay drafts.
-- Live issuance stays impossible. Simulated reserves are not external assets.
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;

ALTER TABLE freehold.issuance_operations DROP CONSTRAINT issuance_operations_state_check;
ALTER TABLE freehold.issuance_operations ADD CONSTRAINT issuance_operations_state_check
  CHECK (state IN (
    'REQUESTED','PENDING_RESERVE_VERIFICATION','PENDING_APPROVAL','APPROVED',
    'EXECUTING','ISSUED','REJECTED','FAILED','UNKNOWN','EXPIRED'));
ALTER TABLE freehold.issuance_operations ADD COLUMN approved_until timestamptz;

ALTER TABLE freehold.regulatory_reports DROP CONSTRAINT regulatory_reports_state_check;
ALTER TABLE freehold.regulatory_reports ADD CONSTRAINT regulatory_reports_state_check
  CHECK (state IN (
    'DRAFT','PENDING_REVIEW','APPROVED_INTERNALLY','EXTERNAL_REVIEW_REQUIRED',
    'CERTIFICATION_REQUIRED','READY_FOR_AUTHORIZED_SUBMISSION','SUBMITTED_WITH_EVIDENCE',
    'REJECTED','INCOMPLETE'));
ALTER TABLE freehold.regulatory_reports
  ADD COLUMN certification_requirement text NOT NULL DEFAULT 'NOT_RECORDED',
  ADD COLUMN amends_report_id uuid REFERENCES freehold.regulatory_reports(id),
  ADD COLUMN corrects_report_id uuid REFERENCES freehold.regulatory_reports(id);
ALTER TABLE freehold.regulatory_reports ADD CONSTRAINT regulatory_reports_certification_requirement_check
  CHECK (certification_requirement IN ('NOT_RECORDED','EXTERNAL_ACCOUNTANT_REQUIRED'));
ALTER TABLE freehold.regulatory_reports ADD CONSTRAINT regulatory_reports_followup_check
  CHECK (amends_report_id IS NULL OR corrects_report_id IS NULL);
CREATE UNIQUE INDEX regulatory_reports_one_open_amendment
  ON freehold.regulatory_reports (amends_report_id)
  WHERE amends_report_id IS NOT NULL AND state NOT IN ('REJECTED','INCOMPLETE');
CREATE UNIQUE INDEX regulatory_reports_one_open_correction
  ON freehold.regulatory_reports (corrects_report_id)
  WHERE corrects_report_id IS NOT NULL AND state NOT IN ('REJECTED','INCOMPLETE');

ALTER TABLE freehold.product_disclosures
  ADD COLUMN review_status text NOT NULL DEFAULT 'LEGAL_REVIEW_REQUIRED',
  ADD COLUMN is_current boolean NOT NULL DEFAULT false;
ALTER TABLE freehold.product_disclosures ADD CONSTRAINT product_disclosures_review_status_check
  CHECK (review_status = 'LEGAL_REVIEW_REQUIRED');
CREATE UNIQUE INDEX product_disclosures_one_current
  ON freehold.product_disclosures (product_code) WHERE is_current;

INSERT INTO freehold.product_disclosures(product_code, version, body, review_status, is_current) VALUES
  ('USD_BANK_DEPOSIT','phase11-draft',
   'DRAFT FOR LEGAL REVIEW. This is not a final disclosure and not a deposit agreement. A USD balance in this application is a ledger record. Freehold Technologies is the software provider. No bank partner is appointed, so this balance is not presented as an FDIC-insured deposit, legal tender, or a government obligation. No third party custodies it. Redemption and external settlement are not offered. No fee is charged on this page. The record can be lost with this database. A complaint about a real deposit would belong to a bank, and no such bank is appointed here.',
   'LEGAL_REVIEW_REQUIRED', true),
  ('PAYMENT_STABLECOIN','phase11-draft',
   'DRAFT FOR LEGAL REVIEW. This is not a final disclosure. Simulated FUSD is a ledger unit. Freehold Technologies is not the legal issuer, and no permitted payment stablecoin issuer is appointed. It is not an insured deposit product, not FDIC insured, not a United States government obligation, and not legal tender. Redemption for dollars is not offered. No fee is charged in this simulation. Principal risk: the unit is not backed by verified external reserves, and a database row is not cash. No custodian is appointed. This software has no bank or regulator complaint channel. Acknowledging this draft does not authorize live issuance.',
   'LEGAL_REVIEW_REQUIRED', true);

CREATE TABLE freehold.disclosure_acknowledgments (
  user_id uuid NOT NULL REFERENCES freehold.users(id),
  product_code text NOT NULL,
  version text NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, product_code, version),
  FOREIGN KEY (product_code, version) REFERENCES freehold.product_disclosures(product_code, version)
);

CREATE TABLE freehold.institutional_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  control_id text NOT NULL,
  citation text NOT NULL,
  source_title text NOT NULL,
  technical_control text NOT NULL,
  test_ref text NOT NULL,
  responsible_role text NOT NULL,
  technical_status text NOT NULL CHECK (technical_status IN ('NOT_RUN','IMPLEMENTED_UNVERIFIED','FAILED','NOT_APPLICABLE')),
  legal_status text NOT NULL CHECK (legal_status IN ('LEGAL_REVIEW_REQUIRED','NOT_APPLICABLE')),
  certification_status text NOT NULL CHECK (certification_status IN ('NOT_CERTIFIED','EXTERNAL_CERTIFICATION_REQUIRED','NOT_APPLICABLE')),
  regulatory_status text NOT NULL CHECK (regulatory_status IN ('NOT_SUBMITTED','REGULATORY_APPROVAL_REQUIRED','EXTERNAL_EVIDENCE_REQUIRED','NOT_APPLICABLE')),
  expires_at timestamptz,
  deficiency text NOT NULL DEFAULT '',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE freehold.institutional_evidence_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id uuid NOT NULL REFERENCES freehold.institutional_evidence(id),
  reviewer_id uuid NOT NULL,
  note text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE freehold.institutional_partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name text NOT NULL,
  entity_kind text NOT NULL CHECK (entity_kind IN ('PROSPECTIVE_BANK','PROSPECTIVE_CUSTODIAN','PROSPECTIVE_ISSUER')),
  charter_status text NOT NULL CHECK (charter_status = 'UNVERIFIED'),
  relationship_status text NOT NULL CHECK (relationship_status = 'UNVERIFIED'),
  settlement_capability text NOT NULL CHECK (settlement_capability = 'NOT_ENABLED'),
  custody_capability text NOT NULL CHECK (custody_capability = 'NOT_ENABLED'),
  integration_status text NOT NULL CHECK (integration_status IN ('NOT_STARTED','SIMULATED_ONLY')),
  external_evidence text NOT NULL CHECK (external_evidence = 'UNAVAILABLE'),
  agreement_expires_on date,
  compliance_responsibility text NOT NULL,
  escalation_contact text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE freehold.institutional_partner_checks (
  partner_id uuid NOT NULL REFERENCES freehold.institutional_partners(id),
  item_code text NOT NULL CHECK (item_code IN (
    'IDENTITY','LICENSE_OR_CHARTER','SERVICE_AGREEMENT','DUE_DILIGENCE','PRODUCTS',
    'SETTLEMENT','CUSTODY','CONTACTS','COMPLIANCE','EXPIRATION','ESCALATION','INTEGRATION')),
  state text NOT NULL CHECK (state IN ('OPEN','RECORDED_NOT_VERIFIED')),
  recorded_by uuid,
  PRIMARY KEY (partner_id, item_code)
);

CREATE TRIGGER disclosure_ack_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.disclosure_acknowledgments
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.institutional_evidence
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER evidence_review_insert_guard BEFORE INSERT ON freehold.institutional_evidence_reviews
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER evidence_review_append_only BEFORE UPDATE OR DELETE ON freehold.institutional_evidence_reviews
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_append_only();
CREATE TRIGGER partner_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.institutional_partners
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();
CREATE TRIGGER partner_check_guard BEFORE INSERT OR UPDATE OR DELETE ON freehold.institutional_partner_checks
  FOR EACH ROW EXECUTE FUNCTION freehold._monetary_guard_write();

CREATE OR REPLACE FUNCTION freehold._monetary_coverage_alert(p_book uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE eligible bigint; outstanding bigint; entity uuid; alert_id uuid;
BEGIN
  eligible := freehold._monetary_eligible(p_book);
  SELECT s.outstanding, b.entity_id INTO outstanding, entity
  FROM freehold.monetary_supply s
  JOIN freehold.monetary_books b ON b.id = s.book_id
  WHERE s.book_id = p_book;
  IF outstanding > eligible AND NOT EXISTS (
    SELECT 1 FROM freehold.monetary_alerts
    WHERE book_id = p_book AND code = 'RESERVE_DEFICIT' AND acknowledged_at IS NULL
  ) THEN
    INSERT INTO freehold.monetary_alerts(book_id, severity, code)
    VALUES (p_book, 'CRITICAL', 'RESERVE_DEFICIT')
    RETURNING id INTO alert_id;
    PERFORM freehold._monetary_audit(entity, p_book, 'RESERVE_DEFICIT', NULL,
      jsonb_build_object('alertId', alert_id, 'outstanding', outstanding::text, 'eligibleSimulated', eligible::text, 'externalEvidence', false));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION freehold.monetary_issue_request(p_actor uuid, p_book uuid, p_amount bigint, p_holder uuid, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE b freehold.monetary_books; existing freehold.issuance_operations; row_id uuid; current_version text;
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
  IF FOUND THEN
    PERFORM freehold._monetary_audit(b.entity_id, p_book, 'DUPLICATE_ISSUE_REQUEST', p_actor, freehold._issue_json(existing));
    RETURN freehold._issue_json(existing);
  END IF;
  IF EXISTS (
    SELECT 1 FROM freehold.monetary_restrictions
    WHERE subject_user_id = COALESCE(p_holder, p_actor) AND active AND kind = 'BLOCK_SIMULATED_ISSUANCE'
  ) THEN RAISE EXCEPTION 'MONETARY_RESTRICTED' USING ERRCODE='22023'; END IF;
  IF p_holder IS NOT NULL THEN
    SELECT version INTO current_version FROM freehold.product_disclosures
    WHERE product_code = 'PAYMENT_STABLECOIN' AND is_current;
    IF current_version IS NULL OR NOT EXISTS (
      SELECT 1 FROM freehold.disclosure_acknowledgments
      WHERE user_id = p_holder AND product_code = 'PAYMENT_STABLECOIN' AND version = current_version
    ) THEN RAISE EXCEPTION 'MONETARY_DISCLOSURE' USING ERRCODE='22023'; END IF;
  END IF;
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

CREATE OR REPLACE FUNCTION freehold.monetary_issue_approve(p_actor uuid, p_id uuid) RETURNS jsonb
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
  UPDATE freehold.issuance_operations
     SET state = 'APPROVED', approver_id = p_actor, approved_until = clock_timestamp() + interval '24 hours'
   WHERE id = op.id;
  SELECT * INTO op FROM freehold.issuance_operations WHERE id = p_id;
  PERFORM freehold._monetary_audit(b.entity_id, op.book_id, 'ISSUE_APPROVE', p_actor, freehold._issue_json(op));
  RETURN freehold._issue_json(op);
END $$;

CREATE OR REPLACE FUNCTION freehold.monetary_issue_execute(p_actor uuid, p_id uuid) RETURNS jsonb
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
  IF op.approved_until IS NOT NULL AND op.approved_until <= clock_timestamp() THEN
    UPDATE freehold.issuance_operations SET state = 'EXPIRED' WHERE id = op.id;
    PERFORM freehold._monetary_recompute(op.book_id);
    SELECT * INTO op FROM freehold.issuance_operations WHERE id = p_id;
    PERFORM freehold._monetary_audit(b.entity_id, op.book_id, 'APPROVAL_EXPIRED', p_actor, freehold._issue_json(op));
    RETURN freehold._issue_json(op);
  END IF;
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
    PERFORM freehold._monetary_audit(b.entity_id, op.book_id, 'ISSUE_EXECUTE_FAILED', p_actor, freehold._issue_json(op));
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

CREATE FUNCTION freehold.monetary_expire_approval(p_actor uuid, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE op freehold.issuance_operations; b freehold.monetary_books;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'ISSUANCE_AUTHORITY');
  PERFORM freehold._monetary_writes_open();
  SELECT * INTO op FROM freehold.issuance_operations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  b := freehold._monetary_lock(op.book_id);
  IF op.state <> 'APPROVED' OR op.approved_until IS NULL OR op.approved_until > clock_timestamp() THEN
    RAISE EXCEPTION 'MONETARY_STATE' USING ERRCODE='22023';
  END IF;
  UPDATE freehold.issuance_operations SET state = 'EXPIRED' WHERE id = op.id;
  PERFORM freehold._monetary_recompute(op.book_id);
  SELECT * INTO op FROM freehold.issuance_operations WHERE id = p_id;
  PERFORM freehold._monetary_audit(b.entity_id, op.book_id, 'APPROVAL_EXPIRED', p_actor, freehold._issue_json(op));
  RETURN freehold._issue_json(op);
END $$;

CREATE OR REPLACE FUNCTION freehold.monetary_redeem_request(p_actor uuid, p_book uuid, p_amount bigint, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE b freehold.monetary_books; existing freehold.redemption_operations; held bigint; source_kind text; ref uuid; row_id uuid;
BEGIN
  PERFORM freehold._require_bound_session(p_actor);
  PERFORM freehold._monetary_writes_open();
  b := freehold._monetary_lock(p_book);
  IF b.redemption_suspended THEN RAISE EXCEPTION 'MONETARY_SUSPENDED' USING ERRCODE='22023'; END IF;
  SELECT * INTO existing FROM freehold.redemption_operations WHERE book_id = p_book AND idempotency_key = p_key;
  IF FOUND THEN
    PERFORM freehold._monetary_audit(b.entity_id, p_book, 'DUPLICATE_REDEEM_REQUEST', p_actor, freehold._redeem_json(existing));
    RETURN freehold._redeem_json(existing);
  END IF;
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

CREATE OR REPLACE FUNCTION freehold.monetary_redeem_settlement(p_actor uuid, p_id uuid, p_outcome text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE op freehold.redemption_operations; b freehold.monetary_books; action text;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'TREASURY');
  PERFORM freehold._monetary_writes_open();
  SELECT * INTO op FROM freehold.redemption_operations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  b := freehold._monetary_lock(op.book_id);
  IF op.state = 'UNKNOWN' THEN RAISE EXCEPTION 'MONETARY_UNKNOWN_BLOCKED' USING ERRCODE='22023'; END IF;
  IF op.state IN ('SETTLEMENT_CONFIRMED','FAILED','EXCEPTION','REDEEMED') THEN
    action := CASE
      WHEN (op.state = 'FAILED' AND p_outcome = 'FAILED')
        OR (op.state = 'EXCEPTION' AND p_outcome = 'EXCEPTION')
        OR (op.state = 'SETTLEMENT_CONFIRMED' AND p_outcome = 'SETTLEMENT_CONFIRMED')
        OR op.state = 'REDEEMED'
      THEN 'DUPLICATE_SETTLEMENT' ELSE 'DUPLICATE_SETTLEMENT_CONFLICT' END;
    PERFORM freehold._monetary_audit(b.entity_id, op.book_id, action, p_actor,
      freehold._redeem_json(op) || jsonb_build_object('attemptedOutcome', p_outcome, 'stateChanged', false));
    RETURN freehold._redeem_json(op);
  END IF;
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
    action := 'REDEEM_SETTLEMENT_FAILED';
  ELSIF p_outcome = 'EXCEPTION' THEN
    UPDATE freehold.redemption_operations SET state = 'EXCEPTION', settlement_actor = p_actor WHERE id = op.id;
    action := 'REDEEM_SETTLEMENT_EXCEPTION';
  ELSE
    UPDATE freehold.redemption_operations SET state = 'SETTLEMENT_CONFIRMED', settlement_actor = p_actor WHERE id = op.id;
    action := 'REDEEM_SETTLEMENT_CONFIRMED';
  END IF;
  PERFORM freehold._monetary_recompute(op.book_id);
  SELECT * INTO op FROM freehold.redemption_operations WHERE id = p_id;
  PERFORM freehold._monetary_audit(b.entity_id, op.book_id, action, p_actor, freehold._redeem_json(op));
  RETURN freehold._redeem_json(op);
END $$;

CREATE OR REPLACE FUNCTION freehold.monetary_reserve_review(p_actor uuid, p_reserve uuid, p_decision text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE r freehold.reserve_assets; b freehold.monetary_books; action text;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'TREASURY');
  PERFORM freehold._monetary_writes_open();
  SELECT * INTO r FROM freehold.reserve_assets WHERE id = p_reserve FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  b := freehold._monetary_lock(r.book_id);
  IF p_actor = r.proposer_id THEN RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023'; END IF;
  IF p_decision NOT IN ('VERIFIED','REJECTED') THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  IF r.evidence_state NOT IN ('UNVERIFIED','PENDING_CONFIRMATION') THEN
    PERFORM freehold._monetary_audit(b.entity_id, r.book_id, 'DUPLICATE_RESERVE_REVIEW', p_actor,
      jsonb_build_object('reserveId', r.id, 'evidenceState', r.evidence_state, 'attemptedDecision', p_decision));
    RETURN jsonb_build_object('reserveId', r.id, 'evidenceState', r.evidence_state, 'evidenceScope', 'SIMULATED');
  END IF;
  UPDATE freehold.reserve_assets SET
    evidence_state = p_decision,
    reviewer_id = p_actor,
    verified_at = CASE WHEN p_decision = 'VERIFIED' THEN clock_timestamp() ELSE NULL END
  WHERE id = r.id;
  action := CASE WHEN p_decision = 'REJECTED' THEN 'RESERVE_REVIEW_REJECTED' ELSE 'RESERVE_REVIEW' END;
  PERFORM freehold._monetary_audit(b.entity_id, r.book_id, action, p_actor,
    jsonb_build_object('reserveId', r.id, 'decision', p_decision, 'evidenceScope', 'SIMULATED', 'externalEvidence', false));
  RETURN jsonb_build_object('reserveId', r.id, 'evidenceState', p_decision, 'evidenceScope', 'SIMULATED', 'externalEvidence', false);
END $$;

CREATE OR REPLACE FUNCTION freehold.monetary_alert_acknowledge(p_actor uuid, p_alert uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE alert freehold.monetary_alerts; before_outstanding bigint; after_outstanding bigint; entity uuid;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'FINANCIAL_RISK');
  SELECT * INTO alert FROM freehold.monetary_alerts WHERE id = p_alert;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT outstanding, entity_id INTO before_outstanding, entity
  FROM freehold.monetary_supply s JOIN freehold.monetary_books b ON b.id = s.book_id
  WHERE s.book_id = alert.book_id;
  PERFORM set_config('freehold.monetary_writer','on',true);
  UPDATE freehold.monetary_alerts SET acknowledged_by = p_actor, acknowledged_at = clock_timestamp() WHERE id = p_alert;
  SELECT outstanding INTO after_outstanding FROM freehold.monetary_supply WHERE book_id = alert.book_id;
  IF before_outstanding IS DISTINCT FROM after_outstanding THEN
    RAISE EXCEPTION 'MONETARY_SUPPLY_MISMATCH' USING ERRCODE='55000';
  END IF;
  PERFORM freehold._monetary_audit(entity, alert.book_id, 'ALERT_ACKNOWLEDGE', p_actor,
    jsonb_build_object('alertId', p_alert, 'outstandingUnchanged', after_outstanding::text));
  RETURN jsonb_build_object('alertId', p_alert, 'outstandingUnchanged', after_outstanding::text);
END $$;

CREATE OR REPLACE FUNCTION freehold.monetary_report_transition(p_actor uuid, p_report uuid, p_state text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE report freehold.regulatory_reports; requirement text;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'FINANCIAL_RISK');
  IF p_state = 'SUBMITTED_WITH_EVIDENCE' THEN
    RAISE EXCEPTION 'MONETARY_SUBMISSION_REFUSED' USING ERRCODE='22023';
  END IF;
  SELECT * INTO report FROM freehold.regulatory_reports WHERE id = p_report FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  IF report.state = p_state THEN
    RETURN jsonb_build_object('reportId', report.id, 'state', report.state, 'submissionStatus', report.submission_status,
      'certificationStatus', report.certification_status, 'certificationRequirement', report.certification_requirement);
  END IF;
  IF NOT (
       (report.state = 'DRAFT' AND p_state IN ('PENDING_REVIEW','REJECTED','INCOMPLETE'))
    OR (report.state = 'PENDING_REVIEW' AND p_state IN ('APPROVED_INTERNALLY','REJECTED','INCOMPLETE'))
    OR (report.state = 'APPROVED_INTERNALLY' AND p_state IN ('EXTERNAL_REVIEW_REQUIRED','REJECTED','INCOMPLETE'))
    OR (report.state = 'EXTERNAL_REVIEW_REQUIRED' AND p_state IN ('CERTIFICATION_REQUIRED','REJECTED','INCOMPLETE'))
    OR (report.state = 'CERTIFICATION_REQUIRED' AND p_state IN ('READY_FOR_AUTHORIZED_SUBMISSION','REJECTED','INCOMPLETE'))
    OR (report.state = 'READY_FOR_AUTHORIZED_SUBMISSION' AND p_state IN ('REJECTED','INCOMPLETE'))
  ) THEN
    RAISE EXCEPTION 'MONETARY_STATE' USING ERRCODE='22023';
  END IF;
  IF p_state IN ('APPROVED_INTERNALLY','EXTERNAL_REVIEW_REQUIRED','CERTIFICATION_REQUIRED','READY_FOR_AUTHORIZED_SUBMISSION')
     AND p_actor = report.created_by THEN
    RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023';
  END IF;
  requirement := CASE WHEN p_state = 'CERTIFICATION_REQUIRED' THEN 'EXTERNAL_ACCOUNTANT_REQUIRED' ELSE report.certification_requirement END;
  PERFORM set_config('freehold.monetary_writer','on',true);
  UPDATE freehold.regulatory_reports
     SET state = p_state, certification_requirement = requirement
   WHERE id = p_report;
  PERFORM freehold._monetary_audit(report.entity_id, report.book_id, 'REPORT_TRANSITION', p_actor,
    jsonb_build_object('reportId', p_report, 'from', report.state, 'to', p_state,
      'submissionStatus', 'NOT_SUBMITTED', 'certificationStatus', 'NOT_CERTIFIED', 'certificationRequirement', requirement));
  RETURN jsonb_build_object('reportId', p_report, 'state', p_state, 'submissionStatus', 'NOT_SUBMITTED',
    'certificationStatus', 'NOT_CERTIFIED', 'certificationRequirement', requirement);
END $$;

CREATE FUNCTION freehold.monetary_report_followup(p_actor uuid, p_report uuid, p_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE source freehold.regulatory_reports; rid uuid;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'FINANCIAL_RISK');
  PERFORM freehold._monetary_writes_open();
  IF p_kind NOT IN ('AMENDMENT','CORRECTION') THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO source FROM freehold.regulatory_reports WHERE id = p_report FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  IF source.state NOT IN ('READY_FOR_AUTHORIZED_SUBMISSION','REJECTED','INCOMPLETE') THEN
    RAISE EXCEPTION 'MONETARY_STATE' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM freehold.regulatory_reports
    WHERE ((p_kind = 'AMENDMENT' AND amends_report_id = p_report) OR (p_kind = 'CORRECTION' AND corrects_report_id = p_report))
      AND state NOT IN ('REJECTED','INCOMPLETE')
  ) THEN RAISE EXCEPTION 'MONETARY_DUPLICATE' USING ERRCODE='22023'; END IF;
  PERFORM set_config('freehold.monetary_writer','on',true);
  INSERT INTO freehold.regulatory_reports(
    entity_id, book_id, framework, period_start, period_end, state, submission_status,
    certification_status, external_evidence_status, body, created_by, amends_report_id, corrects_report_id)
  VALUES (
    source.entity_id, source.book_id, source.framework, source.period_start, source.period_end, 'DRAFT',
    'NOT_SUBMITTED', 'NOT_CERTIFIED', 'UNAVAILABLE',
    source.body || jsonb_build_object('followupOf', p_report, 'kind', p_kind, 'submitted', false),
    p_actor,
    CASE WHEN p_kind = 'AMENDMENT' THEN p_report ELSE NULL END,
    CASE WHEN p_kind = 'CORRECTION' THEN p_report ELSE NULL END)
  RETURNING id INTO rid;
  PERFORM freehold._monetary_audit(source.entity_id, source.book_id,
    CASE WHEN p_kind = 'AMENDMENT' THEN 'REPORT_AMENDMENT' ELSE 'REPORT_CORRECTION' END,
    p_actor, jsonb_build_object('reportId', rid, 'sourceReportId', p_report, 'state', 'DRAFT', 'submissionStatus', 'NOT_SUBMITTED'));
  RETURN jsonb_build_object('reportId', rid, 'state', 'DRAFT', 'kind', p_kind, 'sourceReportId', p_report,
    'submissionStatus', 'NOT_SUBMITTED', 'certificationStatus', 'NOT_CERTIFIED');
END $$;

CREATE OR REPLACE FUNCTION freehold.monetary_overview(p_actor uuid) RETURNS jsonb
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
    'disclosures', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'product', product_code, 'version', version, 'body', body,
      'reviewStatus', review_status, 'current', is_current)), '[]'::jsonb) FROM freehold.product_disclosures),
    'acknowledgments', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'product', product_code, 'version', version, 'acknowledgedAt', acknowledged_at)), '[]'::jsonb)
      FROM freehold.disclosure_acknowledgments WHERE user_id = p_actor),
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

CREATE FUNCTION freehold.monetary_disclosure_acknowledge(p_actor uuid, p_product text, p_version text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE disclosure freehold.product_disclosures;
BEGIN
  PERFORM freehold._require_bound_session(p_actor);
  SELECT * INTO disclosure FROM freehold.product_disclosures
  WHERE product_code = p_product AND version = p_version;
  IF NOT FOUND OR NOT disclosure.is_current OR disclosure.review_status <> 'LEGAL_REVIEW_REQUIRED' THEN
    RAISE EXCEPTION 'MONETARY_DISCLOSURE' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('freehold.monetary_writer','on',true);
  INSERT INTO freehold.disclosure_acknowledgments(user_id, product_code, version)
  VALUES (p_actor, p_product, p_version)
  ON CONFLICT (user_id, product_code, version) DO NOTHING;
  PERFORM freehold._monetary_audit(NULL, NULL, 'DISCLOSURE_ACKNOWLEDGED', p_actor,
    jsonb_build_object('product', p_product, 'version', p_version, 'reviewStatus', 'LEGAL_REVIEW_REQUIRED', 'finalDisclosure', false));
  RETURN jsonb_build_object('product', p_product, 'version', p_version, 'reviewStatus', 'LEGAL_REVIEW_REQUIRED', 'finalDisclosure', false, 'liveIssuance', false);
END $$;

CREATE FUNCTION freehold._monetary_institution_reader(p_actor uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM freehold._require_bound_session(p_actor);
  IF EXISTS (SELECT 1 FROM freehold.users WHERE id = p_actor AND role = 'ADMIN' AND status = 'ACTIVE') THEN RETURN; END IF;
  IF EXISTS (
    SELECT 1 FROM freehold.monetary_capabilities
    WHERE principal_id = p_actor AND revoked_at IS NULL
      AND capability IN ('FINANCIAL_RISK','TREASURY','INDEPENDENT_AUDIT','COMPLIANCE_OFFICER','EMERGENCY_CONTROL')
  ) THEN RETURN; END IF;
  RAISE EXCEPTION 'MONETARY_FORBIDDEN' USING ERRCODE='42501';
END $$;

CREATE FUNCTION freehold.monetary_institution_dashboard(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE fusd_outstanding bigint;
BEGIN
  PERFORM freehold._monetary_institution_reader(p_actor);
  SELECT COALESCE(sum(s.outstanding), 0) INTO fusd_outstanding
  FROM freehold.monetary_supply s
  JOIN freehold.monetary_books b ON b.id = s.book_id
  WHERE b.product_code = 'PAYMENT_STABLECOIN';
  RETURN jsonb_build_object(
    'simulationOnly', true,
    'simulatedReservesAreRealAssets', false,
    'independentVerification', 'NOT_RUN_ON_THIS_SCREEN',
    'externalReserveEvidence', CASE WHEN fusd_outstanding > 0 THEN 'EXTERNAL_EVIDENCE_UNAVAILABLE' ELSE 'NOT_REQUIRED' END,
    'books', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'code', b.code,
        'outstanding', s.outstanding::text,
        'pendingIssuance', s.pending_issuance::text,
        'pendingRedemption', s.pending_redemption::text,
        'simulatedEligibleReserves', CASE WHEN b.product_code = 'PAYMENT_STABLECOIN' THEN freehold._monetary_eligible(b.id)::text ELSE '0' END,
        'coverageGapMinor', CASE WHEN b.product_code = 'PAYMENT_STABLECOIN'
          THEN (freehold._monetary_eligible(b.id) - s.outstanding)::text ELSE '0' END,
        'issuanceCapacityMinor', (b.authorized_max_outstanding - s.outstanding - s.pending_issuance)::text,
        'redemptionSuspended', b.redemption_suspended
      ) ORDER BY b.code), '[]'::jsonb)
      FROM freehold.monetary_books b
      JOIN freehold.monetary_supply s ON s.book_id = b.id
    ),
    'maturityDistribution', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'category', category, 'bucket', bucket, 'evidenceState', evidence_state,
        'amountMinor', amount_minor, 'rowCount', row_count, 'countsAsExternalAsset', false
      )), '[]'::jsonb)
      FROM (
        SELECT r.category, r.evidence_state,
          CASE
            WHEN r.maturity_date IS NULL THEN 'NO_MATURITY'
            WHEN r.maturity_date < current_date THEN 'PAST'
            WHEN r.maturity_date <= current_date + 7 THEN 'WITHIN_7_DAYS'
            WHEN r.maturity_date <= current_date + 31 THEN 'WITHIN_31_DAYS'
            WHEN r.maturity_date <= current_date + 93 THEN 'WITHIN_93_DAYS'
            ELSE 'BEYOND_93_DAYS'
          END AS bucket,
          sum(r.valuation_minor)::text AS amount_minor,
          count(*)::text AS row_count
        FROM freehold.reserve_assets r
        GROUP BY r.category, r.evidence_state, 3
      ) grouped
    ),
    'failedSettlements', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'redemptionId', id, 'state', state, 'amountMinor', amount_minor::text, 'externalSettlement', false
      )), '[]'::jsonb)
      FROM freehold.redemption_operations WHERE state = 'FAILED'
    ),
    'reserveDeficitAlerts', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('alertId', id, 'code', code, 'acknowledged', acknowledged_at IS NOT NULL)), '[]'::jsonb)
      FROM freehold.monetary_alerts WHERE code = 'RESERVE_DEFICIT' AND acknowledged_at IS NULL
    ),
    'approvalQueue', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', kind, 'id', id, 'amountMinor', amount_minor)), '[]'::jsonb)
      FROM (
        SELECT 'ISSUANCE'::text AS kind, id, amount_minor::text AS amount_minor FROM freehold.issuance_operations WHERE state = 'PENDING_APPROVAL'
        UNION ALL
        SELECT 'CAP'::text, id, proposed_max::text FROM freehold.monetary_cap_requests WHERE state = 'PENDING'
      ) queue
    )
  );
END $$;

CREATE FUNCTION freehold.monetary_evidence_open(
  p_actor uuid, p_control text, p_citation text, p_source text, p_technical text, p_test text, p_role text, p_deficiency text, p_expires text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE rid uuid; expires timestamptz;
BEGIN
  PERFORM freehold._monetary_institution_reader(p_actor);
  PERFORM freehold._monetary_writes_open();
  IF p_control IS NULL OR length(btrim(p_control)) = 0 OR length(p_control) > 80
     OR p_citation IS NULL OR length(p_citation) > 300
     OR p_source IS NULL OR length(p_source) > 300
     OR p_technical IS NULL OR length(p_technical) > 500
     OR p_test IS NULL OR length(p_test) > 200
     OR p_role IS NULL OR length(p_role) > 80
     OR length(COALESCE(p_deficiency, '')) > 500 THEN
    RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023';
  END IF;
  IF p_expires IS NULL OR btrim(p_expires) = '' THEN
    expires := NULL;
  ELSIF p_expires ~ '^\d{4}-\d{2}-\d{2}$' THEN
    expires := p_expires::date::timestamptz;
  ELSE
    RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('freehold.monetary_writer','on',true);
  INSERT INTO freehold.institutional_evidence(
    control_id, citation, source_title, technical_control, test_ref, responsible_role, deficiency, created_by,
    technical_status, legal_status, certification_status, regulatory_status, expires_at)
  VALUES (p_control, p_citation, p_source, p_technical, p_test, p_role, COALESCE(p_deficiency, ''), p_actor,
    'NOT_RUN', 'LEGAL_REVIEW_REQUIRED', 'NOT_CERTIFIED', 'NOT_SUBMITTED', expires)
  RETURNING id INTO rid;
  PERFORM freehold._monetary_audit(NULL, NULL, 'EVIDENCE_OPENED', p_actor,
    jsonb_build_object('evidenceId', rid, 'controlId', p_control, 'technicalStatus', 'NOT_RUN', 'legalStatus', 'LEGAL_REVIEW_REQUIRED'));
  RETURN jsonb_build_object('evidenceId', rid, 'technicalStatus', 'NOT_RUN', 'legalStatus', 'LEGAL_REVIEW_REQUIRED',
    'certificationStatus', 'NOT_CERTIFIED', 'regulatoryStatus', 'NOT_SUBMITTED', 'expiresAt', expires);
END $$;

CREATE FUNCTION freehold.monetary_evidence_note(p_actor uuid, p_id uuid, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE owner uuid; nid uuid;
BEGIN
  PERFORM freehold._monetary_institution_reader(p_actor);
  PERFORM freehold._monetary_writes_open();
  SELECT created_by INTO owner FROM freehold.institutional_evidence WHERE id = p_id;
  IF owner IS NULL THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  IF owner = p_actor THEN RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023'; END IF;
  IF p_note IS NULL OR length(btrim(p_note)) = 0 OR length(p_note) > 500 THEN
    RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('freehold.monetary_writer','on',true);
  INSERT INTO freehold.institutional_evidence_reviews(evidence_id, reviewer_id, note)
  VALUES (p_id, p_actor, p_note) RETURNING id INTO nid;
  PERFORM freehold._monetary_audit(NULL, NULL, 'EVIDENCE_REVIEW', p_actor, jsonb_build_object('evidenceId', p_id, 'reviewId', nid));
  RETURN jsonb_build_object('reviewId', nid, 'evidenceId', p_id, 'changedStatus', false);
END $$;

CREATE FUNCTION freehold.monetary_evidence_export(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
  PERFORM freehold._monetary_institution_reader(p_actor);
  RETURN jsonb_build_object(
    'determination', 'NOT_A_COMPLIANCE_DETERMINATION',
    'items', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'evidenceId', e.id, 'controlId', e.control_id, 'citation', e.citation, 'sourceTitle', e.source_title,
        'technicalControl', e.technical_control, 'testRef', e.test_ref, 'responsibleRole', e.responsible_role,
        'technicalStatus', e.technical_status, 'legalStatus', e.legal_status,
        'certificationStatus', e.certification_status, 'regulatoryStatus', e.regulatory_status,
        'expiresAt', e.expires_at, 'deficiency', e.deficiency,
        'reviews', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object('reviewId', r.id, 'recordedAt', r.recorded_at) ORDER BY r.recorded_at), '[]'::jsonb)
          FROM freehold.institutional_evidence_reviews r WHERE r.evidence_id = e.id
        )
      ) ORDER BY e.created_at), '[]'::jsonb)
      FROM freehold.institutional_evidence e
    )
  );
END $$;

CREATE FUNCTION freehold.monetary_partner_open(p_actor uuid, p_name text, p_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE pid uuid; item text;
BEGIN
  PERFORM freehold._monetary_institution_reader(p_actor);
  PERFORM freehold._monetary_writes_open();
  IF p_name IS NULL OR length(btrim(p_name)) < 3 OR length(p_name) > 160
     OR p_kind NOT IN ('PROSPECTIVE_BANK','PROSPECTIVE_CUSTODIAN','PROSPECTIVE_ISSUER') THEN
    RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('freehold.monetary_writer','on',true);
  INSERT INTO freehold.institutional_partners(
    legal_name, entity_kind, charter_status, relationship_status, settlement_capability, custody_capability,
    integration_status, external_evidence, compliance_responsibility, escalation_contact, created_by)
  VALUES (p_name, p_kind, 'UNVERIFIED', 'UNVERIFIED', 'NOT_ENABLED', 'NOT_ENABLED', 'NOT_STARTED', 'UNAVAILABLE',
    'Not assigned. A checklist entry is not a compliance program.', 'Not appointed.', p_actor)
  RETURNING id INTO pid;
  FOREACH item IN ARRAY ARRAY['IDENTITY','LICENSE_OR_CHARTER','SERVICE_AGREEMENT','DUE_DILIGENCE','PRODUCTS','SETTLEMENT','CUSTODY','CONTACTS','COMPLIANCE','EXPIRATION','ESCALATION','INTEGRATION'] LOOP
    INSERT INTO freehold.institutional_partner_checks(partner_id, item_code, state) VALUES (pid, item, 'OPEN');
  END LOOP;
  PERFORM freehold._monetary_audit(NULL, NULL, 'PARTNER_OPENED', p_actor,
    jsonb_build_object('partnerId', pid, 'relationshipStatus', 'UNVERIFIED', 'externalEvidence', 'UNAVAILABLE'));
  RETURN jsonb_build_object('partnerId', pid, 'relationshipStatus', 'UNVERIFIED', 'charterStatus', 'UNVERIFIED',
    'externalEvidence', 'UNAVAILABLE', 'settlementCapability', 'NOT_ENABLED', 'custodyCapability', 'NOT_ENABLED');
END $$;

CREATE FUNCTION freehold.monetary_partner_check(p_actor uuid, p_partner uuid, p_item text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE status text;
BEGIN
  PERFORM freehold._monetary_institution_reader(p_actor);
  PERFORM freehold._monetary_writes_open();
  SELECT relationship_status INTO status FROM freehold.institutional_partners WHERE id = p_partner;
  IF status IS NULL THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  IF status <> 'UNVERIFIED' THEN RAISE EXCEPTION 'MONETARY_PARTNER_UNVERIFIED' USING ERRCODE='22023'; END IF;
  PERFORM set_config('freehold.monetary_writer','on',true);
  UPDATE freehold.institutional_partner_checks
     SET state = 'RECORDED_NOT_VERIFIED', recorded_by = p_actor
   WHERE partner_id = p_partner AND item_code = p_item AND state = 'OPEN';
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_STATE' USING ERRCODE='22023'; END IF;
  PERFORM freehold._monetary_audit(NULL, NULL, 'PARTNER_CHECK_RECORDED', p_actor,
    jsonb_build_object('partnerId', p_partner, 'item', p_item, 'relationshipStatus', 'UNVERIFIED', 'verified', false));
  RETURN jsonb_build_object('partnerId', p_partner, 'item', p_item, 'checkState', 'RECORDED_NOT_VERIFIED', 'relationshipStatus', 'UNVERIFIED');
END $$;

CREATE FUNCTION freehold.monetary_partner_list(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
  PERFORM freehold._monetary_institution_reader(p_actor);
  RETURN jsonb_build_object(
    'partners', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'partnerId', p.id, 'legalName', p.legal_name, 'entityKind', p.entity_kind,
        'charterStatus', p.charter_status, 'relationshipStatus', p.relationship_status,
        'settlementCapability', p.settlement_capability, 'custodyCapability', p.custody_capability,
        'integrationStatus', p.integration_status, 'externalEvidence', p.external_evidence,
        'agreementExpiresOn', p.agreement_expires_on, 'complianceResponsibility', p.compliance_responsibility,
        'escalationContact', p.escalation_contact,
        'checks', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object('item', c.item_code, 'state', c.state) ORDER BY c.item_code), '[]'::jsonb)
          FROM freehold.institutional_partner_checks c WHERE c.partner_id = p.id
        )
      ) ORDER BY p.created_at), '[]'::jsonb)
      FROM freehold.institutional_partners p
    )
  );
END $$;

REVOKE ALL ON FUNCTION freehold.monetary_expire_approval(uuid, uuid) FROM PUBLIC, freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold.monetary_report_followup(uuid, uuid, text) FROM PUBLIC, freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold._monetary_institution_reader(uuid) FROM PUBLIC, freehold_api, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold.monetary_disclosure_acknowledge(uuid, text, text) FROM PUBLIC, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold.monetary_institution_dashboard(uuid) FROM PUBLIC, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold.monetary_evidence_open(uuid, text, text, text, text, text, text, text, text) FROM PUBLIC, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold.monetary_evidence_note(uuid, uuid, text) FROM PUBLIC, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold.monetary_evidence_export(uuid) FROM PUBLIC, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold.monetary_partner_open(uuid, text, text) FROM PUBLIC, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold.monetary_partner_check(uuid, uuid, text) FROM PUBLIC, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
REVOKE ALL ON FUNCTION freehold.monetary_partner_list(uuid) FROM PUBLIC, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;

GRANT EXECUTE ON FUNCTION freehold.monetary_disclosure_acknowledge(uuid, text, text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_institution_dashboard(uuid) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_evidence_open(uuid, text, text, text, text, text, text, text, text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_evidence_note(uuid, uuid, text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_evidence_export(uuid) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_partner_open(uuid, text, text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_partner_check(uuid, uuid, text) TO freehold_api;
GRANT EXECUTE ON FUNCTION freehold.monetary_partner_list(uuid) TO freehold_api;

RESET ROLE;
