import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { verifyLedger } from '../scripts/lib/ledger-verifier.mjs';
import { credentialHash, simulatedSettlementSignature } from '../scripts/lib/institution-provider.mjs';

const ENTITY = '10000000-0000-4000-8000-000000000001';
const OTHER_ENTITY = '10000000-0000-4000-8000-000000000005';
const SIM_KEY = 'phase12-simulator-key';
const admin = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
const api = new Client({ connectionString: process.env.DATABASE_URL });
const worker = new Client({ connectionString: process.env.WORKER_DATABASE_URL });
const workerB = new Client({ connectionString: process.env.WORKER_DATABASE_URL });
const verifier = new Client({ connectionString: process.env.VERIFY_DATABASE_URL });

const item = async (client, sql, params = []) => (await client.query(sql, params)).rows[0].item;
const expectMessage = async (fn, message) => {
  await assert.rejects(fn, error => {
    assert.equal(error.message, message, `${error.code ?? ''} ${error.message}`);
    return true;
  });
};
const institutionCodes = report => report.accountingViolations.filter(row => String(row.code).startsWith('INSTITUTION_')).map(row => row.code);

async function tx(client, fn) {
  await client.query('BEGIN');
  try {
    if (client === admin || client === api) {
      await client.query(`SELECT set_config('freehold.bank_simulator_key',$1,true)`, [SIM_KEY]);
    }
    const value = await fn();
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

test('phase 12 keeps institutional tenants, settlement, and billing off the customer ledger', async () => {
  await Promise.all([admin.connect(), api.connect(), worker.connect(), workerB.connect(), verifier.connect()]);
  const names = ['northAdmin', 'harborAdmin', 'northPay', 'northGov', 'northGov2', 'northDev', 'northComp', 'outsider'];
  const ids = Object.fromEntries(names.map(name => [name, randomUUID()]));
  const stamp = randomUUID().slice(0, 8);
  const journalsBefore = (await admin.query('SELECT count(*)::int AS n FROM freehold.ledger_journals')).rows[0].n;
  const availableBefore = (await admin.query('SELECT COALESCE(sum(available_minor),0)::text AS n FROM freehold.accounts')).rows[0].n;
  const supplyBefore = (await admin.query(`SELECT outstanding::text AS n FROM freehold.monetary_supply WHERE book_id = '20000000-0000-4000-8000-000000000001'`)).rows[0].n;
  let badJournal = null;
  let crossedPayment = null;
  let crossedEntity = null;
  try {
    const values = names.flatMap(name => [ids[name], `p12-${name.toLowerCase()}-${ids[name].slice(0, 8)}@example.test`]);
    const placeholders = names.map((_, index) => `($${index * 2 + 1},$${index * 2 + 2},$${names.length * 2 + 1},$${names.length * 2 + 2 + index})`).join(',');
    const roles = names.map(name => name.endsWith('Admin') ? 'ADMIN' : 'USER');
    await admin.query(
      `INSERT INTO freehold.users(id,email_normalized,password_hash,role) VALUES ${placeholders}`,
      [...values, 'phase12-unused-password-hash', ...roles],
    );

    await assert.rejects(
      () => api.query('SELECT freehold.institution_outbox_claim($1::uuid,$2::integer)', [randomUUID(), 30]),
      error => error.message.includes('permission denied for function institution_outbox_claim'),
    );
    await assert.rejects(
      () => api.query('SELECT id FROM freehold.institution_payments'),
      error => error.message.includes('permission denied for table institution_payments'),
    );
    await assert.rejects(
      () => verifier.query('SELECT freehold.institution_open($1::uuid,$2::text,$3::text)', [ids.northAdmin, `x-${stamp}`, 'Denied Institution']),
      error => error.message.includes('permission denied for function institution_open'),
    );
    await verifier.query('SELECT count(*) FROM freehold.institutions');

    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_open($1::uuid,$2::text,$3::text) AS item', [ids.outsider, `out-${stamp}`, 'Outsider Institution']),
      'INSTITUTION_FORBIDDEN',
    );
    const north = await item(admin, 'SELECT freehold.institution_open($1::uuid,$2::text,$3::text) AS item', [ids.northAdmin, `north-${stamp}`, 'Northwind Sandbox Institution']);
    const harbor = await item(admin, 'SELECT freehold.institution_open($1::uuid,$2::text,$3::text) AS item', [ids.harborAdmin, `harbor-${stamp}`, 'Harbor Sandbox Institution']);
    assert.equal(north.liveAuthorized, false);
    assert.equal(harbor.status, 'SIMULATED_SANDBOX');
    const northList = await item(admin, 'SELECT freehold.institution_list($1::uuid) AS item', [ids.northAdmin]);
    const harborList = await item(admin, 'SELECT freehold.institution_list($1::uuid) AS item', [ids.harborAdmin]);
    assert.deepEqual(northList.institutions.map(row => row.institutionId), [north.institutionId]);
    assert.deepEqual(harborList.institutions.map(row => row.institutionId), [harbor.institutionId]);
    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_grant($1::uuid,$2::uuid,$3::uuid,$4::text) AS item', [ids.northAdmin, north.institutionId, ids.northAdmin, 'AUDITOR']),
      'INSTITUTION_SELF_APPROVAL',
    );
    for (const [member, capability] of [
      [ids.northPay, 'PAYMENTS'], [ids.northGov, 'GOVERNANCE'], [ids.northGov, 'PAYMENTS'], [ids.northGov, 'COMPLIANCE'],
      [ids.northGov2, 'GOVERNANCE'], [ids.northDev, 'DEVELOPER'], [ids.northComp, 'COMPLIANCE'],
    ]) {
      await item(admin, 'SELECT freehold.institution_grant($1::uuid,$2::uuid,$3::uuid,$4::text) AS item', [ids.northAdmin, north.institutionId, member, capability]);
    }
    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_credential_issue($1::uuid,$2::uuid,$3::text[],$4::integer) AS item', [ids.northGov, north.institutionId, ['accounts:read'], 600]),
      'INSTITUTION_FORBIDDEN',
    );

    const northCustomer = await item(admin, 'SELECT freehold.institution_customer_open($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item', [ids.northAdmin, north.institutionId, `n-${stamp}`, 'North Customer', 'USD']);
    const northOther = await item(admin, 'SELECT freehold.institution_customer_open($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item', [ids.northAdmin, north.institutionId, `o-${stamp}`, 'North Other', 'USD']);
    const harborCustomer = await item(admin, 'SELECT freehold.institution_customer_open($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item', [ids.harborAdmin, harbor.institutionId, `h-${stamp}`, 'Harbor Customer', 'USD']);
    await item(admin, 'SELECT freehold.institution_fund_simulated($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::uuid) AS item', [ids.northAdmin, north.institutionId, northCustomer.accountId, '500000', `fund-${stamp}`, randomUUID()]);
    await item(admin, 'SELECT freehold.institution_fund_simulated($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::uuid) AS item', [ids.harborAdmin, harbor.institutionId, harborCustomer.accountId, '50', `hfund-${stamp}`, randomUUID()]);
    const again = await item(admin, 'SELECT freehold.institution_fund_simulated($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::uuid) AS item', [ids.northAdmin, north.institutionId, northCustomer.accountId, '500000', `fund-${stamp}`, randomUUID()]);
    assert.equal(again.externalAsset, false);
    const funded = await item(admin, 'SELECT freehold.institution_account_get($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid) AS item', [ids.northAdmin, north.institutionId, northCustomer.accountId]);
    assert.equal(funded.balanceMinor, '500000');
    assert.equal(funded.countsAsExternalAsset, false);

    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_account_get($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid) AS item', [ids.harborAdmin, harbor.institutionId, northCustomer.accountId]),
      'INSTITUTION_FORBIDDEN',
    );
    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_transfer($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::text,$7::uuid) AS item', [ids.northAdmin, north.institutionId, northCustomer.accountId, harborCustomer.accountId, '1', `cross-${stamp}`, randomUUID()]),
      'INSTITUTION_FORBIDDEN',
    );
    await expectMessage(
      () => item(admin, 'UPDATE freehold.institution_ledger_accounts SET balance_minor = balance_minor + 1 WHERE id = $1', [northCustomer.accountId]),
      'INSTITUTION_DIRECT_WRITE_FORBIDDEN',
    );

    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_credential_issue($1::uuid,$2::uuid,$3::text[],$4::integer) AS item', [ids.northDev, north.institutionId, ['transfers:write', 'accounts:read'], 600]),
      'INSTITUTION_SCOPE',
    );
    const credential = await item(admin, 'SELECT freehold.institution_credential_issue($1::uuid,$2::uuid,$3::text[],$4::integer) AS item', [ids.northAdmin, north.institutionId, ['transfers:write', 'accounts:read', 'payments:write', 'treasury:read', 'billing:read'], 3600]);
    assert.equal(credential.secretShownOnce, true);
    assert.match(credential.keyId, /^fh_sandbox_[0-9a-f]{24}$/);
    const secret = credential.secret;
    const hash = credentialHash(secret);
    const nonce = `nonce-${stamp}-1`;
    const moved = await item(api, 'SELECT freehold.institution_transfer($1::uuid,$2::text,$3::text,$4::text,$5::uuid,$6::uuid,$7::uuid,$8::bigint,$9::text,$10::uuid) AS item', [ids.northAdmin, credential.keyId, hash, nonce, north.institutionId, northCustomer.accountId, northOther.accountId, '10', `api-${stamp}`, randomUUID()]);
    assert.equal(moved.duplicate, false);
    const replayed = await item(api, 'SELECT freehold.institution_transfer($1::uuid,$2::text,$3::text,$4::text,$5::uuid,$6::uuid,$7::uuid,$8::bigint,$9::text,$10::uuid) AS item', [ids.northAdmin, credential.keyId, hash, `nonce-${stamp}-dup`, north.institutionId, northCustomer.accountId, northOther.accountId, '10', `api-${stamp}`, randomUUID()]);
    assert.equal(replayed.duplicate, true);
    assert.equal(replayed.journalId, moved.journalId);
    await expectMessage(
      () => item(api, 'SELECT freehold.institution_account_get($1::uuid,$2::text,$3::text,$4::text,$5::uuid,$6::uuid) AS item', [ids.northAdmin, credential.keyId, hash, nonce, north.institutionId, northCustomer.accountId]),
      'INSTITUTION_REPLAY',
    );
    await expectMessage(
      () => item(api, 'SELECT freehold.institution_account_get($1::uuid,$2::text,$3::text,$4::text,$5::uuid,$6::uuid) AS item', [ids.northAdmin, credential.keyId, credentialHash('forged-secret'), `nonce-${stamp}-forged`, north.institutionId, northCustomer.accountId]),
      'INSTITUTION_CREDENTIAL',
    );
    await expectMessage(
      () => item(api, 'SELECT freehold.institution_account_get($1::uuid,$2::text,$3::text,$4::text,$5::uuid,$6::uuid) AS item', [ids.northAdmin, credential.keyId, hash, `nonce-${stamp}-other`, harbor.institutionId, harborCustomer.accountId]),
      'INSTITUTION_FORBIDDEN',
    );
    await admin.query(`UPDATE freehold.institution_credentials SET expires_at = clock_timestamp() - interval '1 minute' WHERE key_id = $1`, [credential.keyId]);
    await expectMessage(
      () => item(api, 'SELECT freehold.institution_account_get($1::uuid,$2::text,$3::text,$4::text,$5::uuid,$6::uuid) AS item', [ids.northAdmin, credential.keyId, hash, `nonce-${stamp}-expired`, north.institutionId, northCustomer.accountId]),
      'INSTITUTION_EXPIRED',
    );
    await admin.query(`UPDATE freehold.institution_credentials SET expires_at = clock_timestamp() + interval '1 hour' WHERE key_id = $1`, [credential.keyId]);
    await item(admin, 'SELECT freehold.institution_credential_revoke($1::uuid,$2::uuid,$3::text) AS item', [ids.northDev, north.institutionId, credential.keyId]);
    await expectMessage(
      () => item(api, 'SELECT freehold.institution_account_get($1::uuid,$2::text,$3::text,$4::text,$5::uuid,$6::uuid) AS item', [ids.northAdmin, credential.keyId, hash, `nonce-${stamp}-revoked`, north.institutionId, northCustomer.accountId]),
      'INSTITUTION_REVOKED',
    );

    const fresh = await item(admin, 'SELECT freehold.institution_credential_issue($1::uuid,$2::uuid,$3::text[],$4::integer) AS item', [ids.northDev, north.institutionId, ['accounts:read'], 3600]);
    await admin.query(`UPDATE freehold.institution_policies SET threshold_minor = 2 WHERE institution_id = $1 AND code = 'RATE_PER_MINUTE'`, [north.institutionId]);
    await item(api, 'SELECT freehold.institution_account_get($1::uuid,$2::text,$3::text,$4::text,$5::uuid,$6::uuid) AS item', [ids.northAdmin, fresh.keyId, credentialHash(fresh.secret), `rate-${stamp}-1`, north.institutionId, northCustomer.accountId]);
    await item(api, 'SELECT freehold.institution_account_get($1::uuid,$2::text,$3::text,$4::text,$5::uuid,$6::uuid) AS item', [ids.northAdmin, fresh.keyId, credentialHash(fresh.secret), `rate-${stamp}-2`, north.institutionId, northCustomer.accountId]);
    await expectMessage(
      () => item(api, 'SELECT freehold.institution_account_get($1::uuid,$2::text,$3::text,$4::text,$5::uuid,$6::uuid) AS item', [ids.northAdmin, fresh.keyId, credentialHash(fresh.secret), `rate-${stamp}-3`, north.institutionId, northCustomer.accountId]),
      'INSTITUTION_RATE',
    );
    await admin.query(`UPDATE freehold.institution_policies SET threshold_minor = 1000 WHERE institution_id = $1 AND code = 'RATE_PER_MINUTE'`, [north.institutionId]);

    const started = Date.now();
    for (let index = 0; index < 200; index += 1) {
      await item(admin, 'SELECT freehold.institution_transfer($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::text,$7::uuid) AS item', [ids.northAdmin, north.institutionId, northCustomer.accountId, northOther.accountId, '1', `loop-${stamp}-${index}`, randomUUID()]);
    }
    console.log(`INSTITUTION_PERF transfers=200 elapsedMs=${Date.now() - started} notComparableToPhase7=313.887/s`);
    const concurrent = await Promise.all([0, 1].map(index => item(admin, 'SELECT freehold.institution_transfer($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::text,$7::uuid) AS item', [ids.northAdmin, north.institutionId, northCustomer.accountId, northOther.accountId, '10', `conc-${stamp}-${index}`, randomUUID()])));
    assert.equal(new Set(concurrent.map(row => row.journalId)).size, 2);
    const afterTransfers = await item(admin, 'SELECT freehold.institution_account_get($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid) AS item', [ids.northAdmin, north.institutionId, northCustomer.accountId]);
    const otherBalance = await item(admin, 'SELECT freehold.institution_account_get($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid) AS item', [ids.northAdmin, north.institutionId, northOther.accountId]);
    assert.equal(afterTransfers.balanceMinor, '499770');
    assert.equal(otherBalance.balanceMinor, '230');

    await item(admin, 'SELECT freehold.institution_policy_set($1::uuid,$2::uuid,$3::text,$4::bigint) AS item', [ids.northAdmin, north.institutionId, 'PAYMENT_APPROVAL_MINOR', '100']);
    const high = await item(admin, 'SELECT freehold.institution_payment_open($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::text,$7::text,$8::uuid) AS item', [ids.northPay, north.institutionId, northCustomer.accountId, '500', 'ACH', `high-${stamp}`, `high-key-${stamp}`, randomUUID()]);
    const duplicatePayment = await item(admin, 'SELECT freehold.institution_payment_open($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::text,$7::text,$8::uuid) AS item', [ids.northPay, north.institutionId, northCustomer.accountId, '500', 'ACH', `high-${stamp}`, `high-key-${stamp}`, randomUUID()]);
    assert.equal(duplicatePayment.duplicate, true);
    assert.equal(duplicatePayment.paymentId, high.paymentId);
    const paymentHash = (await admin.query('SELECT request_hash FROM freehold.institution_payments WHERE id = $1', [high.paymentId])).rows[0].request_hash;
    assert.match(paymentHash, /^[0-9a-f]{64}$/);
    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_payment_open($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::text,$7::text,$8::uuid) AS item', [ids.northPay, north.institutionId, northCustomer.accountId, '501', 'ACH', `high-${stamp}`, `high-key-${stamp}`, randomUUID()]),
      'INSTITUTION_IDEMPOTENCY_CONFLICT',
    );
    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_payment_open($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::text,$7::text,$8::uuid) AS item', [ids.northPay, north.institutionId, northCustomer.accountId, '500', 'ACH', `high-${stamp}`, `high-key-other-${stamp}`, randomUUID()]),
      'INSTITUTION_IDEMPOTENCY_CONFLICT',
    );
    const concurrentPaymentKey = `conc-pay-${stamp}`;
    const concurrentPaymentRef = `conc-pay-ref-${stamp}`;
    const peer = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
    await peer.connect();
    let concurrentPayments;
    try {
      concurrentPayments = await Promise.all([admin, peer].map(client => item(client,
        'SELECT freehold.institution_payment_open($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::text,$7::text,$8::uuid) AS item',
        [ids.northPay, north.institutionId, northCustomer.accountId, '7', 'RTP', concurrentPaymentRef, concurrentPaymentKey, randomUUID()])));
    } finally { await peer.end(); }
    assert.equal(new Set(concurrentPayments.map(row => row.paymentId)).size, 1);
    assert.equal(concurrentPayments.filter(row => row.duplicate === false).length, 1);
    assert.equal(concurrentPayments.filter(row => row.duplicate === true).length, 1);
    const concurrentPaymentRows = (await admin.query('SELECT count(*)::int AS n FROM freehold.institution_payments WHERE idempotency_key = $1', [concurrentPaymentKey])).rows[0].n;
    assert.equal(concurrentPaymentRows, 1);
    await item(admin, 'SELECT freehold.institution_payment_transition($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::text,NULL,NULL) AS item', [ids.northPay, north.institutionId, high.paymentId, 'VALIDATING']);
    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_payment_transition($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::text,NULL,NULL) AS item', [ids.northPay, north.institutionId, high.paymentId, 'READY_TO_SUBMIT']),
      'INSTITUTION_APPROVAL',
    );
    await item(admin, 'SELECT freehold.institution_payment_transition($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::text,NULL,NULL) AS item', [ids.northPay, north.institutionId, high.paymentId, 'PENDING_APPROVAL']);
    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_payment_transition($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::text,NULL,NULL) AS item', [ids.northPay, north.institutionId, high.paymentId, 'READY_TO_SUBMIT']),
      'INSTITUTION_APPROVAL',
    );
    const approved = await item(admin, 'SELECT freehold.institution_payment_transition($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::text,NULL,NULL) AS item', [ids.northGov, north.institutionId, high.paymentId, 'READY_TO_SUBMIT']);
    assert.equal(approved.state, 'READY_TO_SUBMIT');
    await item(admin, 'SELECT freehold.institution_payment_transition($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::text,NULL,NULL) AS item', [ids.northGov, north.institutionId, high.paymentId, 'CANCELLED']);

    const low = await item(admin, 'SELECT freehold.institution_payment_open($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::text,$7::text,$8::uuid) AS item', [ids.northPay, north.institutionId, northCustomer.accountId, '25', 'FEDWIRE', `low-${stamp}`, `low-key-${stamp}`, randomUUID()]);
    for (const state of ['VALIDATING', 'READY_TO_SUBMIT', 'SUBMITTED', 'ACKNOWLEDGED', 'PENDING_SETTLEMENT']) {
      const step = await item(admin, 'SELECT freehold.institution_payment_transition($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::text,NULL,NULL) AS item', [ids.northPay, north.institutionId, low.paymentId, state]);
      assert.equal(step.liveSubmission, false);
    }
    assert.equal((await item(admin, 'SELECT freehold.institution_account_get($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid) AS item', [ids.northAdmin, north.institutionId, northCustomer.accountId])).balanceMinor, '499770');
    const eventId = `evt-${stamp}`;
    const badSignature = simulatedSettlementSignature({ institutionId: north.institutionId, paymentId: low.paymentId, providerEventId: eventId, amountMinor: '25', key: 'wrong-key' });
    await expectMessage(
      () => tx(admin, () => item(admin, 'SELECT freehold.institution_payment_transition($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::text,$5::text,$6::text) AS item', [ids.northPay, north.institutionId, low.paymentId, 'SETTLED', eventId, badSignature])),
      'INSTITUTION_SIGNATURE',
    );
    const stillPending = (await admin.query('SELECT state, settlement_journal_id FROM freehold.institution_payments WHERE id = $1', [low.paymentId])).rows[0];
    assert.equal(stillPending.state, 'PENDING_SETTLEMENT');
    assert.equal(stillPending.settlement_journal_id, null);
    const signature = simulatedSettlementSignature({ institutionId: north.institutionId, paymentId: low.paymentId, providerEventId: eventId, amountMinor: '25', key: SIM_KEY });
    const settled = await tx(admin, () => item(admin, 'SELECT freehold.institution_payment_transition($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::text,$5::text,$6::text) AS item', [ids.northPay, north.institutionId, low.paymentId, 'SETTLED', eventId, signature]));
    assert.equal(settled.state, 'SETTLED');
    assert.equal(settled.finality, 'SETTLED_SIMULATED');
    assert.equal(settled.externalSettlement, false);
    const settledAgain = await tx(admin, () => item(admin, 'SELECT freehold.institution_payment_transition($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::text,$5::text,$6::text) AS item', [ids.northPay, north.institutionId, low.paymentId, 'FAILED', eventId, signature]));
    assert.equal(settledAgain.duplicate, true);
    assert.equal(settledAgain.state, 'SETTLED');
    const journalsForSettle = (await admin.query(`SELECT count(*)::int AS n FROM freehold.institution_journals WHERE idempotency_key = $1`, [`settle:${low.paymentId}`])).rows[0].n;
    assert.equal(journalsForSettle, 1);
    const returned = await item(admin, 'SELECT freehold.institution_payment_transition($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::text,$5::text,NULL) AS item', [ids.northPay, north.institutionId, low.paymentId, 'RETURNED', `ret-${stamp}`]);
    assert.equal(returned.state, 'RETURNED');
    assert.equal((await item(admin, 'SELECT freehold.institution_account_get($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid) AS item', [ids.northAdmin, north.institutionId, northCustomer.accountId])).balanceMinor, '499770');

    const unknown = await item(admin, 'SELECT freehold.institution_payment_open($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::text,$7::text,$8::uuid) AS item', [ids.northPay, north.institutionId, northCustomer.accountId, '5', 'RTP', `unk-${stamp}`, `unk-key-${stamp}`, randomUUID()]);
    for (const state of ['VALIDATING', 'READY_TO_SUBMIT', 'SUBMITTED']) {
      await item(admin, 'SELECT freehold.institution_payment_transition($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::text,NULL,NULL) AS item', [ids.northPay, north.institutionId, unknown.paymentId, state]);
    }
    const unknownStep = await item(admin, 'SELECT freehold.institution_payment_transition($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::text,$5::text,NULL) AS item', [ids.northPay, north.institutionId, unknown.paymentId, 'UNKNOWN', `unk-evt-${stamp}`]);
    assert.equal(unknownStep.state, 'UNKNOWN');
    const unknownEvents = (await admin.query(`SELECT count(*)::int AS n FROM freehold.institution_webhook_events WHERE payment_id = $1 AND event_type = 'payment.settled'`, [unknown.paymentId])).rows[0].n;
    assert.equal(unknownEvents, 0);
    const resolved = await item(admin, 'SELECT freehold.institution_payment_transition($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::text,NULL,NULL) AS item', [ids.northPay, north.institutionId, unknown.paymentId, 'FAILED']);
    assert.equal(resolved.state, 'FAILED');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.institution_payments WHERE idempotency_key = $1', [`unk-key-${stamp}`])).rows[0].n, 1);

    const endpoint = await item(admin, 'SELECT freehold.institution_webhook_open($1::uuid,$2::uuid,$3::text) AS item', [ids.northDev, north.institutionId, `https://example.test/north/${stamp}`]);
    const harborEndpoint = await item(admin, 'SELECT freehold.institution_webhook_open($1::uuid,$2::uuid,$3::text) AS item', [ids.harborAdmin, harbor.institutionId, `https://example.test/harbor/${stamp}`]);
    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_webhook_subscribe($1::uuid,$2::uuid,$3::uuid,$4::text) AS item', [ids.northDev, north.institutionId, harborEndpoint.endpointId, 'payment.created']),
      'INSTITUTION_FORBIDDEN',
    );
    await item(admin, 'SELECT freehold.institution_webhook_subscribe($1::uuid,$2::uuid,$3::uuid,$4::text) AS item', [ids.northDev, north.institutionId, endpoint.endpointId, 'payment.created']);
    const hooked = await item(admin, 'SELECT freehold.institution_payment_open($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::text,$7::text,$8::uuid) AS item', [ids.northPay, north.institutionId, northCustomer.accountId, '4', 'BANK_INTERNAL', `hook-${stamp}`, `hook-key-${stamp}`, randomUUID()]);
    const delivery = (await admin.query(`SELECT d.id FROM freehold.institution_webhook_deliveries d JOIN freehold.institution_webhook_events e ON e.id = d.event_id WHERE e.payment_id = $1 AND d.state = 'PENDING'`, [hooked.paymentId])).rows[0];
    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_webhook_attempt($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text) AS item', [ids.northDev, north.institutionId, delivery.id, 'DELIVERED_SIMULATED', 'wrong-secret']),
      'INSTITUTION_SIGNATURE',
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await item(admin, 'SELECT freehold.institution_webhook_attempt($1::uuid,$2::uuid,$3::uuid,$4::text,NULL) AS item', [ids.northDev, north.institutionId, delivery.id, 'FAILED']);
    }
    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_webhook_attempt($1::uuid,$2::uuid,$3::uuid,$4::text,NULL) AS item', [ids.northDev, north.institutionId, delivery.id, 'FAILED']),
      'INSTITUTION_DEAD_LETTER',
    );
    const hookedAgain = await item(admin, 'SELECT freehold.institution_payment_open($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::text,$7::text,$8::uuid) AS item', [ids.northPay, north.institutionId, northCustomer.accountId, '4', 'BANK_INTERNAL', `hook2-${stamp}`, `hook2-key-${stamp}`, randomUUID()]);
    const deliveryAgain = (await admin.query(`SELECT d.id FROM freehold.institution_webhook_deliveries d JOIN freehold.institution_webhook_events e ON e.id = d.event_id WHERE e.payment_id = $1`, [hookedAgain.paymentId])).rows[0];
    const delivered = await item(admin, 'SELECT freehold.institution_webhook_attempt($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text) AS item', [ids.northDev, north.institutionId, deliveryAgain.id, 'DELIVERED_SIMULATED', endpoint.secret]);
    assert.equal(delivered.exactlyOnce, false);
    assert.equal(delivered.duplicate, false);
    assert.match(delivered.signature, /^[0-9a-f]{64}$/);
    const deliveredAgain = await item(admin, 'SELECT freehold.institution_webhook_attempt($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text) AS item', [ids.northDev, north.institutionId, deliveryAgain.id, 'DELIVERED_SIMULATED', endpoint.secret]);
    assert.equal(deliveredAgain.duplicate, true);
    const rotated = await item(admin, 'SELECT freehold.institution_webhook_rotate($1::uuid,$2::uuid,$3::uuid) AS item', [ids.northDev, north.institutionId, endpoint.endpointId]);
    assert.equal(rotated.previousSecretRetained, false);
    const hookedThird = await item(admin, 'SELECT freehold.institution_payment_open($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::text,$7::text,$8::uuid) AS item', [ids.northPay, north.institutionId, northCustomer.accountId, '4', 'STABLECOIN_NETWORK', `hook3-${stamp}`, `hook3-key-${stamp}`, randomUUID()]);
    const deliveryThird = (await admin.query(`SELECT d.id FROM freehold.institution_webhook_deliveries d JOIN freehold.institution_webhook_events e ON e.id = d.event_id WHERE e.payment_id = $1`, [hookedThird.paymentId])).rows[0];
    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_webhook_attempt($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text) AS item', [ids.northDev, north.institutionId, deliveryThird.id, 'DELIVERED_SIMULATED', endpoint.secret]),
      'INSTITUTION_SIGNATURE',
    );
    const rotatedDelivery = await item(admin, 'SELECT freehold.institution_webhook_attempt($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text) AS item', [ids.northDev, north.institutionId, deliveryThird.id, 'DELIVERED_SIMULATED', rotated.secret]);
    assert.equal(rotatedDelivery.state, 'DELIVERED_SIMULATED');

    const paymentsBeforeWorker = (await admin.query('SELECT count(*)::int AS n FROM freehold.institution_payments')).rows[0].n;
    const worker1 = randomUUID();
    const worker2 = randomUUID();
    const firstClaim = await item(worker, 'SELECT freehold.institution_outbox_claim($1::uuid,$2::integer) AS item', [worker1, 0]);
    assert.equal(firstClaim.postsPayments, false);
    assert.ok(firstClaim.ids.length > 0);
    const secondClaim = await item(workerB, 'SELECT freehold.institution_outbox_claim($1::uuid,$2::integer) AS item', [worker2, 30]);
    for (const id of firstClaim.ids) {
      const done = await item(worker, 'SELECT freehold.institution_outbox_complete($1::uuid,$2::uuid) AS item', [worker1, id]);
      assert.equal(done.done, false);
      assert.equal(done.paymentRowsUnchanged, true);
    }
    for (const id of secondClaim.ids) {
      const done = await item(workerB, 'SELECT freehold.institution_outbox_complete($1::uuid,$2::uuid) AS item', [worker2, id]);
      assert.equal(done.done, true);
    }
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.institution_payments')).rows[0].n, paymentsBeforeWorker);

    const reserveA = await item(admin, 'SELECT freehold.institution_treasury_open($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item', [ids.northAdmin, north.institutionId, 'RESERVE', 'USD', 'Simulated Custodian A']);
    const reserveB = await item(admin, 'SELECT freehold.institution_treasury_open($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item', [ids.northAdmin, north.institutionId, 'RESERVE', 'USD', 'Simulated Custodian B']);
    assert.equal(reserveA.countsAsExternalAsset, false);
    assert.equal(reserveA.evidenceState, 'EXTERNAL_UNAVAILABLE');
    const operating = (await admin.query(`SELECT id FROM freehold.institution_ledger_accounts WHERE institution_id = $1 AND kind = 'OPERATING'`, [north.institutionId])).rows[0].id;
    const proposed = await item(admin, 'SELECT freehold.institution_adjustment_propose($1::uuid,$2::uuid,NULL,$3::uuid,$4::uuid,$5::bigint) AS item', [ids.northGov, north.institutionId, reserveA.accountId, operating, '6000']);
    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_adjustment_post($1::uuid,$2::uuid,$3::uuid) AS item', [ids.northGov, north.institutionId, proposed.adjustmentId]),
      'INSTITUTION_SELF_APPROVAL',
    );
    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_adjustment_propose($1::uuid,$2::uuid,NULL,$3::uuid,$4::uuid,$5::bigint) AS item', [ids.northPay, north.institutionId, reserveB.accountId, operating, '4000']),
      'INSTITUTION_FORBIDDEN',
    );
    const posted = await item(admin, 'SELECT freehold.institution_adjustment_post($1::uuid,$2::uuid,$3::uuid) AS item', [ids.northGov2, north.institutionId, proposed.adjustmentId]);
    assert.equal(posted.customerLedgerUnchanged, true);
    const proposedB = await item(admin, 'SELECT freehold.institution_adjustment_propose($1::uuid,$2::uuid,NULL,$3::uuid,$4::uuid,$5::bigint) AS item', [ids.northGov, north.institutionId, reserveB.accountId, operating, '4000']);
    await item(admin, 'SELECT freehold.institution_adjustment_post($1::uuid,$2::uuid,$3::uuid) AS item', [ids.northGov2, north.institutionId, proposedB.adjustmentId]);
    await item(admin, 'SELECT freehold.institution_policy_set($1::uuid,$2::uuid,$3::text,$4::bigint) AS item', [ids.northAdmin, north.institutionId, 'CUSTODIAN_CONCENTRATION_BPS', '5000']);
    const balancesBeforeRisk = (await admin.query('SELECT COALESCE(sum(balance_minor),0)::text AS n FROM freehold.institution_ledger_accounts WHERE institution_id = $1', [north.institutionId])).rows[0].n;
    const shock = await item(admin, 'SELECT freehold.institution_risk_run($1::uuid,$2::uuid,$3::text) AS item', [ids.northAdmin, north.institutionId, 'LARGE_REDEMPTION_SHOCK']);
    const outage = await item(admin, 'SELECT freehold.institution_risk_run($1::uuid,$2::uuid,$3::text) AS item', [ids.northAdmin, north.institutionId, 'CUSTODIAN_OUTAGE']);
    const decline = await item(admin, 'SELECT freehold.institution_risk_run($1::uuid,$2::uuid,$3::text) AS item', [ids.northAdmin, north.institutionId, 'MARKET_VALUE_DECLINE']);
    for (const scenario of ['NORMAL_REDEMPTION', 'ELEVATED_REDEMPTION', 'SETTLEMENT_DELAY', 'RESERVE_INELIGIBILITY', 'COUNTERPARTY_DEFAULT']) {
      const run = await item(admin, 'SELECT freehold.institution_risk_run($1::uuid,$2::uuid,$3::text) AS item', [ids.northAdmin, north.institutionId, scenario]);
      assert.equal(run.mutatedAccounts, false);
      assert.equal(run.regulatoryDetermination, false);
      assert.equal(run.externalEvidence, 'EXTERNAL_UNAVAILABLE');
    }
    assert.equal(shock.scenarioDemandMinor, String(500000n * 8000n / 10000n));
    assert.equal(outage.reserveAvailableMinor, '0');
    assert.equal(decline.reserveAvailableMinor, String(10000n * 8000n / 10000n));
    assert.equal(shock.concentrationBreach, true);
    assert.equal((await admin.query('SELECT COALESCE(sum(balance_minor),0)::text AS n FROM freehold.institution_ledger_accounts WHERE institution_id = $1', [north.institutionId])).rows[0].n, balancesBeforeRisk);
    await item(admin, 'SELECT freehold.institution_policy_set($1::uuid,$2::uuid,$3::text,$4::bigint) AS item', [ids.northAdmin, north.institutionId, 'CUSTODIAN_CONCENTRATION_BPS', '10000']);

    const northReport = await item(admin, 'SELECT freehold.institution_treasury_report($1::uuid,NULL,NULL,NULL,$2::uuid) AS item', [ids.northAdmin, north.institutionId]);
    const harborReport = await item(admin, 'SELECT freehold.institution_treasury_report($1::uuid,NULL,NULL,NULL,$2::uuid) AS item', [ids.harborAdmin, harbor.institutionId]);
    assert.equal(northReport.consolidatedBalance, null);
    assert.equal(northReport.valuationBasis, 'NONE');
    assert.equal(northReport.externalAssetsRecognized, false);
    assert.equal(JSON.stringify(northReport).includes(harborCustomer.accountId), false);
    assert.equal(JSON.stringify(harborReport).includes(northCustomer.accountId), false);
    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_treasury_report($1::uuid,NULL,NULL,NULL,$2::uuid) AS item', [ids.northDev, north.institutionId]),
      'INSTITUTION_FORBIDDEN',
    );

    const dispute = await item(admin, 'SELECT freehold.institution_dispute_open($1::uuid,$2::uuid,$3::uuid,$4::text) AS item', [ids.northComp, north.institutionId, hooked.paymentId, 'Customer asked for a review of a simulated payment']);
    assert.equal(dispute.legalRegime, 'NOT_DETERMINED');
    assert.equal(dispute.ledgerReversed, false);
    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_dispute_note($1::uuid,$2::uuid,$3::uuid,$4::text) AS item', [ids.harborAdmin, harbor.institutionId, dispute.disputeId, 'Cross tenant note']),
      'INSTITUTION_FORBIDDEN',
    );
    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_dispute_resolve($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text) AS item', [ids.northComp, north.institutionId, dispute.disputeId, 'RESOLVED', 'Same person']),
      'INSTITUTION_FORBIDDEN',
    );
    const ownDispute = await item(admin, 'SELECT freehold.institution_dispute_open($1::uuid,$2::uuid,NULL,$3::text) AS item', [ids.northGov, north.institutionId, 'Governance opened this simulated dispute']);
    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_dispute_resolve($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text) AS item', [ids.northGov, north.institutionId, ownDispute.disputeId, 'RESOLVED', 'Same approver']),
      'INSTITUTION_SELF_APPROVAL',
    );
    const resolvedDispute = await item(admin, 'SELECT freehold.institution_dispute_resolve($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text) AS item', [ids.northGov, north.institutionId, dispute.disputeId, 'RESOLVED', 'No institutional ledger reversal']);
    assert.equal(resolvedDispute.ledgerReversed, false);
    const compliance = await item(admin, 'SELECT freehold.institution_compliance_open($1::uuid,$2::uuid,$3::text) AS item', [ids.northComp, north.institutionId, `subject-${stamp}`]);
    assert.equal(compliance.isDispute, false);
    assert.equal(compliance.state, 'NOT_A_BSA_PROGRAM');

    const issuance = (await admin.query('SELECT id FROM freehold.issuance_operations LIMIT 1')).rows[0];
    assert.ok(issuance, 'phase 11 left an issuance to link');
    const [linkA, linkB] = await Promise.all([
      item(admin, 'SELECT freehold.institution_issuance_link($1::uuid,$2::uuid,$3::uuid) AS item', [ids.northPay, north.institutionId, issuance.id]),
      item(admin, 'SELECT freehold.institution_issuance_link($1::uuid,$2::uuid,$3::uuid) AS item', [ids.northPay, north.institutionId, issuance.id]),
    ]);
    assert.equal(linkA.addedToSupply, false);
    assert.equal(linkB.addedToSupply, false);
    assert.equal(linkA.supplyUnchanged, supplyBefore);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.institution_issuance_links WHERE institution_id = $1 AND issuance_id = $2', [north.institutionId, issuance.id])).rows[0].n, 1);
    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_activate_live($1::uuid) AS item', [ids.northAdmin]),
      'LIVE_MONETARY_ACTIVATION_REFUSED',
    );
    assert.equal((await admin.query('SELECT bool_or(live_authorized) AS live FROM freehold.institutions')).rows[0].live, false);

    const period = '2026-11-01';
    await item(admin, 'SELECT freehold.institution_billing_plan($1::uuid,$2::uuid,$3::bigint,$4::bigint,$5::bigint,$6::bigint,$7::bigint) AS item', [ids.northAdmin, north.institutionId, '1000', '3', '2', '0', '0']);
    const usageKey = `p12us-${stamp}`.slice(0, 40);
    await item(admin, 'SELECT freehold.institution_usage_record($1::uuid,$2::uuid,$3::date,$4::text,$5::bigint,$6::text) AS item', [ids.northAdmin, north.institutionId, period, 'API_CALL', '4', usageKey]);
    const usageDuplicate = await item(admin, 'SELECT freehold.institution_usage_record($1::uuid,$2::uuid,$3::date,$4::text,$5::bigint,$6::text) AS item', [ids.northAdmin, north.institutionId, period, 'API_CALL', '4', usageKey]);
    assert.equal(usageDuplicate.duplicate, true);
    await expectMessage(
      () => item(admin, 'SELECT freehold.institution_usage_record($1::uuid,$2::uuid,$3::date,$4::text,$5::bigint,$6::text) AS item', [ids.northAdmin, north.institutionId, period, 'API_CALL', '5', usageKey]),
      'INSTITUTION_IDEMPOTENCY_CONFLICT',
    );
    await item(admin, 'SELECT freehold.institution_usage_record($1::uuid,$2::uuid,$3::date,$4::text,$5::bigint) AS item', [ids.northAdmin, north.institutionId, period, 'CREDIT', '2']);
    const invoice = await item(admin, 'SELECT freehold.institution_invoice_draft($1::uuid,NULL,NULL,NULL,$2::uuid,$3::date) AS item', [ids.northAdmin, north.institutionId, period]);
    assert.equal(invoice.totalMinor, '1010');
    assert.equal(invoice.collected, false);
    assert.equal(invoice.separateFromCustomerBalances, true);
    const forecast = await item(admin, 'SELECT freehold.institution_billing_forecast($1::uuid,$2::uuid,$3::bigint) AS item', [ids.northAdmin, north.institutionId, '20000']);
    assert.equal(forecast.forecastMinor, '2020');
    assert.equal(forecast.inventedCustomers, false);
    assert.equal((await admin.query('SELECT COALESCE(sum(balance_minor),0)::text AS n FROM freehold.institution_ledger_accounts WHERE institution_id = $1', [north.institutionId])).rows[0].n, balancesBeforeRisk);

    const health = await item(admin, 'SELECT freehold.institution_health($1::uuid,$2::uuid) AS item', [ids.northGov, north.institutionId]);
    assert.equal(health.liveRails, false);

    const clean = await verifyLedger(verifier);
    const chainBefore = clean.accountingViolations.some(row => row.code === 'MONETARY_CHAIN_SUPPLY_MISMATCH');
    assert.deepEqual(institutionCodes(clean), []);
    assert.equal(clean.institution.accountingSeparateFromExternalEvidence, true);
    assert.equal(clean.institution.externalEvidence, 'EXTERNAL_EVIDENCE_UNAVAILABLE');
    assert.equal(clean.institution.simulatedInternalBalancesAreExternalEvidence, false);

    crossedPayment = unknown.paymentId;
    crossedEntity = (await admin.query('SELECT legal_entity_id FROM freehold.institution_payments WHERE id = $1', [crossedPayment])).rows[0].legal_entity_id;
    await admin.query('BEGIN');
    await admin.query(`SELECT set_config('freehold.institution_writer','on',true)`);
    await admin.query('UPDATE freehold.institution_payments SET legal_entity_id = $2 WHERE id = $1', [crossedPayment, OTHER_ENTITY]);
    await admin.query('COMMIT');
    const crossed = await verifyLedger(verifier);
    assert.ok(crossed.accountingViolations.some(row => row.code === 'INSTITUTION_CROSS_ENTITY'));
    await admin.query('BEGIN');
    await admin.query(`SELECT set_config('freehold.institution_writer','on',true)`);
    await admin.query('UPDATE freehold.institution_payments SET legal_entity_id = $2 WHERE id = $1', [crossedPayment, crossedEntity]);
    await admin.query('COMMIT');

    badJournal = randomUUID();
    await admin.query('BEGIN');
    await admin.query('ALTER TABLE freehold.institution_entries DISABLE TRIGGER institution_entries_balanced');
    await admin.query(`SELECT set_config('freehold.institution_writer','on',true)`);
    await admin.query(
      `INSERT INTO freehold.institution_journals(id, institution_id, currency_code, legal_entity_id, kind, idempotency_key, correlation_id, memo)
       VALUES ($1,$2,'USD',$3,'PLANTED',$4,$5,'PLANTED_IMBALANCE')`,
      [badJournal, north.institutionId, ENTITY, `bad-${stamp}`, randomUUID()],
    );
    await admin.query(
      'INSERT INTO freehold.institution_entries(journal_id, account_id, side, amount_minor) VALUES ($1,$2,$3,1)',
      [badJournal, northCustomer.accountId, 'DEBIT'],
    );
    await admin.query('COMMIT');
    const planted = await verifyLedger(verifier);
    assert.ok(planted.accountingViolations.some(row => row.code === 'INSTITUTION_JOURNAL_IMBALANCE'));
    await admin.query('ALTER TABLE freehold.institution_entries DISABLE TRIGGER ALL');
    await admin.query('ALTER TABLE freehold.institution_journals DISABLE TRIGGER ALL');
    await admin.query('DELETE FROM freehold.institution_entries WHERE journal_id = $1', [badJournal]);
    await admin.query('DELETE FROM freehold.institution_journals WHERE id = $1', [badJournal]);
    await admin.query('ALTER TABLE freehold.institution_entries ENABLE TRIGGER ALL');
    await admin.query('ALTER TABLE freehold.institution_journals ENABLE TRIGGER ALL');
    badJournal = null;

    const restored = await verifyLedger(verifier);
    assert.deepEqual(institutionCodes(restored), []);
    assert.equal(restored.accountingViolations.some(row => row.code === 'MONETARY_CHAIN_SUPPLY_MISMATCH'), chainBefore);
    const interrupted = await verifyLedger(verifier, { shouldCancel: () => true });
    assert.equal(interrupted.outcome, 'INCOMPLETE');
    assert.equal(interrupted.error.code, 'CANCELLED');

    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.ledger_journals')).rows[0].n, journalsBefore);
    assert.equal((await admin.query('SELECT COALESCE(sum(available_minor),0)::text AS n FROM freehold.accounts')).rows[0].n, availableBefore);
    assert.equal((await admin.query(`SELECT outstanding::text AS n FROM freehold.monetary_supply WHERE book_id = '20000000-0000-4000-8000-000000000001'`)).rows[0].n, supplyBefore);
  } finally {
    if (badJournal) {
      await admin.query('ALTER TABLE freehold.institution_entries DISABLE TRIGGER ALL').catch(() => undefined);
      await admin.query('ALTER TABLE freehold.institution_journals DISABLE TRIGGER ALL').catch(() => undefined);
      await admin.query('DELETE FROM freehold.institution_entries WHERE journal_id = $1', [badJournal]).catch(() => undefined);
      await admin.query('DELETE FROM freehold.institution_journals WHERE id = $1', [badJournal]).catch(() => undefined);
      await admin.query('ALTER TABLE freehold.institution_entries ENABLE TRIGGER ALL').catch(() => undefined);
      await admin.query('ALTER TABLE freehold.institution_journals ENABLE TRIGGER ALL').catch(() => undefined);
    }
    if (crossedPayment && crossedEntity) {
      await admin.query('BEGIN').catch(() => undefined);
      await admin.query(`SELECT set_config('freehold.institution_writer','on',true)`).catch(() => undefined);
      await admin.query('UPDATE freehold.institution_payments SET legal_entity_id = $2 WHERE id = $1', [crossedPayment, crossedEntity]).catch(() => undefined);
      await admin.query('COMMIT').catch(() => undefined);
    }
    await Promise.all([admin.end(), api.end(), worker.end(), workerB.end(), verifier.end()].map(job => job.catch(() => undefined)));
  }
});
