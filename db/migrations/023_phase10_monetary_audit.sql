-- Phase 10 follow-up. Forward only. Migration 022 is not edited.
-- A failed issuance, an unknown outcome, a cap change, a freeze, a refused
-- conversion, an experimental issue, and a report draft or transition write
-- an audit row. Report review cannot skip a step. Submission stays refused.
-- Customer activity is the caller's own rows. Live issuance stays impossible.
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;

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

CREATE OR REPLACE FUNCTION freehold.monetary_issue_mark_unknown(p_actor uuid, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE op freehold.issuance_operations; b freehold.monetary_books;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'ISSUANCE_AUTHORITY');
  SELECT * INTO op FROM freehold.issuance_operations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  b := freehold._monetary_lock(op.book_id);
  IF op.state = 'UNKNOWN' THEN RETURN freehold._issue_json(op); END IF;
  IF op.state NOT IN ('APPROVED','EXECUTING','PENDING_APPROVAL') THEN
    RAISE EXCEPTION 'MONETARY_STATE' USING ERRCODE='22023';
  END IF;
  UPDATE freehold.issuance_operations SET state = 'UNKNOWN', unknown_marked_by = p_actor WHERE id = op.id;
  SELECT * INTO op FROM freehold.issuance_operations WHERE id = p_id;
  PERFORM freehold._monetary_audit(b.entity_id, op.book_id, 'ISSUE_UNKNOWN', p_actor, freehold._issue_json(op));
  RETURN freehold._issue_json(op);
END $$;

CREATE OR REPLACE FUNCTION freehold.monetary_issue_resolve_unknown(p_actor uuid, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE op freehold.issuance_operations; b freehold.monetary_books;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'ISSUANCE_AUTHORITY');
  SELECT * INTO op FROM freehold.issuance_operations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  b := freehold._monetary_lock(op.book_id);
  IF op.state <> 'UNKNOWN' THEN RETURN freehold._issue_json(op); END IF;
  IF p_actor IS NOT DISTINCT FROM op.unknown_marked_by THEN RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023'; END IF;
  IF op.journal_id IS NOT NULL THEN
    UPDATE freehold.issuance_operations SET state = 'ISSUED' WHERE id = op.id;
  ELSE
    UPDATE freehold.issuance_operations SET state = 'FAILED' WHERE id = op.id;
  END IF;
  PERFORM freehold._monetary_recompute(op.book_id);
  SELECT * INTO op FROM freehold.issuance_operations WHERE id = p_id;
  PERFORM freehold._monetary_audit(b.entity_id, op.book_id, 'ISSUE_RESOLVE_UNKNOWN', p_actor, freehold._issue_json(op));
  RETURN freehold._issue_json(op);
END $$;

CREATE OR REPLACE FUNCTION freehold.monetary_redeem_mark_unknown(p_actor uuid, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE op freehold.redemption_operations; b freehold.monetary_books;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'REDEMPTION_AUTHORITY');
  SELECT * INTO op FROM freehold.redemption_operations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  b := freehold._monetary_lock(op.book_id);
  IF op.state = 'UNKNOWN' THEN RETURN freehold._redeem_json(op); END IF;
  IF op.state NOT IN ('UNITS_SECURED','PENDING_SETTLEMENT','SETTLEMENT_CONFIRMED') THEN
    RAISE EXCEPTION 'MONETARY_STATE' USING ERRCODE='22023';
  END IF;
  UPDATE freehold.redemption_operations SET state = 'UNKNOWN', unknown_marked_by = p_actor WHERE id = op.id;
  SELECT * INTO op FROM freehold.redemption_operations WHERE id = p_id;
  PERFORM freehold._monetary_audit(b.entity_id, op.book_id, 'REDEEM_UNKNOWN', p_actor, freehold._redeem_json(op));
  RETURN freehold._redeem_json(op);
END $$;

