import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { verifyLedger } from '../scripts/lib/ledger-verifier.mjs';

const FUSD = '20000000-0000-4000-8000-000000000001';
const FHU = '20000000-0000-4000-8000-000000000002';
const ISSUER = '10000000-0000-4000-8000-000000000003';
const admin = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
const admin2 = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
const api = new Client({ connectionString: process.env.DATABASE_URL });
const verifier = new Client({ connectionString: process.env.VERIFY_DATABASE_URL });

const item = async (client, sql, params = []) => (await client.query(sql, params)).rows[0].item;
const expectMessage = async (fn, message) => {
  await assert.rejects(fn, error => {
    assert.equal(error.message, message, `${error.code ?? ''} ${error.message}`);
    return true;
  });
};
const auditCount = async (action, fragment = null) => (await admin.query(
  `SELECT count(*)::int AS n FROM freehold.monetary_audit WHERE action = $1 AND ($2::text IS NULL OR detail::text LIKE '%' || $2 || '%')`,
  [action, fragment],
)).rows[0].n;

async function identity(book) {
  const row = (await admin.query(`
    WITH i AS (
      SELECT COALESCE(sum(amount_minor) FILTER (WHERE state = 'ISSUED'),0) AS issued,
             COALESCE(sum(amount_minor) FILTER (WHERE state IN ('REQUESTED','PENDING_RESERVE_VERIFICATION','PENDING_APPROVAL','APPROVED','EXECUTING','UNKNOWN')),0) AS pending_i
      FROM freehold.issuance_operations WHERE book_id = $1
    ), r AS (
      SELECT COALESCE(sum(amount_minor) FILTER (WHERE state = 'REDEEMED'),0) AS redeemed,
             COALESCE(sum(amount_minor) FILTER (WHERE state IN ('REQUESTED','VALIDATING','UNITS_SECURED','PENDING_SETTLEMENT','SETTLEMENT_CONFIRMED','EXCEPTION','UNKNOWN')),0) AS pending_r
      FROM freehold.redemption_operations WHERE book_id = $1
    ), h AS (
      SELECT COALESCE(sum(units) FILTER (WHERE holder_kind = 'CUSTOMER'),0) AS customer,
             COALESCE(sum(units) FILTER (WHERE holder_kind = 'TREASURY'),0) AS treasury,
             COALESCE(sum(units) FILTER (WHERE holder_kind = 'FROZEN'),0) AS frozen,
             COALESCE(sum(units) FILTER (WHERE holder_kind = 'PENDING_REDEMPTION'),0) AS pending_h
      FROM freehold.monetary_holders WHERE book_id = $1
    ), c AS (SELECT COALESCE(sum(amount_minor),0) AS corrections FROM freehold.supply_corrections WHERE book_id = $1)
    SELECT s.outstanding::text, (i.issued - r.redeemed + c.corrections)::text AS reconstructed,
           (h.customer + h.treasury + h.frozen + h.pending_h)::text AS holders,
           s.pending_issuance::text, i.pending_i::text, s.pending_redemption::text, r.pending_r::text, h.pending_h::text
    FROM freehold.monetary_supply s, i, r, h, c WHERE s.book_id = $1`, [book])).rows[0];
  assert.equal(row.outstanding, row.reconstructed, book);
  assert.equal(row.outstanding, row.holders, book);
  assert.equal(row.pending_issuance, row.pending_i, book);
  assert.equal(row.pending_redemption, row.pending_r, book);
  assert.equal(row.pending_h, row.pending_r, book);
  return row.outstanding;
}

