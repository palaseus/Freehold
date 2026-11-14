import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { verifyLedger } from '../scripts/lib/ledger-verifier.mjs';

const FUSD = '20000000-0000-4000-8000-000000000001';
const FHU = '20000000-0000-4000-8000-000000000002';
const admin = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
const admin2 = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
const api = new Client({ connectionString: process.env.DATABASE_URL });
const worker = new Client({ connectionString: process.env.WORKER_DATABASE_URL });
const verifier = new Client({ connectionString: process.env.VERIFY_DATABASE_URL });

const item = async (client, sql, params = []) => (await client.query(sql, params)).rows[0].item;
const violationKey = row => `${row.code}|${row.operationId ?? row.journalId ?? row.book ?? row.issuanceId ?? ''}`;
const splitViolations = report => {
  const rows = report.accountingViolations ?? [];
  return {
    monetary: rows.filter(row => String(row.code).startsWith('MONETARY_')).map(violationKey).sort(),
    other: rows.filter(row => !String(row.code).startsWith('MONETARY_')).map(violationKey).sort(),
  };
};
const expectMessage = async (fn, message) => {
  await assert.rejects(fn, error => {
    assert.equal(error.message, message, `${error.code ?? ''} ${error.message}`);
    return true;
  });
};

test('phase 10 monetary simulation keeps liabilities, supply, and activation isolated', async () => {
  await Promise.all([admin.connect(), admin2.connect(), api.connect(), worker.connect(), verifier.connect()]);
  const baseline = await verifyLedger(verifier);
  const baselineSplit = splitViolations(baseline);
  assert.deepEqual(baselineSplit.monetary, []);
  const ids = Object.fromEntries(['funder', 'proposer', 'treasury', 'requester', 'approver', 'executor', 'compliance', 'emergency1', 'emergency2', 'risk', 'policy', 'security1', 'security2', 'customer', 'redeemA', 'redeemB', 'blocked', 'outsider'].map(name => [name, randomUUID()]));
  const account = randomUUID();
  const hash = 'phase10-unused-password-hash';
  const key = () => `p10-${randomUUID()}`;
  try {
    await admin.query(`INSERT INTO freehold.users(id,email_normalized,password_hash,role) VALUES
      ($1,$2,$3,'ADMIN'),($4,$5,$3,'USER'),($6,$7,$3,'USER'),($8,$9,$3,'USER'),($10,$11,$3,'USER'),
      ($12,$13,$3,'USER'),($14,$15,$3,'USER'),($16,$17,$3,'USER'),($18,$19,$3,'USER'),($20,$21,$3,'USER'),
      ($22,$23,$3,'USER'),($24,$25,$3,'USER'),($26,$27,$3,'USER'),($28,$29,$3,'USER'),($30,$31,$3,'USER'),
      ($32,$33,$3,'USER'),($34,$35,$3,'USER'),($36,$37,$3,'USER')`, [
      ids.funder, `p10-funder-${ids.funder}@example.test`, hash,
      ids.proposer, `p10-proposer-${ids.proposer}@example.test`,
      ids.treasury, `p10-treasury-${ids.treasury}@example.test`,
      ids.requester, `p10-requester-${ids.requester}@example.test`,
      ids.approver, `p10-approver-${ids.approver}@example.test`,
      ids.executor, `p10-executor-${ids.executor}@example.test`,
      ids.compliance, `p10-compliance-${ids.compliance}@example.test`,
      ids.emergency1, `p10-e1-${ids.emergency1}@example.test`,
      ids.emergency2, `p10-e2-${ids.emergency2}@example.test`,
      ids.risk, `p10-risk-${ids.risk}@example.test`,
      ids.policy, `p10-policy-${ids.policy}@example.test`,
      ids.security1, `p10-s1-${ids.security1}@example.test`,
      ids.security2, `p10-s2-${ids.security2}@example.test`,
      ids.customer, `p10-customer-${ids.customer}@example.test`,
      ids.redeemA, `p10-redeem-a-${ids.redeemA}@example.test`,
      ids.redeemB, `p10-redeem-b-${ids.redeemB}@example.test`,
      ids.blocked, `p10-blocked-${ids.blocked}@example.test`,
      ids.outsider, `p10-outsider-${ids.outsider}@example.test`,
    ]);
    const caps = [
      [ids.proposer, 'RESERVE_MANAGEMENT'], [ids.proposer, 'TREASURY'], [ids.proposer, 'ISSUANCE_AUTHORITY'],
      [ids.treasury, 'TREASURY'], [ids.treasury, 'ISSUANCE_AUTHORITY'], [ids.treasury, 'REDEMPTION_AUTHORITY'],
      [ids.requester, 'ISSUANCE_AUTHORITY'], [ids.approver, 'ISSUANCE_AUTHORITY'], [ids.executor, 'ISSUANCE_AUTHORITY'],
      [ids.compliance, 'COMPLIANCE_OFFICER'], [ids.emergency1, 'EMERGENCY_CONTROL'], [ids.emergency2, 'EMERGENCY_CONTROL'],
      [ids.risk, 'FINANCIAL_RISK'], [ids.policy, 'GOVERNANCE_POLICY'], [ids.policy, 'FINANCIAL_RISK'],
      [ids.security1, 'SECURITY_ADMIN'], [ids.security2, 'SECURITY_ADMIN'],
      [ids.redeemA, 'REDEMPTION_AUTHORITY'], [ids.redeemA, 'TREASURY'], [ids.redeemB, 'REDEMPTION_AUTHORITY'],
    ];
    for (const [principal, capability] of caps) await admin.query('SELECT freehold.monetary_bootstrap_capability($1,$2)', [principal, capability]);
    await admin.query('INSERT INTO freehold.accounts(id,owner_user_id,currency_code) VALUES ($1,$2,\'USD\')', [account, ids.customer]);
    const journalsBefore = (await admin.query('SELECT count(*)::int AS n FROM freehold.ledger_journals')).rows[0].n;
    await admin.query('SELECT freehold.sandbox_fund_account($1,$2,10000,$3,$4,$5)', [ids.funder, account, key(), 'phase10 sandbox', randomUUID()]);
    const journalsAfterFund = (await admin.query('SELECT count(*)::int AS n FROM freehold.ledger_journals')).rows[0].n;
    assert.equal(journalsAfterFund, journalsBefore + 1);

    await expectMessage(() => admin.query(`SELECT freehold.monetary_activate_live('license')`), 'LIVE_MONETARY_ACTIVATION_REFUSED');
    await expectMessage(() => api.query(`SELECT freehold.monetary_activate_live('license')`), 'LIVE_MONETARY_ACTIVATION_REFUSED');
    const liveBooks = (await admin.query('SELECT count(*)::int AS n FROM freehold.monetary_books WHERE live_issuance_enabled OR NOT simulation_only')).rows[0].n;
    assert.equal(liveBooks, 0);
    await expectMessage(() => admin.query('UPDATE freehold.monetary_supply SET outstanding = outstanding + 1'), 'MONETARY_DIRECT_WRITE_FORBIDDEN');
    await admin.query('BEGIN');
    await admin.query(`SELECT set_config('freehold.monetary_writer','on',true)`);
    await assert.rejects(admin.query('UPDATE freehold.monetary_books SET live_issuance_enabled = true'), error => error.code === '23514');
    await admin.query('ROLLBACK');

    await expectMessage(() => api.query('SELECT freehold.monetary_overview($1)', [ids.customer]), 'SESSION_NOT_BOUND');
    await expectMessage(() => api.query('INSERT INTO freehold.reserve_assets(book_id) VALUES ($1)', [FUSD]), 'permission denied for table reserve_assets');
    await expectMessage(() => worker.query('SELECT freehold.monetary_issue_execute($1,$2)', [ids.executor, randomUUID()]), 'permission denied for function monetary_issue_execute');
    await expectMessage(() => verifier.query('SELECT freehold.monetary_overview($1)', [ids.customer]), 'permission denied for function monetary_overview');
    const secret = randomBytes(32);
    await admin.query('SELECT freehold.auth_bind_session($1,1,$2,NULL,3600)', [ids.customer, secret]);
    await api.query('BEGIN');
    await api.query(`SELECT set_config('freehold.session_secret',$1,true)`, [secret.toString('hex')]);
    const overview = (await api.query('SELECT freehold.monetary_overview($1) AS item', [ids.customer])).rows[0].item;
    await api.query('COMMIT');
    assert.equal(overview.institutionStatus, 'NOT_A_BANK');
    assert.equal(overview.fusdStatus, 'SIMULATED_NOT_AUTHORIZED');
    assert.equal(overview.fhuStatus, 'EXPERIMENTAL_NOT_A_PAYMENT_STABLECOIN');
    assert.equal(overview.conversionAvailable, false);
    assert.equal(overview.liveIssuanceEnabled, false);
    assert.equal(overview.externalReserveEvidence, 'UNAVAILABLE');

    await expectMessage(() => admin.query('SELECT freehold.monetary_issue_request($1,$2,10,NULL,$3)', [ids.outsider, FUSD, key()]), 'MONETARY_FORBIDDEN');
    const bare = await item(admin, 'SELECT freehold.monetary_issue_request($1,$2,25,NULL,$3) AS item', [ids.requester, FUSD, key()]);
    assert.equal(bare.state, 'PENDING_RESERVE_VERIFICATION');
    const bareRejected = await item(admin, 'SELECT freehold.monetary_issue_verify($1,$2) AS item', [ids.treasury, bare.issuanceId]);
    assert.equal(bareRejected.state, 'REJECTED');

    const dates = (await admin.query(`SELECT current_date::text AS today, (current_date + 30)::text AS soon, (current_date + 200)::text AS late`)).rows[0];
    const ineligible = await item(admin, 'SELECT freehold.monetary_reserve_propose($1,$2,\'OTHER_INELIGIBLE\',1000,$3,NULL,$4) AS item', [ids.proposer, FUSD, `asset-${randomUUID()}`, key()]);
    await item(admin, 'SELECT freehold.monetary_reserve_review($1,$2,\'VERIFIED\') AS item', [ids.treasury, ineligible.reserveId]);
    const repo = await item(admin, 'SELECT freehold.monetary_reserve_propose($1,$2,\'OVERNIGHT_TREASURY_REPO\',1000,$3,NULL,$4) AS item', [ids.proposer, FUSD, `asset-${randomUUID()}`, key()]);
    await item(admin, 'SELECT freehold.monetary_reserve_review($1,$2,\'VERIFIED\') AS item', [ids.treasury, repo.reserveId]);
    const longBill = await item(admin, 'SELECT freehold.monetary_reserve_propose($1,$2,\'TREASURY_MAX_93_DAYS\',1000,$3,$4,$5) AS item', [ids.proposer, FUSD, `asset-${randomUUID()}`, dates.late, key()]);
    await item(admin, 'SELECT freehold.monetary_reserve_review($1,$2,\'VERIFIED\') AS item', [ids.treasury, longBill.reserveId]);
    const eligibleBeforeCash = (await admin.query('SELECT freehold._monetary_eligible($1)::text AS n', [FUSD])).rows[0].n;
    assert.equal(eligibleBeforeCash, '0');
    const stillShort = await item(admin, 'SELECT freehold.monetary_issue_request($1,$2,10,NULL,$3) AS item', [ids.requester, FUSD, key()]);
    assert.equal((await item(admin, 'SELECT freehold.monetary_issue_verify($1,$2) AS item', [ids.treasury, stillShort.issuanceId])).state, 'REJECTED');
    await expectMessage(() => admin.query('SELECT freehold.monetary_reserve_propose($1,$2,\'USD_CASH\',100,$3,NULL,$4)', [ids.proposer, FHU, `asset-${randomUUID()}`, key()]), 'MONETARY_INVALID');
    const assetRef = `cash-${randomUUID()}`;
    const cash = await item(admin, 'SELECT freehold.monetary_reserve_propose($1,$2,\'USD_CASH\',20000,$3,NULL,$4) AS item', [ids.proposer, FUSD, assetRef, key()]);
    await expectMessage(() => admin.query('SELECT freehold.monetary_reserve_propose($1,$2,\'USD_CASH\',1,$3,NULL,$4)', [ids.proposer, FUSD, assetRef, key()]), 'MONETARY_DUPLICATE_RESERVE');
    await expectMessage(() => admin.query('SELECT freehold.monetary_reserve_review($1,$2,\'VERIFIED\')', [ids.proposer, cash.reserveId]), 'MONETARY_SELF_APPROVAL');
    const reviewed = await item(admin, 'SELECT freehold.monetary_reserve_review($1,$2,\'VERIFIED\') AS item', [ids.treasury, cash.reserveId]);
    assert.equal(reviewed.evidenceScope, 'SIMULATED');
    assert.equal(reviewed.externalEvidence, false);
    const capitalBefore = (await admin.query('SELECT freehold._monetary_eligible($1)::text AS n', [FUSD])).rows[0].n;
    const capital = await item(admin, 'SELECT freehold.monetary_record_capital($1,1000000,$2) AS item', [ids.treasury, key()]);
    assert.equal(capital.countsAsReserve, false);
    assert.equal((await admin.query('SELECT freehold._monetary_eligible($1)::text AS n', [FUSD])).rows[0].n, capitalBefore);
    await admin.query('BEGIN');
    await admin.query(`SELECT set_config('freehold.monetary_writer','on',true)`);
    await expectMessage(() => admin.query(`UPDATE freehold.reserve_assets SET evidence_scope = 'EXTERNAL' WHERE id = $1`, [cash.reserveId]), 'MONETARY_EVIDENCE_SCOPE');
    await admin.query('ROLLBACK');

    const shortBill = await item(admin, 'SELECT freehold.monetary_reserve_propose($1,$2,\'TREASURY_MAX_93_DAYS\',1000,$3,$4,$5) AS item', [ids.proposer, FUSD, `asset-${randomUUID()}`, dates.soon, key()]);
    await item(admin, 'SELECT freehold.monetary_reserve_review($1,$2,\'VERIFIED\') AS item', [ids.treasury, shortBill.reserveId]);
    const eligible = BigInt((await admin.query('SELECT freehold._monetary_eligible($1)::text AS n', [FUSD])).rows[0].n);
    assert.equal(eligible, 21000n);

    const acknowledged = await item(admin, `SELECT freehold.monetary_disclosure_acknowledge($1,'PAYMENT_STABLECOIN','phase11-draft') AS item`, [ids.customer]);
    assert.equal(acknowledged.finalDisclosure, false);
    assert.equal(acknowledged.liveIssuance, false);
    const pendingIssue = await item(admin, 'SELECT freehold.monetary_issue_request($1,$2,5000,$3,$4) AS item', [ids.requester, FUSD, ids.customer, key()]);
    await item(admin, 'SELECT freehold.monetary_issue_verify($1,$2) AS item', [ids.treasury, pendingIssue.issuanceId]);
    await expectMessage(() => admin.query('SELECT freehold.monetary_issue_approve($1,$2)', [ids.requester, pendingIssue.issuanceId]), 'MONETARY_SELF_APPROVAL');
    await expectMessage(() => admin.query('SELECT freehold.monetary_issue_approve($1,$2)', [ids.proposer, pendingIssue.issuanceId]), 'MONETARY_SELF_APPROVAL');
    await item(admin, 'SELECT freehold.monetary_issue_approve($1,$2) AS item', [ids.approver, pendingIssue.issuanceId]);
    await expectMessage(() => admin.query('SELECT freehold.monetary_issue_execute($1,$2)', [ids.treasury, pendingIssue.issuanceId]), 'MONETARY_SELF_APPROVAL');
    await expectMessage(() => admin.query('SELECT freehold.monetary_issue_execute($1,$2)', [ids.approver, pendingIssue.issuanceId]), 'MONETARY_SELF_APPROVAL');
    const issued = await item(admin, 'SELECT freehold.monetary_issue_execute($1,$2) AS item', [ids.executor, pendingIssue.issuanceId]);
    assert.equal(issued.state, 'ISSUED');
    assert.equal(issued.liveIssuance, false);
    const replayKey = key();
    const first = await item(admin, 'SELECT freehold.monetary_issue_request($1,$2,10,$3,$4) AS item', [ids.requester, FUSD, ids.customer, replayKey]);
    await item(admin, 'SELECT freehold.monetary_issue_verify($1,$2) AS item', [ids.treasury, first.issuanceId]);
    await item(admin, 'SELECT freehold.monetary_issue_approve($1,$2) AS item', [ids.approver, first.issuanceId]);
    const executed = await item(admin, 'SELECT freehold.monetary_issue_execute($1,$2) AS item', [ids.executor, first.issuanceId]);
    const lost = await item(admin, 'SELECT freehold.monetary_issue_request($1,$2,10,$3,$4) AS item', [ids.requester, FUSD, ids.customer, replayKey]);
    assert.equal(lost.issuanceId, first.issuanceId);
    assert.equal(lost.state, 'ISSUED');
    assert.equal(executed.issuanceId, first.issuanceId);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.issuance_operations WHERE idempotency_key = $1', [replayKey])).rows[0].n, 1);
    const ownActivity = await item(admin, 'SELECT freehold.monetary_customer_activity($1) AS item', [ids.customer]);
    assert.equal(ownActivity.redemptionPolicy, 'NOT_OFFERED');
    assert.equal(ownActivity.fees.charged, false);
    assert.equal(ownActivity.issuance.some(row => row.issuanceId === pendingIssue.issuanceId), true);
    const otherActivity = await item(admin, 'SELECT freehold.monetary_customer_activity($1) AS item', [ids.outsider]);
    assert.deepEqual(otherActivity.issuance, []);
    assert.deepEqual(otherActivity.redemptions, []);

    await admin.query('BEGIN');
    await admin.query(`SELECT set_config('freehold.monetary_writer','on',true)`);
    await admin.query(`UPDATE freehold.reserve_assets SET verified_at = clock_timestamp() - interval '40 days' WHERE id = $1`, [shortBill.reserveId]);
    await admin.query('COMMIT');
    const aged = (await admin.query('SELECT freehold._monetary_eligible($1)::text AS n', [FUSD])).rows[0].n;
    assert.equal(aged, '20000');
    const refreshProbe = await item(admin, 'SELECT freehold.monetary_issue_request($1,$2,1,$3,$4) AS item', [ids.requester, FUSD, ids.customer, key()]);
    await item(admin, 'SELECT freehold.monetary_issue_verify($1,$2) AS item', [ids.treasury, refreshProbe.issuanceId]);
    assert.equal((await admin.query('SELECT evidence_state FROM freehold.reserve_assets WHERE id = $1', [shortBill.reserveId])).rows[0].evidence_state, 'STALE');

    const encumbered = await item(admin, 'SELECT freehold.monetary_reserve_encumber($1,$2,true) AS item', [ids.treasury, cash.reserveId]);
    assert.equal(encumbered.encumbered, true);
    assert.equal((await admin.query('SELECT freehold._monetary_eligible($1)::text AS n', [FUSD])).rows[0].n, '0');
    const deficit = await item(admin, 'SELECT freehold.monetary_issue_request($1,$2,1,NULL,$3) AS item', [ids.requester, FUSD, key()]);
    assert.equal((await item(admin, 'SELECT freehold.monetary_issue_verify($1,$2) AS item', [ids.treasury, deficit.issuanceId])).state, 'REJECTED');
    const alert = (await admin.query(`SELECT id, (SELECT outstanding FROM freehold.monetary_supply WHERE book_id = $1)::text AS outstanding FROM freehold.monetary_alerts WHERE book_id = $1 AND code = 'RESERVE_DEFICIT' AND acknowledged_at IS NULL LIMIT 1`, [FUSD])).rows[0];
    assert.ok(alert);
    const acked = await item(admin, 'SELECT freehold.monetary_alert_acknowledge($1,$2) AS item', [ids.risk, alert.id]);
    assert.equal(acked.outstandingUnchanged, alert.outstanding);
    await item(admin, 'SELECT freehold.monetary_reserve_encumber($1,$2,false) AS item', [ids.treasury, cash.reserveId]);
    assert.equal((await admin.query('SELECT freehold._monetary_eligible($1)::text AS n', [FUSD])).rows[0].n, '20000');

    const coverageBreak = await item(admin, 'SELECT freehold.monetary_issue_request($1,$2,100,$3,$4) AS item', [ids.requester, FUSD, ids.customer, key()]);
    await item(admin, 'SELECT freehold.monetary_issue_verify($1,$2) AS item', [ids.treasury, coverageBreak.issuanceId]);
    await item(admin, 'SELECT freehold.monetary_issue_approve($1,$2) AS item', [ids.approver, coverageBreak.issuanceId]);
    await item(admin, 'SELECT freehold.monetary_reserve_encumber($1,$2,true) AS item', [ids.treasury, cash.reserveId]);
    const failedExecute = await item(admin, 'SELECT freehold.monetary_issue_execute($1,$2) AS item', [ids.executor, coverageBreak.issuanceId]);
    assert.equal(failedExecute.state, 'FAILED');
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM freehold.monetary_audit WHERE action = 'ISSUE_EXECUTE_FAILED' AND detail->>'issuanceId' = $1`, [coverageBreak.issuanceId])).rows[0].n, 1);
    await item(admin, 'SELECT freehold.monetary_reserve_encumber($1,$2,false) AS item', [ids.treasury, cash.reserveId]);
    assert.equal((await admin.query('SELECT freehold._monetary_eligible($1)::text AS n', [FUSD])).rows[0].n, '20000');

    const failedRedeem = await item(admin, 'SELECT freehold.monetary_redeem_request($1,$2,1000,$3) AS item', [ids.customer, FUSD, key()]);
    assert.equal(failedRedeem.state, 'UNITS_SECURED');
    await expectMessage(() => admin.query('SELECT freehold.monetary_redeem_settlement($1,$2,\'FAILED\')', [ids.customer, failedRedeem.redemptionId]), 'MONETARY_FORBIDDEN');
    const failed = await item(admin, 'SELECT freehold.monetary_redeem_settlement($1,$2,\'FAILED\') AS item', [ids.treasury, failedRedeem.redemptionId]);
    assert.equal(failed.state, 'FAILED');
    const again = await item(admin, 'SELECT freehold.monetary_redeem_request($1,$2,1000,$3) AS item', [ids.customer, FUSD, key()]);
    const confirmed = await item(admin, 'SELECT freehold.monetary_redeem_settlement($1,$2,\'SETTLEMENT_CONFIRMED\') AS item', [ids.treasury, again.redemptionId]);
    assert.equal(confirmed.state, 'SETTLEMENT_CONFIRMED');
    await expectMessage(() => admin.query('SELECT freehold.monetary_redeem_finalize($1,$2)', [ids.treasury, again.redemptionId]), 'MONETARY_SELF_APPROVAL');
    const redeemed = await item(admin, 'SELECT freehold.monetary_redeem_finalize($1,$2) AS item', [ids.redeemB, again.redemptionId]);
    assert.equal(redeemed.state, 'REDEEMED');
    assert.equal(redeemed.externalSettlement, false);
    const sameRedeem = key();
    const redeemOnce = await item(admin, 'SELECT freehold.monetary_redeem_request($1,$2,100,$3) AS item', [ids.customer, FUSD, sameRedeem]);
    const redeemTwice = await item(admin, 'SELECT freehold.monetary_redeem_request($1,$2,100,$3) AS item', [ids.customer, FUSD, sameRedeem]);
    assert.equal(redeemTwice.redemptionId, redeemOnce.redemptionId);
    await item(admin, 'SELECT freehold.monetary_redeem_settlement($1,$2,\'FAILED\') AS item', [ids.treasury, redeemOnce.redemptionId]);
    const parked = await item(admin, 'SELECT freehold.monetary_redeem_request($1,$2,200,$3) AS item', [ids.customer, FUSD, key()]);
    await item(admin, 'SELECT freehold.monetary_redeem_mark_unknown($1,$2) AS item', [ids.redeemA, parked.redemptionId]);
    await expectMessage(() => admin.query('SELECT freehold.monetary_redeem_resolve_unknown($1,$2)', [ids.redeemA, parked.redemptionId]), 'MONETARY_SELF_APPROVAL');
    const exception = await item(admin, 'SELECT freehold.monetary_redeem_resolve_unknown($1,$2) AS item', [ids.redeemB, parked.redemptionId]);
    assert.equal(exception.state, 'EXCEPTION');
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM freehold.monetary_audit WHERE action = 'REDEEM_RESOLVE_UNKNOWN' AND detail->>'redemptionId' = $1`, [parked.redemptionId])).rows[0].n, 1);

    const treasuryIssue = await item(admin, 'SELECT freehold.monetary_issue_request($1,$2,100,NULL,$3) AS item', [ids.requester, FUSD, key()]);
    await item(admin, 'SELECT freehold.monetary_issue_verify($1,$2) AS item', [ids.treasury, treasuryIssue.issuanceId]);
    await item(admin, 'SELECT freehold.monetary_issue_approve($1,$2) AS item', [ids.approver, treasuryIssue.issuanceId]);
    assert.equal((await item(admin, 'SELECT freehold.monetary_issue_execute($1,$2) AS item', [ids.executor, treasuryIssue.issuanceId])).state, 'ISSUED');
    const selfRedeem = await item(admin, 'SELECT freehold.monetary_redeem_request($1,$2,50,$3) AS item', [ids.redeemA, FUSD, key()]);
    await expectMessage(() => admin.query('SELECT freehold.monetary_redeem_settlement($1,$2,\'FAILED\')', [ids.redeemA, selfRedeem.redemptionId]), 'MONETARY_SELF_APPROVAL');
    await item(admin, 'SELECT freehold.monetary_redeem_settlement($1,$2,\'FAILED\') AS item', [ids.treasury, selfRedeem.redemptionId]);

    const unknownIssue = await item(admin, 'SELECT freehold.monetary_issue_request($1,$2,15,NULL,$3) AS item', [ids.requester, FUSD, key()]);
    await item(admin, 'SELECT freehold.monetary_issue_verify($1,$2) AS item', [ids.treasury, unknownIssue.issuanceId]);
    await item(admin, 'SELECT freehold.monetary_issue_approve($1,$2) AS item', [ids.approver, unknownIssue.issuanceId]);
    await item(admin, 'SELECT freehold.monetary_issue_mark_unknown($1,$2) AS item', [ids.approver, unknownIssue.issuanceId]);
    await expectMessage(() => admin.query('SELECT freehold.monetary_issue_execute($1,$2)', [ids.executor, unknownIssue.issuanceId]), 'MONETARY_UNKNOWN_BLOCKED');
    const resolved = await item(admin, 'SELECT freehold.monetary_issue_resolve_unknown($1,$2) AS item', [ids.executor, unknownIssue.issuanceId]);
    assert.equal(resolved.state, 'FAILED');
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM freehold.monetary_audit WHERE action = 'ISSUE_RESOLVE_UNKNOWN' AND detail->>'issuanceId' = $1`, [unknownIssue.issuanceId])).rows[0].n, 1);

    const availableBefore = (await admin.query('SELECT available_minor::text AS n FROM freehold.accounts WHERE id = $1', [account])).rows[0].n;
    const conversion = await item(admin, 'SELECT freehold.monetary_conversion_request($1,$2,100,$3) AS item', [ids.customer, account, key()]);
    assert.equal(conversion.reason, 'UNBACKED_CONVERSION_REFUSED');
    assert.equal(conversion.fusdCredited, '0');
    assert.equal((await admin.query('SELECT available_minor::text AS n FROM freehold.accounts WHERE id = $1', [account])).rows[0].n, availableBefore);
    const bank = await item(admin, 'SELECT freehold.monetary_bank_open($1,$2,$3) AS item', [ids.customer, account, key()]);
    assert.equal(bank.fundsReceived, false);
    const hmacKey = 'phase10-sim-hmac-key';
    await admin.query(`SELECT set_config('freehold.bank_simulator_key',$1,false)`, [hmacKey]);
    const external = `dep-${randomUUID()}`;
    const bad = await item(admin, 'SELECT freehold.monetary_bank_event($1,$2,\'DEPOSIT\',$3,500,\'SETTLED\',$4) AS item', [ids.customer, bank.bankAccountId, external, '00']);
    assert.equal(bad.state, 'FAILED');
    assert.equal(bad.fundsReceived, false);
    const step = `dep-${randomUUID()}`;
    const sign = state => createHmac('sha256', hmacKey).update(`${step}|DEPOSIT|250|${state}`).digest('hex');
    assert.equal((await item(admin, 'SELECT freehold.monetary_bank_event($1,$2,\'DEPOSIT\',$3,250,\'PENDING\',NULL) AS item', [ids.customer, bank.bankAccountId, step])).state, 'PENDING');
    assert.equal((await item(admin, 'SELECT freehold.monetary_bank_event($1,$2,\'DEPOSIT\',$3,250,\'SUBMITTED\',NULL) AS item', [ids.customer, bank.bankAccountId, step])).state, 'SUBMITTED');
    assert.equal((await item(admin, 'SELECT freehold.monetary_bank_event($1,$2,\'DEPOSIT\',$3,250,\'ACKNOWLEDGED\',$4) AS item', [ids.customer, bank.bankAccountId, step, sign('ACKNOWLEDGED')])).state, 'ACKNOWLEDGED');
    const settled = await item(admin, 'SELECT freehold.monetary_bank_event($1,$2,\'DEPOSIT\',$3,250,\'SETTLED\',$4) AS item', [ids.customer, bank.bankAccountId, step, sign('SETTLED')]);
    assert.equal(settled.state, 'SETTLED');
    assert.equal(settled.fundsReceived, false);
    assert.equal(settled.duplicate, true);
    assert.equal((await admin.query('SELECT available_minor::text AS n FROM freehold.accounts WHERE id = $1', [account])).rows[0].n, availableBefore);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.bank_events WHERE internal_journal_id IS NOT NULL')).rows[0].n, 0);

    const fusdBefore = (await admin.query('SELECT outstanding::text AS n FROM freehold.monetary_supply WHERE book_id = $1', [FUSD])).rows[0].n;
    const fhu = await item(admin, 'SELECT freehold.monetary_fhu_issue($1,25,NULL,$2) AS item', [ids.policy, key()]);
    assert.equal(fhu.valueClaim, false);
    assert.equal(fhu.unit, 'FHU');
    assert.equal((await admin.query('SELECT outstanding::text AS n FROM freehold.monetary_supply WHERE book_id = $1', [FUSD])).rows[0].n, fusdBefore);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM freehold.reserve_assets r JOIN freehold.monetary_books b ON b.id = r.book_id WHERE b.code = 'FHU_SIM'`)).rows[0].n, 0);

    await item(admin, 'SELECT freehold.monetary_restriction_set($1,$2,\'BLOCK_SIMULATED_ISSUANCE\',$3) AS item', [ids.compliance, ids.blocked, 'simulated block']);
    await expectMessage(() => admin.query('SELECT freehold.monetary_issue_request($1,$2,1,$3,$4)', [ids.requester, FUSD, ids.blocked, key()]), 'MONETARY_RESTRICTED');
    const screening = await item(admin, 'SELECT freehold.monetary_screen($1,$2,$3) AS item', [ids.compliance, 'subject-1', key()]);
    assert.equal(screening.disposition, 'POTENTIAL_MATCH');
    assert.equal(screening.determination, 'NOT_AN_OFAC_DETERMINATION');
    assert.equal(screening.program, 'NOT_A_BSA_PROGRAM');
    await expectMessage(() => admin.query(`UPDATE freehold.monetary_screenings SET determination = 'OFAC_HIT' WHERE id = $1`, [screening.screeningId]), 'MONETARY_DIRECT_WRITE_FORBIDDEN');

    await item(admin, 'SELECT freehold.monetary_suspend($1,$2,true) AS item', [ids.emergency1, FUSD]);
    await expectMessage(() => admin.query('SELECT freehold.monetary_issue_request($1,$2,1,NULL,$3)', [ids.requester, FUSD, key()]), 'MONETARY_SUSPENDED');
    await expectMessage(() => admin.query('SELECT freehold.monetary_suspend($1,$2,false)', [ids.emergency1, FUSD]), 'MONETARY_SELF_APPROVAL');
    await item(admin, 'SELECT freehold.monetary_suspend($1,$2,false) AS item', [ids.emergency2, FUSD]);

    const report = await item(admin, 'SELECT freehold.monetary_report_draft($1,$2,current_date,current_date) AS item', [ids.risk, FUSD]);
    assert.equal(report.certificationStatus, 'NOT_CERTIFIED');
    assert.equal(report.submissionStatus, 'NOT_SUBMITTED');
    assert.equal(report.body.externalEvidenceStatus, 'UNAVAILABLE');
    await expectMessage(() => admin.query(`SELECT freehold.monetary_report_transition($1,$2,'SUBMITTED_WITH_EVIDENCE')`, [ids.risk, report.reportId]), 'MONETARY_SUBMISSION_REFUSED');
    await expectMessage(() => admin.query(`SELECT freehold.monetary_report_transition($1,$2,'APPROVED_INTERNALLY')`, [ids.risk, report.reportId]), 'MONETARY_STATE');
    await item(admin, `SELECT freehold.monetary_report_transition($1,$2,'PENDING_REVIEW') AS item`, [ids.risk, report.reportId]);
    await expectMessage(() => admin.query(`SELECT freehold.monetary_report_transition($1,$2,'APPROVED_INTERNALLY')`, [ids.risk, report.reportId]), 'MONETARY_SELF_APPROVAL');
    const internal = await item(admin, `SELECT freehold.monetary_report_transition($1,$2,'APPROVED_INTERNALLY') AS item`, [ids.policy, report.reportId]);
    assert.equal(internal.submissionStatus, 'NOT_SUBMITTED');
    await expectMessage(() => admin.query(`SELECT freehold.monetary_report_transition($1,$2,'READY_FOR_AUTHORIZED_SUBMISSION')`, [ids.policy, report.reportId]), 'MONETARY_STATE');
    await item(admin, `SELECT freehold.monetary_report_transition($1,$2,'EXTERNAL_REVIEW_REQUIRED') AS item`, [ids.policy, report.reportId]);
    await expectMessage(() => admin.query(`SELECT freehold.monetary_report_transition($1,$2,'READY_FOR_AUTHORIZED_SUBMISSION')`, [ids.policy, report.reportId]), 'MONETARY_STATE');
    const certification = await item(admin, `SELECT freehold.monetary_report_transition($1,$2,'CERTIFICATION_REQUIRED') AS item`, [ids.policy, report.reportId]);
    assert.equal(certification.certificationRequirement, 'EXTERNAL_ACCOUNTANT_REQUIRED');
    assert.equal(certification.certificationStatus, 'NOT_CERTIFIED');
    const ready = await item(admin, `SELECT freehold.monetary_report_transition($1,$2,'READY_FOR_AUTHORIZED_SUBMISSION') AS item`, [ids.policy, report.reportId]);
    assert.equal(ready.state, 'READY_FOR_AUTHORIZED_SUBMISSION');
    assert.equal(ready.submissionStatus, 'NOT_SUBMITTED');
    assert.equal(ready.certificationStatus, 'NOT_CERTIFIED');
    await admin.query('BEGIN');
    await admin.query(`SELECT set_config('freehold.monetary_writer','on',true)`);
    await expectMessage(() => admin.query(`UPDATE freehold.regulatory_reports SET state = 'SUBMITTED_WITH_EVIDENCE' WHERE id = $1`, [report.reportId]), 'MONETARY_SUBMISSION_REFUSED');
    await admin.query('ROLLBACK');
    await admin.query('BEGIN');
    await admin.query(`SELECT set_config('freehold.monetary_writer','on',true)`);
    await assert.rejects(admin.query(`UPDATE freehold.regulatory_reports SET certification_status = 'CERTIFIED' WHERE id = $1`, [report.reportId]), error => error.code === '23514');
    await admin.query('ROLLBACK');

    await item(admin, 'SELECT freehold.monetary_freeze_units($1,$2,$3,100,true) AS item', [ids.compliance, FUSD, ids.customer]);
    await expectMessage(() => admin.query('SELECT freehold.monetary_freeze_units($1,$2,$1,1,true)', [ids.customer, FUSD]), 'MONETARY_FORBIDDEN');
    await item(admin, 'SELECT freehold.monetary_freeze_units($1,$2,$3,100,false) AS item', [ids.emergency1, FUSD, ids.customer]);

    const supplyRow = (await admin.query(`
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
      FROM freehold.monetary_supply s, i, r, h, c WHERE s.book_id = $1`, [FUSD])).rows[0];
    assert.equal(supplyRow.outstanding, supplyRow.reconstructed);
    assert.equal(supplyRow.outstanding, supplyRow.holders);
    assert.equal(supplyRow.pending_issuance, supplyRow.pending_i);
    assert.equal(supplyRow.pending_redemption, supplyRow.pending_r);
    assert.equal(supplyRow.pending_h, supplyRow.pending_r);

    const started = Date.now();
    for (let n = 0; n < 8; n += 1) {
      const row = await item(admin, 'SELECT freehold.monetary_issue_request($1,$2,10,NULL,$3) AS item', [ids.requester, FUSD, key()]);
      await item(admin, 'SELECT freehold.monetary_issue_verify($1,$2) AS item', [ids.treasury, row.issuanceId]);
      await item(admin, 'SELECT freehold.monetary_issue_approve($1,$2) AS item', [ids.approver, row.issuanceId]);
      const done = await item(admin, 'SELECT freehold.monetary_issue_execute($1,$2) AS item', [ids.executor, row.issuanceId]);
      assert.equal(done.state, 'ISSUED');
    }
    console.log(`PHASE10_PERF issuances=8 elapsedMs=${Date.now() - started} notComparableToPhase7=313.887/s`);

    const position = (await admin.query('SELECT outstanding::text AS outstanding, pending_issuance::text AS pending FROM freehold.monetary_supply WHERE book_id = $1', [FUSD])).rows[0];
    const capMax = (BigInt(position.outstanding) + BigInt(position.pending) + 100n).toString();
    const cap = await item(admin, 'SELECT freehold.monetary_cap_request($1,$2,$3,$4) AS item', [ids.policy, FUSD, capMax, key()]);
    await item(admin, 'SELECT freehold.monetary_cap_approve($1,$2) AS item', [ids.risk, cap.requestId]);
    const raceKeyA = key();
    const raceKeyB = key();
    const raced = await Promise.all([
      admin.query('SELECT freehold.monetary_issue_request($1,$2,80,NULL,$3) AS item', [ids.requester, FUSD, raceKeyA]),
      admin2.query('SELECT freehold.monetary_issue_request($1,$2,80,NULL,$3) AS item', [ids.requester, FUSD, raceKeyB]),
    ]);
    const states = raced.map(result => result.rows[0].item.state).sort();
    assert.deepEqual(states, ['PENDING_RESERVE_VERIFICATION', 'REJECTED']);
    const restore = await item(admin, 'SELECT freehold.monetary_cap_request($1,$2,1000000000000,$3) AS item', [ids.policy, FUSD, key()]);
    await item(admin, 'SELECT freehold.monetary_cap_approve($1,$2) AS item', [ids.risk, restore.requestId]);

    const rollbackKey = key();
    await admin.query('BEGIN');
    await admin.query('SELECT freehold.monetary_issue_request($1,$2,5,NULL,$3)', [ids.requester, FUSD, rollbackKey]);
    await admin.query('ROLLBACK');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.issuance_operations WHERE idempotency_key = $1', [rollbackKey])).rows[0].n, 0);
    const victim = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
    victim.on('error', () => undefined);
    await victim.connect();
    const victimKey = key();
    const beforeTerminate = (await admin.query('SELECT outstanding::text AS n FROM freehold.monetary_supply WHERE book_id = $1', [FUSD])).rows[0].n;
    await victim.query('BEGIN');
    await victim.query('SELECT freehold.monetary_issue_request($1,$2,5,NULL,$3)', [ids.requester, FUSD, victimKey]);
    const pid = (await victim.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await admin.query('SELECT pg_terminate_backend($1::int)', [pid]);
    await victim.end().catch(() => undefined);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.issuance_operations WHERE idempotency_key = $1', [victimKey])).rows[0].n, 0);
    assert.equal((await admin.query('SELECT outstanding::text AS n FROM freehold.monetary_supply WHERE book_id = $1', [FUSD])).rows[0].n, beforeTerminate);
    const interrupt = await item(admin, 'SELECT freehold.monetary_issue_request($1,$2,6,NULL,$3) AS item', [ids.requester, FUSD, key()]);
    const victim2 = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
    victim2.on('error', () => undefined);
    await victim2.connect();
    await victim2.query('BEGIN');
    await victim2.query('SELECT freehold.monetary_issue_verify($1,$2)', [ids.treasury, interrupt.issuanceId]);
    const pid2 = (await victim2.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await admin.query('SELECT pg_terminate_backend($1::int)', [pid2]);
    await victim2.end().catch(() => undefined);
    assert.equal((await admin.query('SELECT state FROM freehold.issuance_operations WHERE id = $1', [interrupt.issuanceId])).rows[0].state, 'PENDING_RESERVE_VERIFICATION');

    const observed = (await admin.query('SELECT outstanding::text AS n FROM freehold.monetary_supply WHERE book_id = $1', [FUSD])).rows[0].n;
    const tx = `mock-${randomUUID()}`;
    const seen = await item(admin, 'SELECT freehold.monetary_chain_observe($1,$2,\'ISSUE\',$3,\'NOT_FINAL\',1,$4) AS item', [ids.security1, FUSD, tx, observed]);
    assert.equal(seen.supplyChanged, false);
    await expectMessage(() => admin.query('SELECT freehold.monetary_chain_reorg($1,$2)', [ids.security1, tx]), 'MONETARY_SELF_APPROVAL');
    const reorg = await item(admin, 'SELECT freehold.monetary_chain_reorg($1,$2) AS item', [ids.security2, tx]);
    assert.equal(reorg.finality, 'REORGED');
    assert.equal(reorg.supplyChanged, false);
    await expectMessage(() => admin.query('SELECT freehold.monetary_chain_observe($1,$2,\'ISSUE\',$3,\'FINAL\',11,$4)', [ids.security1, FUSD, `mock-${randomUUID()}`, observed]), 'MONETARY_STATE');
    const accounting = await verifyLedger(verifier);
    const accountingSplit = splitViolations(accounting);
    assert.deepEqual(accountingSplit.monetary, [], JSON.stringify(accounting.accountingViolations?.slice(0, 5) ?? accounting.error));
    assert.deepEqual(accountingSplit.other, baselineSplit.other);
    assert.equal(accounting.externalReserveOutcome, 'EXTERNAL_EVIDENCE_UNAVAILABLE');
    assert.equal(accounting.monetary.simulatedReservesAreExternalEvidence, false);
    if (baseline.accountingOutcome === 'VERIFIED') {
      assert.equal(accounting.accountingOutcome, 'VERIFIED');
      assert.equal(accounting.outcome, 'EXTERNAL_EVIDENCE_UNAVAILABLE');
    }
    await item(admin, 'SELECT freehold.monetary_chain_observe($1,$2,\'ISSUE\',$3,\'FINAL\',12,$4) AS item', [ids.security1, FUSD, `mock-${randomUUID()}`, observed]);
    const matched = await verifyLedger(verifier);
    assert.deepEqual(splitViolations(matched).monetary, []);
    assert.deepEqual(splitViolations(matched).other, baselineSplit.other);
    assert.equal(matched.externalReserveOutcome, 'EXTERNAL_EVIDENCE_UNAVAILABLE');
    if (baseline.accountingOutcome === 'VERIFIED') assert.equal(matched.accountingOutcome, 'VERIFIED');
    await item(admin, 'SELECT freehold.monetary_chain_observe($1,$2,\'ISSUE\',$3,\'FINAL\',12,1) AS item', [ids.security1, FUSD, `mock-${randomUUID()}`]);
    const mismatched = await verifyLedger(verifier);
    assert.equal(mismatched.accountingOutcome, 'MISMATCH');
    assert.ok(mismatched.accountingViolations.some(row => row.code === 'MONETARY_CHAIN_SUPPLY_MISMATCH' && row.book === 'FUSD_SIM'));
    assert.deepEqual(splitViolations(mismatched).other, baselineSplit.other);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.ledger_journals')).rows[0].n, journalsAfterFund);
    assert.equal((await admin.query('SELECT available_minor::text AS n FROM freehold.accounts WHERE id = $1', [account])).rows[0].n, '10000');
  } finally {
    await Promise.all([admin.end(), admin2.end(), api.end(), worker.end(), verifier.end()].map(job => job.catch(() => undefined)));
  }
});