CREATE OR REPLACE FUNCTION freehold.monetary_redeem_resolve_unknown(p_actor uuid, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE op freehold.redemption_operations; b freehold.monetary_books;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'REDEMPTION_AUTHORITY');
  SELECT * INTO op FROM freehold.redemption_operations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  b := freehold._monetary_lock(op.book_id);
  IF op.state <> 'UNKNOWN' THEN RETURN freehold._redeem_json(op); END IF;
  IF p_actor IS NOT DISTINCT FROM op.unknown_marked_by THEN RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023'; END IF;
  IF op.journal_id IS NOT NULL THEN
    UPDATE freehold.redemption_operations SET state = 'REDEEMED' WHERE id = op.id;
  ELSE
    UPDATE freehold.redemption_operations SET state = 'EXCEPTION' WHERE id = op.id;
  END IF;
  PERFORM freehold._monetary_recompute(op.book_id);
  SELECT * INTO op FROM freehold.redemption_operations WHERE id = p_id;
  PERFORM freehold._monetary_audit(b.entity_id, op.book_id, 'REDEEM_RESOLVE_UNKNOWN', p_actor, freehold._redeem_json(op));
  RETURN freehold._redeem_json(op);
END $$;

CREATE OR REPLACE FUNCTION freehold.monetary_cap_request(p_actor uuid, p_book uuid, p_max bigint, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE existing freehold.monetary_cap_requests; rid uuid; b freehold.monetary_books;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'GOVERNANCE_POLICY');
  b := freehold._monetary_lock(p_book);
  SELECT * INTO existing FROM freehold.monetary_cap_requests WHERE book_id = p_book AND idempotency_key = p_key;
  IF FOUND THEN
    RETURN jsonb_build_object('requestId', existing.id, 'state', existing.state);
  END IF;
  INSERT INTO freehold.monetary_cap_requests(book_id, idempotency_key, requester_id, proposed_max, state)
  VALUES (p_book, p_key, p_actor, p_max, 'PENDING') RETURNING id INTO rid;
  PERFORM freehold._monetary_audit(b.entity_id, p_book, 'CAP_REQUEST', p_actor,
    jsonb_build_object('requestId', rid, 'proposedMax', p_max::text));
  RETURN jsonb_build_object('requestId', rid, 'state', 'PENDING');
END $$;

CREATE OR REPLACE FUNCTION freehold.monetary_cap_approve(p_actor uuid, p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE req freehold.monetary_cap_requests; supply freehold.monetary_supply; b freehold.monetary_books;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'FINANCIAL_RISK');
  SELECT * INTO req FROM freehold.monetary_cap_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  b := freehold._monetary_lock(req.book_id);
  IF req.state = 'APPROVED' THEN RETURN jsonb_build_object('requestId', req.id, 'state', 'APPROVED'); END IF;
  IF p_actor = req.requester_id THEN RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023'; END IF;
  SELECT * INTO supply FROM freehold.monetary_supply WHERE book_id = req.book_id;
  IF req.proposed_max < supply.outstanding + supply.pending_issuance THEN
    RAISE EXCEPTION 'MONETARY_CAP' USING ERRCODE='22023';
  END IF;
  UPDATE freehold.monetary_books SET authorized_max_outstanding = req.proposed_max WHERE id = req.book_id;
  UPDATE freehold.monetary_cap_requests SET state = 'APPROVED', approver_id = p_actor WHERE id = req.id;
  PERFORM freehold._monetary_audit(b.entity_id, req.book_id, 'CAP_APPROVE', p_actor,
    jsonb_build_object('requestId', req.id, 'authorizedMaxOutstanding', req.proposed_max::text));
  RETURN jsonb_build_object('requestId', req.id, 'state', 'APPROVED', 'authorizedMaxOutstanding', req.proposed_max::text);
END $$;

CREATE OR REPLACE FUNCTION freehold.monetary_report_draft(p_actor uuid, p_book uuid, p_start date, p_end date) RETURNS jsonb
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
  PERFORM freehold._monetary_audit(b.entity_id, p_book, 'REPORT_DRAFT', p_actor,
    jsonb_build_object('reportId', rid, 'state', 'DRAFT', 'submissionStatus', 'NOT_SUBMITTED'));
  RETURN jsonb_build_object('reportId', rid, 'state', 'DRAFT', 'certificationStatus', 'NOT_CERTIFIED', 'submissionStatus', 'NOT_SUBMITTED', 'body', body);