test('phase 11 keeps audit, approval, disclosure, and recovery evidence durable', async () => {
  await Promise.all([admin.connect(), admin2.connect(), api.connect(), verifier.connect()]);
  const names = ['holder', 'requester', 'treasury', 'approver', 'executor', 'risk', 'policy', 'emergency1', 'emergency2', 'redeemer', 'redeemer2', 'compliance', 'proposer', 'outsider', 'adminReader', 'blocked'];
  const ids = Object.fromEntries(names.map(name => [name, randomUUID()]));
  const account = randomUUID();
  const hash = 'phase11-unused-password-hash';
  const key = () => `p11-${randomUUID()}`;
  const journalsBefore = (await admin.query('SELECT count(*)::int AS n FROM freehold.ledger_journals')).rows[0].n;
  const availableBefore = (await admin.query('SELECT COALESCE(sum(available_minor),0)::text AS n FROM freehold.accounts')).rows[0].n;
  try {
    const values = names.flatMap(name => [ids[name], `p11-${name.toLowerCase()}-${ids[name]}@example.test`]);
    const placeholders = names.map((_, index) => `($${index * 2 + 1},$${index * 2 + 2},$${names.length * 2 + 1},$${names.length * 2 + 2 + index})`).join(',');
    const roles = names.map(name => name === 'adminReader' ? 'ADMIN' : 'USER');
    await admin.query(
      `INSERT INTO freehold.users(id,email_normalized,password_hash,role) VALUES ${placeholders}`,
      [...values, hash, ...roles],
    );
    const caps = [
      [ids.requester, 'ISSUANCE_AUTHORITY'], [ids.approver, 'ISSUANCE_AUTHORITY'], [ids.executor, 'ISSUANCE_AUTHORITY'],
      [ids.treasury, 'TREASURY'], [ids.treasury, 'ISSUANCE_AUTHORITY'],
      [ids.risk, 'FINANCIAL_RISK'], [ids.policy, 'GOVERNANCE_POLICY'], [ids.policy, 'FINANCIAL_RISK'],
      [ids.emergency1, 'EMERGENCY_CONTROL'], [ids.emergency2, 'EMERGENCY_CONTROL'],
      [ids.redeemer, 'REDEMPTION_AUTHORITY'], [ids.redeemer2, 'REDEMPTION_AUTHORITY'],
      [ids.compliance, 'COMPLIANCE_OFFICER'], [ids.proposer, 'RESERVE_MANAGEMENT'],
      [ids.executor, 'SECURITY_ADMIN'],
    ];
    for (const [principal, capability] of caps) await admin.query('SELECT freehold.monetary_bootstrap_capability($1,$2)', [principal, capability]);
    await admin.query(`INSERT INTO freehold.accounts(id,owner_user_id,currency_code) VALUES ($1,$2,'USD')`, [account, ids.holder]);

    await expectMessage(() => admin.query(`SELECT freehold.monetary_disclosure_acknowledge($1,'PAYMENT_STABLECOIN','phase10-1')`, [ids.holder]), 'MONETARY_DISCLOSURE');
    await expectMessage(() => admin.query('SELECT freehold.monetary_issue_request($1,$2,10,$3,$4)', [ids.requester, FUSD, ids.holder, key()]), 'MONETARY_DISCLOSURE');
    await item(admin, `SELECT freehold.monetary_restriction_set($1,$2,'BLOCK_SIMULATED_ISSUANCE',$3) AS item`, [ids.compliance, ids.blocked, 'phase11 block']);
    await expectMessage(() => admin.query('SELECT freehold.monetary_issue_request($1,$2,10,$3,$4)', [ids.requester, FUSD, ids.blocked, key()]), 'MONETARY_RESTRICTED');
    const ack = await item(admin, `SELECT freehold.monetary_disclosure_acknowledge($1,'PAYMENT_STABLECOIN','phase11-draft') AS item`, [ids.holder]);
    assert.equal(ack.finalDisclosure, false);
    assert.equal(ack.reviewStatus, 'LEGAL_REVIEW_REQUIRED');
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM freehold.disclosure_acknowledgments WHERE user_id = $1`, [ids.holder])).rows[0].n, 1);
    await item(admin, `SELECT freehold.monetary_disclosure_acknowledge($1,'PAYMENT_STABLECOIN','phase11-draft') AS item`, [ids.holder]);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM freehold.disclosure_acknowledgments WHERE user_id = $1`, [ids.holder])).rows[0].n, 1);

    const duplicateKey = key();
    const firstRequest = await item(admin, 'SELECT freehold.monetary_issue_request($1,$2,15,NULL,$3) AS item', [ids.requester, FUSD, duplicateKey]);
    const replayedRequest = await item(admin, 'SELECT freehold.monetary_issue_request($1,$2,15,NULL,$3) AS item', [ids.requester, FUSD, duplicateKey]);
    assert.equal(replayedRequest.issuanceId, firstRequest.issuanceId);
    assert.equal(await auditCount('DUPLICATE_ISSUE_REQUEST', firstRequest.issuanceId), 1);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.issuance_operations WHERE idempotency_key = $1', [duplicateKey])).rows[0].n, 1);
    await item(admin, 'SELECT freehold.monetary_issue_verify($1,$2) AS item', [ids.treasury, firstRequest.issuanceId]);
    await item(admin, 'SELECT freehold.monetary_issue_approve($1,$2) AS item', [ids.approver, firstRequest.issuanceId]);
    const approveAudits = await auditCount('ISSUE_APPROVE', firstRequest.issuanceId);
    const approveReplay = await item(admin, 'SELECT freehold.monetary_issue_approve($1,$2) AS item', [ids.executor, firstRequest.issuanceId]);
    assert.equal(approveReplay.state, 'APPROVED');
    assert.equal(await auditCount('ISSUE_APPROVE', firstRequest.issuanceId), approveAudits);

    await admin.query('BEGIN');
    await admin.query(`SELECT set_config('freehold.monetary_writer','on',true)`);
    await admin.query(`UPDATE freehold.issuance_operations SET approved_until = clock_timestamp() - interval '1 minute' WHERE id = $1`, [firstRequest.issuanceId]);
    await admin.query('COMMIT');
    const monetaryJournals = (await admin.query('SELECT count(*)::int AS n FROM freehold.monetary_journals')).rows[0].n;
    const outstandingBeforeExpiry = await identity(FUSD);
    const expired = await item(admin, 'SELECT freehold.monetary_issue_execute($1,$2) AS item', [ids.executor, firstRequest.issuanceId]);
    assert.equal(expired.state, 'EXPIRED');
    assert.equal(await auditCount('APPROVAL_EXPIRED', firstRequest.issuanceId), 1);
    assert.equal(await auditCount('ISSUE_EXECUTE', firstRequest.issuanceId), 0);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.monetary_journals')).rows[0].n, monetaryJournals);
    assert.equal(await identity(FUSD), outstandingBeforeExpiry);

    const expireTarget = await item(admin, 'SELECT freehold.monetary_issue_request($1,$2,11,NULL,$3) AS item', [ids.requester, FUSD, key()]);
    await item(admin, 'SELECT freehold.monetary_issue_verify($1,$2) AS item', [ids.treasury, expireTarget.issuanceId]);
    await item(admin, 'SELECT freehold.monetary_issue_approve($1,$2) AS item', [ids.approver, expireTarget.issuanceId]);
    await admin.query('BEGIN');
    await admin.query(`SELECT set_config('freehold.monetary_writer','on',true)`);
    await admin.query(`UPDATE freehold.issuance_operations SET approved_until = clock_timestamp() - interval '1 minute' WHERE id = $1`, [expireTarget.issuanceId]);
    await admin.query('COMMIT');
    const expiredByFunction = await item(admin, 'SELECT freehold.monetary_expire_approval($1,$2) AS item', [ids.executor, expireTarget.issuanceId]);
    assert.equal(expiredByFunction.state, 'EXPIRED');
    await expectMessage(() => admin.query('SELECT freehold.monetary_issue_execute($1,$2)', [ids.executor, expireTarget.issuanceId]), 'MONETARY_STATE');
    await expectMessage(() => api.query('SELECT freehold.monetary_expire_approval($1,$2)', [ids.executor, expireTarget.issuanceId]), 'permission denied for function monetary_expire_approval');

    const unknownIssue = await item(admin, 'SELECT freehold.monetary_issue_request($1,$2,12,NULL,$3) AS item', [ids.requester, FUSD, key()]);
    await item(admin, 'SELECT freehold.monetary_issue_verify($1,$2) AS item', [ids.treasury, unknownIssue.issuanceId]);
    await item(admin, 'SELECT freehold.monetary_issue_approve($1,$2) AS item', [ids.approver, unknownIssue.issuanceId]);
    const marked = await item(admin, 'SELECT freehold.monetary_issue_mark_unknown($1,$2) AS item', [ids.executor, unknownIssue.issuanceId]);
    assert.equal(marked.state, 'UNKNOWN');
    assert.equal(await auditCount('ISSUE_UNKNOWN', unknownIssue.issuanceId), 1);
    const markedAgain = await item(admin, 'SELECT freehold.monetary_issue_mark_unknown($1,$2) AS item', [ids.executor, unknownIssue.issuanceId]);
    assert.equal(markedAgain.state, 'UNKNOWN');
    assert.equal(await auditCount('ISSUE_UNKNOWN', unknownIssue.issuanceId), 1);
    const resolvedIssue = await item(admin, 'SELECT freehold.monetary_issue_resolve_unknown($1,$2) AS item', [ids.approver, unknownIssue.issuanceId]);
    assert.equal(resolvedIssue.state, 'FAILED');
    assert.equal(await auditCount('ISSUE_RESOLVE_UNKNOWN', unknownIssue.issuanceId), 1);
    assert.equal(await auditCount('ISSUE_EXECUTE', unknownIssue.issuanceId), 0);

    const issued = await item(admin, 'SELECT freehold.monetary_issue_request($1,$2,500,$3,$4) AS item', [ids.requester, FUSD, ids.holder, key()]);
    await item(admin, 'SELECT freehold.monetary_issue_verify($1,$2) AS item', [ids.treasury, issued.issuanceId]);
    await item(admin, 'SELECT freehold.monetary_issue_approve($1,$2) AS item', [ids.approver, issued.issuanceId]);
    const posted = await item(admin, 'SELECT freehold.monetary_issue_execute($1,$2) AS item', [ids.executor, issued.issuanceId]);
    assert.equal(posted.state, 'ISSUED');
    assert.equal(await auditCount('ISSUE_EXECUTE', issued.issuanceId), 1);
    const held = async () => (await admin.query(`SELECT COALESCE(units,0)::text AS n FROM freehold.monetary_holders WHERE book_id = $1 AND holder_kind = 'CUSTOMER' AND holder_ref = $2`, [FUSD, ids.holder])).rows[0].n;
    assert.equal(await held(), '500');

    const redeemKey = key();
    const redeem = await item(admin, 'SELECT freehold.monetary_redeem_request($1,$2,100,$3) AS item', [ids.holder, FUSD, redeemKey]);
    const redeemReplay = await item(admin, 'SELECT freehold.monetary_redeem_request($1,$2,100,$3) AS item', [ids.holder, FUSD, redeemKey]);
    assert.equal(redeemReplay.redemptionId, redeem.redemptionId);
    assert.equal(await auditCount('DUPLICATE_REDEEM_REQUEST', redeem.redemptionId), 1);
    const failed = await item(admin, `SELECT freehold.monetary_redeem_settlement($1,$2,'FAILED') AS item`, [ids.treasury, redeem.redemptionId]);
    assert.equal(failed.state, 'FAILED');
    assert.equal(failed.externalSettlement, false);
    assert.equal(await auditCount('REDEEM_SETTLEMENT_FAILED', redeem.redemptionId), 1);
    assert.equal(await auditCount('REDEEM_SETTLEMENT', redeem.redemptionId), 0);
    const failedAgain = await item(admin, `SELECT freehold.monetary_redeem_settlement($1,$2,'FAILED') AS item`, [ids.treasury, redeem.redemptionId]);
    assert.equal(failedAgain.state, 'FAILED');
    assert.equal(await auditCount('DUPLICATE_SETTLEMENT', redeem.redemptionId), 1);
    const conflict = await item(admin, `SELECT freehold.monetary_redeem_settlement($1,$2,'SETTLEMENT_CONFIRMED') AS item`, [ids.treasury, redeem.redemptionId]);
    assert.equal(conflict.state, 'FAILED');
    assert.equal(await auditCount('DUPLICATE_SETTLEMENT_CONFLICT', redeem.redemptionId), 1);
    assert.equal(await held(), '500');

    const payout = await item(admin, 'SELECT freehold.monetary_redeem_request($1,$2,80,$3) AS item', [ids.holder, FUSD, key()]);
    await item(admin, `SELECT freehold.monetary_redeem_settlement($1,$2,'SETTLEMENT_CONFIRMED') AS item`, [ids.treasury, payout.redemptionId]);
    const finalized = await item(admin, 'SELECT freehold.monetary_redeem_finalize($1,$2) AS item', [ids.redeemer, payout.redemptionId]);
    assert.equal(finalized.state, 'REDEEMED');
    assert.equal(finalized.externalSettlement, false);
    const obligation = (await admin.query(`SELECT obligor_entity_id, obligee_entity_id, amount_minor::text AS amount, state, claim_kind FROM freehold.cross_entity_obligations WHERE book_id = $1 AND counterparty_user_id = $2`, [FUSD, ids.holder])).rows[0];
    assert.equal(obligation.obligor_entity_id, ISSUER);
    assert.equal(obligation.obligee_entity_id, null);
    assert.equal(obligation.amount, '80');
    assert.equal(obligation.state, 'SIMULATED_OPEN');
    assert.equal(obligation.claim_kind, 'SIMULATED_REDEMPTION_PAYOUT');
    assert.equal(await held(), '420');

    const beforeSuspend = await held();
    await item(admin, 'SELECT freehold.monetary_suspend($1,$2,true) AS item', [ids.emergency1, FUSD]);
    try {
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM freehold.monetary_audit WHERE action = 'SUSPEND' AND actor_id = $1 AND detail->>'suspended' = 'true'`, [ids.emergency1])).rows[0].n, 1);
      await expectMessage(() => admin.query('SELECT freehold.monetary_redeem_request($1,$2,10,$3)', [ids.holder, FUSD, key()]), 'MONETARY_SUSPENDED');
      assert.equal(await held(), beforeSuspend);
    } finally {
      await item(admin, 'SELECT freehold.monetary_suspend($1,$2,false) AS item', [ids.emergency2, FUSD]);
    }

    const parked = await item(admin, 'SELECT freehold.monetary_redeem_request($1,$2,20,$3) AS item', [ids.holder, FUSD, key()]);
    const unknownRedeem = await item(admin, 'SELECT freehold.monetary_redeem_mark_unknown($1,$2) AS item', [ids.redeemer, parked.redemptionId]);
    assert.equal(unknownRedeem.state, 'UNKNOWN');
    assert.equal(await auditCount('REDEEM_UNKNOWN', parked.redemptionId), 1);
    const resolvedRedeem = await item(admin, 'SELECT freehold.monetary_redeem_resolve_unknown($1,$2) AS item', [ids.redeemer2, parked.redemptionId]);
    assert.equal(resolvedRedeem.state, 'EXCEPTION');
    assert.equal(await auditCount('REDEEM_RESOLVE_UNKNOWN', parked.redemptionId), 1);
    await identity(FUSD);

    const eligibleBefore = BigInt((await admin.query('SELECT freehold._monetary_eligible($1)::text AS n', [FUSD])).rows[0].n);
    const ineligible = await item(admin, `SELECT freehold.monetary_reserve_propose($1,$2,'OTHER_INELIGIBLE',100,$3,NULL,$4) AS item`, [ids.proposer, FUSD, `p11-other-${randomUUID()}`, key()]);
    await item(admin, `SELECT freehold.monetary_reserve_review($1,$2,'VERIFIED') AS item`, [ids.treasury, ineligible.reserveId]);
    assert.equal((await admin.query('SELECT freehold._monetary_eligible($1)::text AS n', [FUSD])).rows[0].n, eligibleBefore.toString());
    const assetRef = `p11-cash-${randomUUID()}`;
    const cash = await item(admin, `SELECT freehold.monetary_reserve_propose($1,$2,'USD_CASH',100,$3,NULL,$4) AS item`, [ids.proposer, FUSD, assetRef, key()]);
    await expectMessage(() => admin.query(`SELECT freehold.monetary_reserve_propose($1,$2,'USD_CASH',100,$3,NULL,$4)`, [ids.proposer, FUSD, assetRef, key()]), 'MONETARY_DUPLICATE_RESERVE');
    await item(admin, `SELECT freehold.monetary_reserve_review($1,$2,'VERIFIED') AS item`, [ids.treasury, cash.reserveId]);
    assert.equal((await admin.query('SELECT freehold._monetary_eligible($1)::text AS n', [FUSD])).rows[0].n, (eligibleBefore + 100n).toString());
    const secondReview = await item(admin, `SELECT freehold.monetary_reserve_review($1,$2,'REJECTED') AS item`, [ids.treasury, cash.reserveId]);
    assert.equal(secondReview.evidenceState, 'VERIFIED');
    assert.equal(await auditCount('DUPLICATE_RESERVE_REVIEW', cash.reserveId), 1);
    await item(admin, 'SELECT freehold.monetary_reserve_encumber($1,$2,true) AS item', [ids.treasury, cash.reserveId]);
    assert.equal((await admin.query('SELECT freehold._monetary_eligible($1)::text AS n', [FUSD])).rows[0].n, eligibleBefore.toString());
    await item(admin, 'SELECT freehold.monetary_reserve_encumber($1,$2,false) AS item', [ids.treasury, cash.reserveId]);
    await item(admin, 'SELECT freehold.monetary_reserve_mark_stale($1,$2) AS item', [ids.treasury, cash.reserveId]);
    assert.equal((await admin.query(`SELECT evidence_state FROM freehold.reserve_assets WHERE id = $1`, [cash.reserveId])).rows[0].evidence_state, 'STALE');
    assert.equal((await admin.query('SELECT freehold._monetary_eligible($1)::text AS n', [FUSD])).rows[0].n, eligibleBefore.toString());
    const capitalEligible = (await admin.query('SELECT freehold._monetary_eligible($1)::text AS n', [FUSD])).rows[0].n;
    await item(admin, 'SELECT freehold.monetary_record_capital($1,50,$2) AS item', [ids.treasury, key()]);
    assert.equal((await admin.query('SELECT freehold._monetary_eligible($1)::text AS n', [FUSD])).rows[0].n, capitalEligible);

    const openBefore = (await admin.query(`SELECT id FROM freehold.monetary_alerts WHERE book_id = $1 AND code = 'RESERVE_DEFICIT' AND acknowledged_at IS NULL`, [FUSD])).rows;
    for (const alert of openBefore) await item(admin, 'SELECT freehold.monetary_alert_acknowledge($1,$2) AS item', [ids.risk, alert.id]);
    const deficitBefore = await auditCount('RESERVE_DEFICIT');
    const counted = (await admin.query(`SELECT id FROM freehold.reserve_assets WHERE book_id = $1 AND evidence_state = 'VERIFIED' AND NOT encumbered AND category IN ('USD_CASH','FED_BALANCE','DEMAND_DEPOSIT_INSURED','TREASURY_MAX_93_DAYS')`, [FUSD])).rows.map(row => row.id);
    for (const reserveId of counted) await item(admin, 'SELECT freehold.monetary_reserve_encumber($1,$2,true) AS item', [ids.treasury, reserveId]);
    const deficitRequest = await item(admin, 'SELECT freehold.monetary_issue_request($1,$2,1,NULL,$3) AS item', [ids.requester, FUSD, key()]);
    const deficitVerify = await item(admin, 'SELECT freehold.monetary_issue_verify($1,$2) AS item', [ids.treasury, deficitRequest.issuanceId]);
    assert.equal(deficitVerify.state, 'REJECTED');
    assert.equal(await auditCount('RESERVE_DEFICIT'), deficitBefore + 1);
    const deficitAgain = await item(admin, 'SELECT freehold.monetary_issue_request($1,$2,1,NULL,$3) AS item', [ids.requester, FUSD, key()]);
    await item(admin, 'SELECT freehold.monetary_issue_verify($1,$2) AS item', [ids.treasury, deficitAgain.issuanceId]);
    assert.equal(await auditCount('RESERVE_DEFICIT'), deficitBefore + 1);
    const openAlert = (await admin.query(`SELECT id FROM freehold.monetary_alerts WHERE book_id = $1 AND code = 'RESERVE_DEFICIT' AND acknowledged_at IS NULL ORDER BY opened_at DESC LIMIT 1`, [FUSD])).rows[0];
    const outstandingAtAlert = await identity(FUSD);
    const acked = await item(admin, 'SELECT freehold.monetary_alert_acknowledge($1,$2) AS item', [ids.risk, openAlert.id]);
    assert.equal(acked.outstandingUnchanged, outstandingAtAlert);
    assert.equal(await auditCount('ALERT_ACKNOWLEDGE', openAlert.id), 1);
    assert.equal(await identity(FUSD), outstandingAtAlert);
    for (const reserveId of counted) await item(admin, 'SELECT freehold.monetary_reserve_encumber($1,$2,false) AS item', [ids.treasury, reserveId]);

    const report = await item(admin, 'SELECT freehold.monetary_report_draft($1,$2,current_date,current_date) AS item', [ids.risk, FUSD]);
    await item(admin, `SELECT freehold.monetary_report_transition($1,$2,'PENDING_REVIEW') AS item`, [ids.risk, report.reportId]);
    await expectMessage(() => admin.query(`SELECT freehold.monetary_report_transition($1,$2,'APPROVED_INTERNALLY')`, [ids.risk, report.reportId]), 'MONETARY_SELF_APPROVAL');
    await item(admin, `SELECT freehold.monetary_report_transition($1,$2,'APPROVED_INTERNALLY') AS item`, [ids.policy, report.reportId]);
    await item(admin, `SELECT freehold.monetary_report_transition($1,$2,'EXTERNAL_REVIEW_REQUIRED') AS item`, [ids.policy, report.reportId]);
    const certification = await item(admin, `SELECT freehold.monetary_report_transition($1,$2,'CERTIFICATION_REQUIRED') AS item`, [ids.policy, report.reportId]);
    assert.equal(certification.certificationRequirement, 'EXTERNAL_ACCOUNTANT_REQUIRED');
    assert.equal(certification.certificationStatus, 'NOT_CERTIFIED');
    const ready = await item(admin, `SELECT freehold.monetary_report_transition($1,$2,'READY_FOR_AUTHORIZED_SUBMISSION') AS item`, [ids.policy, report.reportId]);
    assert.equal(ready.submissionStatus, 'NOT_SUBMITTED');
    const transitions = await auditCount('REPORT_TRANSITION', report.reportId);
    const same = await item(admin, `SELECT freehold.monetary_report_transition($1,$2,'READY_FOR_AUTHORIZED_SUBMISSION') AS item`, [ids.policy, report.reportId]);
    assert.equal(same.state, 'READY_FOR_AUTHORIZED_SUBMISSION');
    assert.equal(await auditCount('REPORT_TRANSITION', report.reportId), transitions);
    await expectMessage(() => admin.query(`SELECT freehold.monetary_report_transition($1,$2,'SUBMITTED_WITH_EVIDENCE')`, [ids.policy, report.reportId]), 'MONETARY_SUBMISSION_REFUSED');
    await expectMessage(() => api.query(`SELECT freehold.monetary_report_followup($1,$2,'AMENDMENT')`, [ids.risk, report.reportId]), 'permission denied for function monetary_report_followup');
    const amendment = await item(admin, `SELECT freehold.monetary_report_followup($1,$2,'AMENDMENT') AS item`, [ids.risk, report.reportId]);
    assert.equal(amendment.state, 'DRAFT');
    assert.equal(amendment.certificationStatus, 'NOT_CERTIFIED');
    await expectMessage(() => admin.query(`SELECT freehold.monetary_report_followup($1,$2,'AMENDMENT')`, [ids.policy, report.reportId]), 'MONETARY_DUPLICATE');
    const correction = await item(admin, `SELECT freehold.monetary_report_followup($1,$2,'CORRECTION') AS item`, [ids.policy, report.reportId]);
    assert.equal(correction.state, 'DRAFT');
    assert.notEqual(correction.reportId, amendment.reportId);
    assert.equal((await admin.query('SELECT state FROM freehold.regulatory_reports WHERE id = $1', [report.reportId])).rows[0].state, 'READY_FOR_AUTHORIZED_SUBMISSION');
    await admin.query('BEGIN');
    await admin.query(`SELECT set_config('freehold.monetary_writer','on',true)`);
    await assert.rejects(admin.query(`UPDATE freehold.regulatory_reports SET certification_status = 'CERTIFIED' WHERE id = $1`, [report.reportId]), error => error.code === '23514');
    await admin.query('ROLLBACK');

    await expectMessage(() => admin.query('SELECT freehold.monetary_institution_dashboard($1)', [ids.outsider]), 'MONETARY_FORBIDDEN');
    const dashboard = await item(admin, 'SELECT freehold.monetary_institution_dashboard($1) AS item', [ids.adminReader]);
    assert.equal(dashboard.simulationOnly, true);
    assert.equal(dashboard.simulatedReservesAreRealAssets, false);
    assert.equal(dashboard.independentVerification, 'NOT_RUN_ON_THIS_SCREEN');
    assert.equal(dashboard.externalReserveEvidence, 'EXTERNAL_EVIDENCE_UNAVAILABLE');
    assert.equal(dashboard.books.find(book => book.code === 'FUSD_SIM').outstanding, await identity(FUSD));
    const evidence = await item(admin, `SELECT freehold.monetary_evidence_open($1,'P11-SUPPLY','12 U.S.C. 5901','Public Law 119-27','Simulated issuance audit',$2,'COMPLIANCE_OFFICER','External backing is not attached','2027-01-18') AS item`, [ids.risk, 'test/phase11-monetary.mjs']);
    assert.equal(evidence.technicalStatus, 'NOT_RUN');
    assert.equal(evidence.legalStatus, 'LEGAL_REVIEW_REQUIRED');
    assert.equal(evidence.certificationStatus, 'NOT_CERTIFIED');
    assert.equal(evidence.regulatoryStatus, 'NOT_SUBMITTED');
    await expectMessage(() => admin.query('SELECT freehold.monetary_evidence_note($1,$2,$3)', [ids.risk, evidence.evidenceId, 'own note']), 'MONETARY_SELF_APPROVAL');
    const noted = await item(admin, 'SELECT freehold.monetary_evidence_note($1,$2,$3) AS item', [ids.policy, evidence.evidenceId, 'Independent note does not change status']);
    assert.equal(noted.changedStatus, false);
    const exported = await item(admin, 'SELECT freehold.monetary_evidence_export($1) AS item', [ids.adminReader]);
    assert.equal(exported.determination, 'NOT_A_COMPLIANCE_DETERMINATION');
    const exportedItem = exported.items.find(row => row.evidenceId === evidence.evidenceId);
    assert.equal(exportedItem.technicalStatus, 'NOT_RUN');
    assert.equal(exportedItem.certificationStatus, 'NOT_CERTIFIED');
    assert.equal(exportedItem.reviews.length, 1);
    const partner = await item(admin, `SELECT freehold.monetary_partner_open($1,'Prospective Phase 11 Institution','PROSPECTIVE_BANK') AS item`, [ids.risk]);
    assert.equal(partner.relationshipStatus, 'UNVERIFIED');
    assert.equal(partner.charterStatus, 'UNVERIFIED');
    assert.equal(partner.externalEvidence, 'UNAVAILABLE');
    assert.equal(partner.settlementCapability, 'NOT_ENABLED');
    const checked = await item(admin, `SELECT freehold.monetary_partner_check($1,$2,'IDENTITY') AS item`, [ids.policy, partner.partnerId]);
    assert.equal(checked.checkState, 'RECORDED_NOT_VERIFIED');
    assert.equal(checked.relationshipStatus, 'UNVERIFIED');
    await admin.query('BEGIN');
    await admin.query(`SELECT set_config('freehold.monetary_writer','on',true)`);
    await assert.rejects(admin.query(`UPDATE freehold.institutional_partners SET relationship_status = 'APPROVED' WHERE id = $1`, [partner.partnerId]), error => error.code === '23514');
    await admin.query('ROLLBACK');
    const partners = await item(admin, 'SELECT freehold.monetary_partner_list($1) AS item', [ids.adminReader]);
    assert.equal(partners.partners.find(row => row.partnerId === partner.partnerId).relationshipStatus, 'UNVERIFIED');
    await expectMessage(() => verifier.query('SELECT count(*) FROM freehold.institutional_partners'), 'permission denied for table institutional_partners');
    await expectMessage(() => verifier.query('SELECT count(*) FROM freehold.disclosure_acknowledgments'), 'permission denied for table disclosure_acknowledgments');
    await expectMessage(() => verifier.query('SELECT count(*) FROM freehold.institutional_evidence'), 'permission denied for table institutional_evidence');

    const fusdBeforeFhu = await identity(FUSD);
    const fhu = await item(admin, 'SELECT freehold.monetary_fhu_issue($1,30,NULL,$2) AS item', [ids.policy, key()]);
    assert.equal(fhu.valueClaim, false);
    assert.equal(await identity(FUSD), fusdBeforeFhu);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM freehold.reserve_assets WHERE book_id = $1`, [FHU])).rows[0].n, 0);
    await identity(FHU);

    const position = (await admin.query('SELECT outstanding::text AS outstanding, pending_issuance::text AS pending FROM freehold.monetary_supply WHERE book_id = $1', [FUSD])).rows[0];
    const capMax = (BigInt(position.outstanding) + BigInt(position.pending) + 50n).toString();
    const cap = await item(admin, 'SELECT freehold.monetary_cap_request($1,$2,$3,$4) AS item', [ids.policy, FUSD, capMax, key()]);
    await item(admin, 'SELECT freehold.monetary_cap_approve($1,$2) AS item', [ids.risk, cap.requestId]);
    const raced = await Promise.all([
      admin.query('SELECT freehold.monetary_issue_request($1,$2,40,NULL,$3) AS item', [ids.requester, FUSD, key()]),
      admin2.query('SELECT freehold.monetary_issue_request($1,$2,40,NULL,$3) AS item', [ids.requester, FUSD, key()]),
    ]);
    assert.deepEqual(raced.map(result => result.rows[0].item.state).sort(), ['PENDING_RESERVE_VERIFICATION', 'REJECTED']);
    const restore = await item(admin, 'SELECT freehold.monetary_cap_request($1,$2,1000000000000,$3) AS item', [ids.policy, FUSD, key()]);
    await item(admin, 'SELECT freehold.monetary_cap_approve($1,$2) AS item', [ids.risk, restore.requestId]);

    const rollbackKey = key();
    const supplyBeforeRollback = await identity(FUSD);
    await admin.query('BEGIN');
    await admin.query('SELECT freehold.monetary_issue_request($1,$2,5,NULL,$3)', [ids.requester, FUSD, rollbackKey]);
    await admin.query('ROLLBACK');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.issuance_operations WHERE idempotency_key = $1', [rollbackKey])).rows[0].n, 0);
    assert.equal(await identity(FUSD), supplyBeforeRollback);
    const committedKey = key();
    const committed = await item(admin, 'SELECT freehold.monetary_issue_request($1,$2,6,NULL,$3) AS item', [ids.requester, FUSD, committedKey]);
    const lostResponse = await item(admin, 'SELECT freehold.monetary_issue_request($1,$2,6,NULL,$3) AS item', [ids.requester, FUSD, committedKey]);
    assert.equal(lostResponse.issuanceId, committed.issuanceId);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.issuance_operations WHERE idempotency_key = $1', [committedKey])).rows[0].n, 1);

    const redeemRollback = key();
    const heldBeforeRollback = await held();
    await admin.query('BEGIN');
    await admin.query('SELECT freehold.monetary_redeem_request($1,$2,5,$3)', [ids.holder, FUSD, redeemRollback]);
    await admin.query('ROLLBACK');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.redemption_operations WHERE idempotency_key = $1', [redeemRollback])).rows[0].n, 0);
    assert.equal(await held(), heldBeforeRollback);

    const victim = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
    victim.on('error', () => undefined);
    await victim.connect();
    const victimKey = key();
    const beforeTerminate = await identity(FUSD);
    await victim.query('BEGIN');
    await victim.query('SELECT freehold.monetary_issue_request($1,$2,5,NULL,$3)', [ids.requester, FUSD, victimKey]);
    const pid = (await victim.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await admin.query('SELECT pg_terminate_backend($1::int)', [pid]);
    await victim.end().catch(() => undefined);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.issuance_operations WHERE idempotency_key = $1', [victimKey])).rows[0].n, 0);
    assert.equal(await identity(FUSD), beforeTerminate);

    const bank = await item(admin, 'SELECT freehold.monetary_bank_open($1,$2,$3) AS item', [ids.holder, account, key()]);
    const external = `p11-bank-${randomUUID()}`;
    const notice = await item(admin, `SELECT freehold.monetary_bank_event($1,$2,'DEPOSIT',$3,250,'PENDING',NULL) AS item`, [ids.holder, bank.bankAccountId, external]);
    assert.equal(notice.fundsReceived, false);
    const replayedNotice = await item(admin, `SELECT freehold.monetary_bank_event($1,$2,'DEPOSIT',$3,250,'PENDING',NULL) AS item`, [ids.holder, bank.bankAccountId, external]);
    assert.equal(replayedNotice.duplicate, true);
    assert.equal(replayedNotice.fundsReceived, false);
    assert.equal(replayedNotice.availableMinor, '0');
    assert.equal((await admin.query('SELECT available_minor::text AS n FROM freehold.accounts WHERE id = $1', [account])).rows[0].n, '0');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.bank_events WHERE internal_journal_id IS NOT NULL')).rows[0].n, 0);

    const observed = await identity(FUSD);
    const staleObservation = await item(admin, `SELECT freehold.monetary_chain_observe($1,$2,'ISSUE',$3,'NOT_FINAL',1,$4) AS item`, [ids.executor, FUSD, `p11-${randomUUID()}`, '1']);
    assert.equal(staleObservation.supplyChanged, false);
    assert.equal(await identity(FUSD), observed);
    await expectMessage(() => admin.query('UPDATE freehold.monetary_supply SET outstanding = outstanding + 1'), 'MONETARY_DIRECT_WRITE_FORBIDDEN');
    await expectMessage(() => admin.query(`SELECT freehold.monetary_activate_live('license')`), 'LIVE_MONETARY_ACTIVATION_REFUSED');

    const reportAfter = await verifyLedger(verifier);
    assert.equal(reportAfter.externalReserveOutcome, 'EXTERNAL_EVIDENCE_UNAVAILABLE');
    assert.notEqual(reportAfter.outcome, 'VERIFIED');
    assert.equal(reportAfter.monetary.simulatedReservesAreExternalEvidence, false);
    assert.ok(reportAfter.accountingViolations.some(row => row.code === 'MONETARY_CHAIN_SUPPLY_MISMATCH' && row.book === 'FUSD_SIM'));
    await identity(FUSD);
    await identity(FHU);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.ledger_journals')).rows[0].n, journalsBefore);
    assert.equal((await admin.query('SELECT COALESCE(sum(available_minor),0)::text AS n FROM freehold.accounts')).rows[0].n, availableBefore);
  } finally {
    await admin.query('SELECT freehold.monetary_suspend($1,$2,false)', [ids.emergency2, FUSD]).catch(() => undefined);
    await Promise.all([admin.end(), admin2.end(), api.end(), verifier.end()].map(job => job.catch(() => undefined)));
  }
});