END $$;

CREATE OR REPLACE FUNCTION freehold.monetary_report_transition(p_actor uuid, p_report uuid, p_state text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE report freehold.regulatory_reports;
BEGIN
  PERFORM freehold._monetary_capability(p_actor, 'FINANCIAL_RISK');
  IF p_state = 'SUBMITTED_WITH_EVIDENCE' THEN
    RAISE EXCEPTION 'MONETARY_SUBMISSION_REFUSED' USING ERRCODE='22023';
  END IF;
  SELECT * INTO report FROM freehold.regulatory_reports WHERE id = p_report FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MONETARY_INVALID' USING ERRCODE='22023'; END IF;
  IF report.state = p_state THEN
    RETURN jsonb_build_object('reportId', report.id, 'state', report.state, 'submissionStatus', report.submission_status, 'certificationStatus', report.certification_status);
  END IF;
  IF NOT (
       (report.state = 'DRAFT' AND p_state IN ('PENDING_REVIEW','REJECTED','INCOMPLETE'))
    OR (report.state = 'PENDING_REVIEW' AND p_state IN ('APPROVED_INTERNALLY','REJECTED','INCOMPLETE'))
    OR (report.state = 'APPROVED_INTERNALLY' AND p_state IN ('EXTERNAL_REVIEW_REQUIRED','REJECTED','INCOMPLETE'))
    OR (report.state = 'EXTERNAL_REVIEW_REQUIRED' AND p_state IN ('READY_FOR_AUTHORIZED_SUBMISSION','REJECTED','INCOMPLETE'))
    OR (report.state = 'READY_FOR_AUTHORIZED_SUBMISSION' AND p_state IN ('REJECTED','INCOMPLETE'))
  ) THEN
    RAISE EXCEPTION 'MONETARY_STATE' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('freehold.monetary_writer','on',true);
  UPDATE freehold.regulatory_reports SET state = p_state WHERE id = p_report;
  PERFORM freehold._monetary_audit(report.entity_id, report.book_id, 'REPORT_TRANSITION', p_actor,
    jsonb_build_object('reportId', p_report, 'from', report.state, 'to', p_state, 'submissionStatus', 'NOT_SUBMITTED'));
  RETURN jsonb_build_object('reportId', p_report, 'state', p_state, 'submissionStatus', 'NOT_SUBMITTED', 'certificationStatus', 'NOT_CERTIFIED');
END $$;

CREATE OR REPLACE FUNCTION freehold.monetary_fhu_issue(p_actor uuid, p_amount bigint, p_holder uuid, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE book uuid := '20000000-0000-4000-8000-000000000002';
  fusd uuid := '20000000-0000-4000-8000-000000000001';
  sandbox uuid := '10000000-0000-4000-8000-000000000005';
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
  PERFORM freehold._monetary_audit(sandbox, book, 'FHU_ISSUE', p_actor,
    jsonb_build_object('issuanceId', row_id, 'valueClaim', false, 'amountMinor', p_amount::text));
  RETURN jsonb_build_object('issuanceId', row_id, 'state', 'ISSUED', 'unit', 'FHU', 'valueClaim', false, 'fusdOutstanding', fusd_after::text);
END $$;

CREATE OR REPLACE FUNCTION freehold.monetary_conversion_request(p_actor uuid, p_account uuid, p_amount bigint, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE owner uuid; available bigint; existing freehold.conversion_requests;
BEGIN
  PERFORM freehold._require_bound_session(p_actor);
  SELECT * INTO existing FROM freehold.conversion_requests WHERE idempotency_key = p_key;
  IF FOUND THEN
    RETURN jsonb_build_object('state', existing.state, 'reason', existing.reason, 'availableMinor', existing.available_after::text, 'fusdCredited', '0');
  END IF;
  SELECT owner_user_id, available_minor INTO owner, available FROM freehold.accounts WHERE id = p_account;
  IF owner IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'MONETARY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  PERFORM set_config('freehold.monetary_writer','on',true);
  INSERT INTO freehold.conversion_requests(actor_id, account_id, amount_minor, state, reason, idempotency_key, available_before, available_after)
  VALUES (p_actor, p_account, p_amount, 'REJECTED', 'UNBACKED_CONVERSION_REFUSED', p_key, available, available);
  PERFORM freehold._monetary_audit('10000000-0000-4000-8000-000000000001', NULL, 'CONVERSION_REFUSED', p_actor,
    jsonb_build_object('accountId', p_account, 'amountMinor', p_amount::text, 'fusdCredited', '0'));
  RETURN jsonb_build_object('state', 'REJECTED', 'reason', 'UNBACKED_CONVERSION_REFUSED', 'availableMinor', available::text, 'fusdCredited', '0');
END $$;

CREATE OR REPLACE FUNCTION freehold.monetary_freeze_units(p_actor uuid, p_book uuid, p_holder uuid, p_amount bigint, p_freeze boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE b freehold.monetary_books;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM freehold.monetary_capabilities
    WHERE principal_id = p_actor AND capability IN ('COMPLIANCE_OFFICER','EMERGENCY_CONTROL') AND revoked_at IS NULL
  ) THEN RAISE EXCEPTION 'MONETARY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  PERFORM freehold._require_bound_session(p_actor);
  IF p_actor = p_holder THEN RAISE EXCEPTION 'MONETARY_SELF_APPROVAL' USING ERRCODE='22023'; END IF;
  b := freehold._monetary_lock(p_book);
  IF p_freeze THEN
    PERFORM freehold._monetary_holder_add(p_book, 'CUSTOMER', p_holder, -p_amount);
    PERFORM freehold._monetary_holder_add(p_book, 'FROZEN', p_holder, p_amount);
  ELSE
    PERFORM freehold._monetary_holder_add(p_book, 'FROZEN', p_holder, -p_amount);
    PERFORM freehold._monetary_holder_add(p_book, 'CUSTOMER', p_holder, p_amount);
  END IF;
  PERFORM freehold._monetary_recompute(p_book);
  PERFORM freehold._monetary_audit(b.entity_id, p_book, CASE WHEN p_freeze THEN 'FREEZE_UNITS' ELSE 'UNFREEZE_UNITS' END, p_actor,
    jsonb_build_object('holder', p_holder, 'amountMinor', p_amount::text));
  RETURN jsonb_build_object('frozen', p_freeze, 'amountMinor', p_amount::text);
END $$;

CREATE FUNCTION freehold.monetary_customer_activity(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
  PERFORM freehold._require_bound_session(p_actor);
  RETURN jsonb_build_object(
    'simulationOnly', true,
    'redemptionPolicy', 'NOT_OFFERED',
    'fees', jsonb_build_object('conversionFeeMinor', '0', 'redemptionFeeMinor', '0', 'charged', false),
    'holdings', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'book', b.code, 'unit', b.unit_code, 'kind', h.holder_kind, 'units', h.units::text
      ) ORDER BY b.code, h.holder_kind), '[]'::jsonb)
      FROM freehold.monetary_holders h
      JOIN freehold.monetary_books b ON b.id = h.book_id
      WHERE h.holder_ref = p_actor
    ),
    'issuance', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'issuanceId', o.id, 'book', b.code, 'state', o.state, 'amountMinor', o.amount_minor::text, 'simulationOnly', true
      ) ORDER BY o.created_at, o.id), '[]'::jsonb)
      FROM freehold.issuance_operations o
      JOIN freehold.monetary_books b ON b.id = o.book_id
      WHERE o.holder_ref = p_actor
    ),
    'redemptions', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'redemptionId', r.id, 'book', b.code, 'state', r.state, 'amountMinor', r.amount_minor::text, 'externalSettlement', false
      ) ORDER BY r.created_at, r.id), '[]'::jsonb)
      FROM freehold.redemption_operations r
      JOIN freehold.monetary_books b ON b.id = r.book_id
      WHERE r.requester_id = p_actor OR r.holder_ref = p_actor
    )
  );
END $$;

REVOKE ALL ON FUNCTION freehold.monetary_customer_activity(uuid) FROM PUBLIC, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
GRANT EXECUTE ON FUNCTION freehold.monetary_customer_activity(uuid) TO freehold_api;

RESET ROLE;
