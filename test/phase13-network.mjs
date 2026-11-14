import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { verifyLedger } from '../scripts/lib/ledger-verifier.mjs';
import { canonicalPaymentPayload, generateMemberKeyPair, signPayload, simulatedConfirmationSignature, TRUST_BOUNDARY } from '../scripts/lib/network-trust.mjs';
import { buildSimulatedMessage, validateSimulatedMessage } from '../scripts/lib/network-iso.mjs';

const SIM_KEY = 'phase13-simulator-key';
const ENTITY = '10000000-0000-4000-8000-000000000001';
const admin = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
const admin2 = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
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
const nonce = () => randomUUID().replace(/-/g, '').slice(0, 24);
const rulebookBody = {
  membershipEligibility: 'A simulated tenant may apply. The member is not a licensed bank.',
  participantDuties: 'Accept the rulebook version before simulation participation.',
  transactionTypes: 'Institution to institution customer credit transfer.',
  messageFormat: 'Canonical internal payload and a simulated ISO 20022 subset.',
  clearingEligibility: 'VALIDATED payments of ACTIVE_SIMULATION members in one currency.',
  nettingMethodology: 'Net is gross incoming minus gross outgoing. No cross-currency netting.',
  settlementMechanism: 'SIMULATED_NET_SETTLEMENT_NOT_EXTERNAL',
  settlementWindow: 'No external settlement window.',
  finalityRules: 'FINAL requires a simulated confirmation and new journals. An acknowledgment is not final.',
  incidentProcedures: 'UNKNOWN stays unknown. Do not invent a settled result.',
  suspensionPolicy: 'A suspended member cannot validate a new payment.',
  disputeProcedures: 'A correction is a new reversal operation. History is not deleted.',
  reconciliationObligations: 'Reconstruct positions from obligations. Do not trust engine totals.',
  amendmentProcess: 'Another administrator adopts a new version. Acceptance is per member.',
  enforceableAgreement: false,
};

async function tx(fn) {
  await admin.query('BEGIN');
  try {
    await admin.query(`SELECT set_config('freehold.bank_simulator_key',$1,true)`, [SIM_KEY]);
    const value = await fn();
    await admin.query('COMMIT');
    return value;
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}

test('phase 13 simulates a governed network without external settlement', async () => {
  await Promise.all([admin.connect(), admin2.connect(), api.connect(), worker.connect(), workerB.connect(), verifier.connect()]);
  const names = ['alder', 'birch', 'cedar', 'drift', 'operator', 'outsider'];
  const ids = Object.fromEntries(names.map(name => [name, randomUUID()]));
  const stamp = randomUUID().slice(0, 8);
  const verifierSource = readFileSync(new URL('../scripts/lib/ledger-verifier.mjs', import.meta.url), 'utf8');
  assert.equal(verifierSource.includes('network-trust'), false);
  assert.match(verifierSource, /LEDGER_VERIFIER_VERSION = '1\.7\.0'/);
  assert.equal(TRUST_BOUNDARY, 'SAME_HOST_KEY_IS_NOT_HSM');
  const journalsBefore = (await admin.query('SELECT count(*)::int AS n FROM freehold.ledger_journals')).rows[0].n;
  const availableBefore = (await admin.query('SELECT COALESCE(sum(available_minor),0)::text AS n FROM freehold.accounts')).rows[0].n;
  const paymentsBefore = (await admin.query('SELECT count(*)::int AS n FROM freehold.institution_payments')).rows[0].n;
  const supplyBefore = (await admin.query(`SELECT outstanding::text AS n FROM freehold.monetary_supply WHERE book_id = '20000000-0000-4000-8000-000000000001'`)).rows[0].n;
  const chainBefore = (await verifyLedger(verifier)).accountingViolations.some(row => row.code === 'MONETARY_CHAIN_SUPPLY_MISMATCH');
  let triggersOff = false;
  try {
    const values = names.flatMap(name => [ids[name], `p13-${name}-${ids[name].slice(0, 8)}@example.test`]);
    const placeholders = names.map((_, index) => `($${index * 2 + 1},$${index * 2 + 2},$${names.length * 2 + 1},$${names.length * 2 + 2 + index})`).join(',');
    await admin.query(
      `INSERT INTO freehold.users(id,email_normalized,password_hash,role) VALUES ${placeholders}`,
      [...values, 'phase13-unused-password-hash', ...names.map(name => name === 'outsider' ? 'USER' : 'ADMIN')],
    );
    await assert.rejects(
      () => api.query('SELECT freehold.network_outbox_claim($1::uuid,$2::integer)', [randomUUID(), 30]),
      error => error.message.includes('permission denied for function network_outbox_claim'),
    );
    await assert.rejects(
      () => api.query('SELECT id FROM freehold.network_payments'),
      error => error.message.includes('permission denied for table network_payments'),
    );
    await assert.rejects(
      () => verifier.query('SELECT freehold.network_dashboard($1::uuid)', [ids.operator]),
      error => error.message.includes('permission denied for function network_dashboard'),
    );

    const openInstitution = (actor, code, legalName) => item(admin, 'SELECT freehold.institution_open($1::uuid,$2::text,$3::text) AS item', [actor, code, legalName]);
    const alder = await openInstitution(ids.alder, `alder-${stamp}`, 'Alder Simulation Tenant');
    const birch = await openInstitution(ids.birch, `birch-${stamp}`, 'Birch Simulation Tenant');
    const cedar = await openInstitution(ids.cedar, `cedar-${stamp}`, 'Cedar Simulation Tenant');
    const drift = await openInstitution(ids.drift, `drift-${stamp}`, 'Drift Simulation Tenant');
    await expectMessage(
      () => item(admin, 'SELECT freehold.network_member_apply($1::uuid,$2::uuid) AS item', [ids.outsider, alder.institutionId]),
      'INSTITUTION_FORBIDDEN',
    );
    await expectMessage(
      () => item(admin, 'SELECT freehold.network_member_apply($1::uuid,$2::uuid) AS item', [ids.operator, alder.institutionId]),
      'INSTITUTION_FORBIDDEN',
    );
    const badBook = { ...rulebookBody, enforceableAgreement: true };
    await expectMessage(
      () => item(admin, 'SELECT freehold.network_rulebook_propose($1::uuid,$2::text,$3::jsonb) AS item', [ids.alder, `bad.${stamp}`, JSON.stringify(badBook)]),
      'NETWORK_RULEBOOK',
    );
    const proposed = await item(admin, 'SELECT freehold.network_rulebook_propose($1::uuid,$2::text,$3::jsonb) AS item', [ids.alder, `sim.${stamp}`, JSON.stringify(rulebookBody)]);
    assert.equal(proposed.enforceableClearingAgreement, false);
    await expectMessage(
      () => item(admin, 'SELECT freehold.network_rulebook_adopt($1::uuid,$2::uuid) AS item', [ids.alder, proposed.rulebookId]),
      'NETWORK_SELF_APPROVAL',
    );
    const adopted = await item(admin, 'SELECT freehold.network_rulebook_adopt($1::uuid,$2::uuid) AS item', [ids.operator, proposed.rulebookId]);
    assert.equal(adopted.status, 'ADOPTED');
    const transition = (actor, institutionId, to) => item(admin, 'SELECT freehold.network_member_transition($1::uuid,$2::uuid,$3::text) AS item', [actor, institutionId, to]);
    const admit = async (institutionId, applicant, approver) => {
      const applied = await item(admin, 'SELECT freehold.network_member_apply($1::uuid,$2::uuid) AS item', [applicant, institutionId]);
      assert.equal(applied.licensedClaim, false);
      await expectMessage(() => transition(applicant, institutionId, 'UNDER_REVIEW'), 'NETWORK_SELF_APPROVAL');
      await transition(ids.operator, institutionId, 'UNDER_REVIEW');
      await expectMessage(() => transition(ids.operator, institutionId, 'APPROVED_FOR_SIMULATION'), 'NETWORK_MEMBER');
      await transition(approver, institutionId, 'APPROVED_FOR_SIMULATION');
      await expectMessage(() => transition(ids.operator, institutionId, 'ACTIVE_SIMULATION'), 'NETWORK_RULEBOOK');
      await item(admin, 'SELECT freehold.network_rulebook_accept($1::uuid,$2::uuid,$3::uuid) AS item', [applicant, institutionId, proposed.rulebookId]);
      await expectMessage(() => transition(applicant, institutionId, 'ACTIVE_SIMULATION'), 'NETWORK_SELF_APPROVAL');
      const active = await transition(ids.operator, institutionId, 'ACTIVE_SIMULATION');
      assert.equal(active.status, 'ACTIVE_SIMULATION');
      assert.equal(active.financialPosting, false);
    };
    await admit(alder.institutionId, ids.alder, ids.birch);
    await admit(birch.institutionId, ids.birch, ids.cedar);
    await admit(cedar.institutionId, ids.cedar, ids.alder);
    await admit(drift.institutionId, ids.drift, ids.birch);
    const second = await item(admin, 'SELECT freehold.network_rulebook_propose($1::uuid,$2::text,$3::jsonb) AS item', [ids.birch, `sim2.${stamp}`, JSON.stringify(rulebookBody)]);
    await item(admin, 'SELECT freehold.network_rulebook_adopt($1::uuid,$2::uuid) AS item', [ids.operator, second.rulebookId]);

    const keys = Object.fromEntries(['alder', 'birch', 'cedar', 'spare'].map(name => [name, generateMemberKeyPair()]));
    const register = (actor, institutionId, publicKeyHex, notBefore, notAfter) => item(
      admin,
      'SELECT freehold.network_certificate_register($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::timestamptz) AS item',
      [actor, institutionId, publicKeyHex, notBefore, notAfter],
    );
    const now = new Date();
    const future = new Date(now.getTime() + 86400000);
    const past = new Date(now.getTime() - 86400000);
    await expectMessage(() => register(ids.alder, alder.institutionId, keys.alder.publicKeyHex, past, past), 'NETWORK_CERT_EXPIRED');
    const alderCert = await register(ids.alder, alder.institutionId, keys.alder.publicKeyHex, new Date(now.getTime() - 60000), future);
    const birchCert = await register(ids.birch, birch.institutionId, keys.birch.publicKeyHex, new Date(now.getTime() - 60000), future);
    const cedarCert = await register(ids.cedar, cedar.institutionId, keys.cedar.publicKeyHex, new Date(now.getTime() - 60000), future);
    const spare = await register(ids.alder, alder.institutionId, keys.spare.publicKeyHex, new Date(now.getTime() - 60000), future);
    assert.equal(alderCert.privateKeyStored, false);
    await admin.query('BEGIN');
    await admin.query(`SELECT set_config('freehold.network_writer','on',true)`);
    await admin.query(`UPDATE freehold.network_certificates SET not_after = clock_timestamp() - interval '1 minute' WHERE id = $1`, [spare.certificateId]);
    await admin.query('COMMIT');
    const customer = (actor, institutionId, ref) => item(admin, 'SELECT freehold.institution_customer_open($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item', [actor, institutionId, ref, `${ref} customer`, 'USD']);
    const alderCustomer = await customer(ids.alder, alder.institutionId, `alder-${stamp}`);
    const birchCustomer = await customer(ids.birch, birch.institutionId, `birch-${stamp}`);
    const cedarCustomer = await customer(ids.cedar, cedar.institutionId, `cedar-${stamp}`);
    const driftCustomer = await customer(ids.drift, drift.institutionId, `drift-${stamp}`);
    const unfunded = await customer(ids.alder, alder.institutionId, `thin-${stamp}`);
    const alderEur = await item(admin, 'SELECT freehold.institution_customer_open($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item', [ids.alder, alder.institutionId, `alder-eur-${stamp}`, 'Alder EUR customer', 'EUR']);
    const birchEur = await item(admin, 'SELECT freehold.institution_customer_open($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item', [ids.birch, birch.institutionId, `birch-eur-${stamp}`, 'Birch EUR customer', 'EUR']);
    for (const [actor, institutionId, accountId, key] of [
      [ids.alder, alder.institutionId, alderCustomer.accountId, `fund-a-${stamp}`],
      [ids.birch, birch.institutionId, birchCustomer.accountId, `fund-b-${stamp}`],
      [ids.cedar, cedar.institutionId, cedarCustomer.accountId, `fund-c-${stamp}`],
      [ids.drift, drift.institutionId, driftCustomer.accountId, `fund-d-${stamp}`],
    ]) {
      await item(admin, 'SELECT freehold.institution_fund_simulated($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::uuid) AS item', [actor, institutionId, accountId, '100000', key, randomUUID()]);
    }
    const setLiquidity = (actor, institutionId, opening, capacity, limit) => item(
      admin,
      'SELECT freehold.network_liquidity_set($1::uuid,$2::uuid,$3::bigint,$4::bigint,$5::bigint) AS item',
      [actor, institutionId, opening, capacity, limit],
    );
    for (const [actor, institutionId] of [[ids.alder, alder.institutionId], [ids.birch, birch.institutionId], [ids.cedar, cedar.institutionId], [ids.drift, drift.institutionId]]) {
      const liquidity = await setLiquidity(actor, institutionId, '100000000', '100000000', '100000000');
      assert.equal(liquidity.inventedFunding, false);
      assert.equal(liquidity.centralBankBalanceCreated, false);
    }
    await admin.query('BEGIN');
    await expectMessage(
      () => admin.query(`INSERT INTO freehold.network_member_audit(actor_id, action, detail) VALUES ($1,'DIRECT','{}')`, [ids.operator]),
      'NETWORK_DIRECT_WRITE_FORBIDDEN',
    );
    await admin.query('ROLLBACK');
    await admin.query('BEGIN');
    await admin.query(`SELECT set_config('freehold.network_writer','on',true)`);
    await expectMessage(
      () => admin.query('DELETE FROM freehold.network_member_audit WHERE actor_id = $1', [ids.alder]),
      'NETWORK_HISTORY_IMMUTABLE',
    );
    await admin.query('ROLLBACK');

    const openPayment = async (actor, origin, beneficiary, originAccount, beneficiaryAccount, amount, purpose, key, cert, privateKey, currency = 'USD', paymentNonce = nonce()) => {
      const payload = canonicalPaymentPayload({
        originInstitutionId: origin, beneficiaryInstitutionId: beneficiary, originAccountId: originAccount, beneficiaryAccountId: beneficiaryAccount,
        currency, amountMinor: amount, idempotencyKey: key, purpose,
      });
      const signature = signPayload(privateKey, payload);
      const sqlPayload = (await admin.query(
        `SELECT freehold._network_payload($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::bigint,$7::text,$8::text) AS payload`,
        [origin, beneficiary, originAccount, beneficiaryAccount, currency, amount, key, purpose],
      )).rows[0].payload;
      assert.equal(sqlPayload, payload);
      return item(admin, `SELECT freehold.network_payment_open($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bigint,$7::text,$8::text,$9::uuid,$10::uuid,$11::text,$12::text,$13::integer) AS item`, [
        actor, origin, beneficiary, originAccount, beneficiaryAccount, amount, purpose, key, randomUUID(), cert, signature, paymentNonce, 3600,
      ]);
    };
    const replayNonce = nonce();
    const first = await openPayment(ids.alder, alder.institutionId, birch.institutionId, alderCustomer.accountId, birchCustomer.accountId, '50', 'triangle-ab', `ab-${stamp}`, alderCert.certificateId, keys.alder.privateKey, 'USD', replayNonce);
    assert.equal(first.posted, false);
    await expectMessage(
      () => openPayment(ids.alder, alder.institutionId, birch.institutionId, alderCustomer.accountId, birchCustomer.accountId, '50', 'triangle-ab', `ab-${stamp}`, alderCert.certificateId, keys.alder.privateKey, 'USD', replayNonce),
      'NETWORK_REPLAY',
    );
    const duplicate = await openPayment(ids.alder, alder.institutionId, birch.institutionId, alderCustomer.accountId, birchCustomer.accountId, '50', 'triangle-ab', `ab-${stamp}`, alderCert.certificateId, keys.alder.privateKey);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.paymentId, first.paymentId);
    await expectMessage(
      () => openPayment(ids.alder, alder.institutionId, birch.institutionId, alderCustomer.accountId, birchCustomer.accountId, '51', 'triangle-ab', `ab-${stamp}`, alderCert.certificateId, keys.alder.privateKey),
      'NETWORK_IDEMPOTENCY_CONFLICT',
    );
    await expectMessage(
      () => openPayment(ids.alder, alder.institutionId, birch.institutionId, alderCustomer.accountId, birchCustomer.accountId, '50', 'triangle-aB', `ab-${stamp}`, alderCert.certificateId, keys.alder.privateKey),
      'NETWORK_IDEMPOTENCY_CONFLICT',
    );
    await expectMessage(
      () => openPayment(ids.alder, alder.institutionId, birch.institutionId, alderCustomer.accountId, birchCustomer.accountId, '5', 'expired-cert', `exp-${stamp}`, spare.certificateId, keys.spare.privateKey),
      'NETWORK_CERT_EXPIRED',
    );
    await item(admin, 'SELECT freehold.network_certificate_revoke($1::uuid,$2::uuid,$3::uuid) AS item', [ids.alder, alder.institutionId, spare.certificateId]);
    await expectMessage(
      () => openPayment(ids.alder, alder.institutionId, birch.institutionId, alderCustomer.accountId, birchCustomer.accountId, '5', 'revoked-cert', `rev-${stamp}`, spare.certificateId, keys.spare.privateKey),
      'NETWORK_CERT_REVOKED',
    );
    const secondLeg = await openPayment(ids.birch, birch.institutionId, cedar.institutionId, birchCustomer.accountId, cedarCustomer.accountId, '20', 'triangle-bc', `bc-${stamp}`, birchCert.certificateId, keys.birch.privateKey);
    const thirdLeg = await openPayment(ids.cedar, cedar.institutionId, alder.institutionId, cedarCustomer.accountId, alderCustomer.accountId, '10', 'triangle-ca', `ca-${stamp}`, cedarCert.certificateId, keys.cedar.privateKey);
    await expectMessage(
      () => openPayment(ids.alder, alder.institutionId, birch.institutionId, alderCustomer.accountId, birchEur.accountId, '5', 'cross-ccy', `xccy-${stamp}`, alderCert.certificateId, keys.alder.privateKey),
      'NETWORK_CURRENCY',
    );
    const validate = paymentId => item(admin, 'SELECT freehold.network_payment_validate($1::uuid,$2::uuid) AS item', [ids.alder, paymentId]);
    await item(admin, 'SELECT freehold.network_payment_validate($1::uuid,$2::uuid) AS item', [ids.alder, first.paymentId]);
    await item(admin, 'SELECT freehold.network_payment_validate($1::uuid,$2::uuid) AS item', [ids.birch, secondLeg.paymentId]);
    await item(admin, 'SELECT freehold.network_payment_validate($1::uuid,$2::uuid) AS item', [ids.cedar, thirdLeg.paymentId]);
    await expectMessage(
      () => item(admin, 'SELECT freehold.network_payment_get($1::uuid,$2::uuid,$3::uuid) AS item', [ids.cedar, cedar.institutionId, first.paymentId]),
      'NETWORK_FORBIDDEN',
    );
    const originView = await item(admin, 'SELECT freehold.network_payment_get($1::uuid,$2::uuid,$3::uuid) AS item', [ids.alder, alder.institutionId, first.paymentId]);
    assert.equal(originView.customerDisplayNames, false);
    assert.equal(originView.accountId, alderCustomer.accountId);
    assert.equal(JSON.stringify(originView).includes('Alder'), false);

    const build = (actor, kind, members) => item(admin, 'SELECT freehold.network_cycle_build($1::uuid,$2::text,$3::text,$4::uuid[]) AS item', [actor, kind, 'USD', members]);
    const shape = await build(ids.operator, 'BILATERAL', [alder.institutionId, birch.institutionId, cedar.institutionId]);
    assert.equal(shape.created, false);
    assert.equal(shape.reason, 'NETWORK_CYCLE_SHAPE');
    assert.equal(shape.partial, false);
    const triangle = await build(ids.operator, 'MULTILATERAL', [alder.institutionId, birch.institutionId, cedar.institutionId]);
    assert.equal(triangle.created, true);
    assert.equal(triangle.included, 3);
    const finalized = await item(admin, 'SELECT freehold.network_cycle_finalize($1::uuid,$2::uuid) AS item', [ids.operator, triangle.cycleId]);
    assert.equal(finalized.status, 'FINALIZED');
    assert.equal(finalized.posted, false);
    assert.equal(finalized.netSumMinor, '0');
    const nets = await admin.query('SELECT institution_id, net_minor::text AS net, gross_incoming_minor::text AS incoming, gross_outgoing_minor::text AS outgoing FROM freehold.network_cycle_positions WHERE cycle_id = $1', [triangle.cycleId]);
    const netOf = institutionId => nets.rows.find(row => row.institution_id === institutionId);
    assert.equal(netOf(alder.institutionId).net, '-40');
    assert.equal(netOf(birch.institutionId).net, '30');
    assert.equal(netOf(cedar.institutionId).net, '10');
    assert.equal(nets.rows.reduce((sum, row) => sum + Number(row.net), 0), 0);
    const again = await build(ids.operator, 'MULTILATERAL', [alder.institutionId, birch.institutionId, cedar.institutionId]);
    assert.equal(again.created, false);
    assert.equal(again.reason, 'NO_ELIGIBLE_OBLIGATIONS');

    const sideA = await openPayment(ids.alder, alder.institutionId, birch.institutionId, alderCustomer.accountId, birchCustomer.accountId, '40', 'bilateral-ab', `bil-ab-${stamp}`, alderCert.certificateId, keys.alder.privateKey);
    const sideB = await openPayment(ids.birch, birch.institutionId, alder.institutionId, birchCustomer.accountId, alderCustomer.accountId, '15', 'bilateral-ba', `bil-ba-${stamp}`, birchCert.certificateId, keys.birch.privateKey);
    await item(admin, 'SELECT freehold.network_payment_validate($1::uuid,$2::uuid) AS item', [ids.alder, sideA.paymentId]);
    await item(admin, 'SELECT freehold.network_payment_validate($1::uuid,$2::uuid) AS item', [ids.birch, sideB.paymentId]);
    const [raceA, raceB] = await Promise.all([
      build(ids.operator, 'BILATERAL', [alder.institutionId, birch.institutionId]),
      admin2.query('SELECT freehold.network_cycle_build($1::uuid,$2::text,$3::text,$4::uuid[]) AS item', [ids.operator, 'BILATERAL', 'USD', [alder.institutionId, birch.institutionId]]),
    ]);
    const raceResults = [raceA, raceB.rows[0].item];
    assert.equal(raceResults.filter(row => row.created).length, 1);
    assert.equal(raceResults.filter(row => row.created === false).length, 1);
    const raceCycles = await admin.query('SELECT count(DISTINCT cycle_id)::int AS n FROM freehold.network_obligations WHERE payment_id = ANY($1::uuid[])', [[sideA.paymentId, sideB.paymentId]]);
    assert.equal(raceCycles.rows[0].n, 1);
    await admin.query('BEGIN');
    await admin.query(`SELECT set_config('freehold.network_writer','on',true)`);
    await assert.rejects(
      () => admin.query(`INSERT INTO freehold.network_obligations(payment_id, origin_institution_id, beneficiary_institution_id, currency_code, amount_minor, eligible, status)
        SELECT payment_id, origin_institution_id, beneficiary_institution_id, currency_code, amount_minor, true, 'OPEN' FROM freehold.network_obligations WHERE payment_id = $1`, [sideA.paymentId]),
      error => error.code === '23505',
    );
    await admin.query('ROLLBACK');

    const short = await openPayment(ids.alder, alder.institutionId, birch.institutionId, alderCustomer.accountId, birchCustomer.accountId, '50', 'short-liq', `short-${stamp}`, alderCert.certificateId, keys.alder.privateKey);
    await validate(short.paymentId);
    await setLiquidity(ids.alder, alder.institutionId, '0', '0', '100000000');
    const shortBuild = await build(ids.operator, 'BILATERAL', [alder.institutionId, birch.institutionId]);
    const shortFinal = await item(admin, 'SELECT freehold.network_cycle_finalize($1::uuid,$2::uuid) AS item', [ids.operator, shortBuild.cycleId]);
    assert.equal(shortFinal.status, 'FAILED');
    assert.equal(shortFinal.reason, 'NETWORK_LIQUIDITY');
    assert.equal(shortFinal.posted, false);
    assert.equal(shortFinal.inventedFunding, false);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.network_cycle_positions WHERE cycle_id = $1', [shortBuild.cycleId])).rows[0].n, 0);
    await setLiquidity(ids.alder, alder.institutionId, '100000000', '100000000', '1');
    await validate(short.paymentId);
    const limitBuild = await build(ids.operator, 'BILATERAL', [alder.institutionId, birch.institutionId]);
    const limitFinal = await item(admin, 'SELECT freehold.network_cycle_finalize($1::uuid,$2::uuid) AS item', [ids.operator, limitBuild.cycleId]);
    assert.equal(limitFinal.reason, 'NETWORK_DEBIT_LIMIT');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.network_cycle_positions WHERE cycle_id = $1', [limitBuild.cycleId])).rows[0].n, 0);
    await setLiquidity(ids.alder, alder.institutionId, '100000000', '100000000', '100000000');
    await item(admin, 'SELECT freehold.network_payment_cancel($1::uuid,$2::uuid) AS item', [ids.alder, short.paymentId]);
    assert.equal((await admin.query(`SELECT status FROM freehold.network_obligations WHERE payment_id = $1`, [short.paymentId])).rows[0].status, 'CANCELED');

    const held = await openPayment(ids.alder, alder.institutionId, birch.institutionId, alderCustomer.accountId, birchCustomer.accountId, '7', 'hold-pay', `hold-${stamp}`, alderCert.certificateId, keys.alder.privateKey);
    await validate(held.paymentId);
    const heldBuild = await build(ids.operator, 'BILATERAL', [alder.institutionId, birch.institutionId]);
    await transition(ids.birch, alder.institutionId, 'SUSPENDED');
    const heldFinal = await item(admin, 'SELECT freehold.network_cycle_finalize($1::uuid,$2::uuid) AS item', [ids.operator, heldBuild.cycleId]);
    assert.equal(heldFinal.reason, 'NETWORK_MEMBER_SUSPENDED');
    const blocked = await openPayment(ids.alder, alder.institutionId, birch.institutionId, alderCustomer.accountId, birchCustomer.accountId, '8', 'blocked-pay', `block-${stamp}`, alderCert.certificateId, keys.alder.privateKey);
    await expectMessage(() => validate(blocked.paymentId), 'NETWORK_MEMBER_SUSPENDED');
    await expectMessage(() => transition(ids.birch, alder.institutionId, 'ACTIVE_SIMULATION'), 'NETWORK_SELF_APPROVAL');
    await transition(ids.operator, alder.institutionId, 'ACTIVE_SIMULATION');
    await item(admin, 'SELECT freehold.network_payment_cancel($1::uuid,$2::uuid) AS item', [ids.alder, held.paymentId]);
    await item(admin, 'SELECT freehold.network_payment_cancel($1::uuid,$2::uuid) AS item', [ids.alder, blocked.paymentId]);

    const rejected = await openPayment(ids.alder, alder.institutionId, birch.institutionId, alderCustomer.accountId, birchCustomer.accountId, '9', 'reject-me', `rej-${stamp}`, alderCert.certificateId, keys.alder.privateKey);
    await validate(rejected.paymentId);
    const rejection = await item(admin, 'SELECT freehold.network_payment_reject($1::uuid,$2::uuid) AS item', [ids.birch, rejected.paymentId]);
    assert.equal(rejection.state, 'REJECTED');
    await item(admin, 'SELECT freehold.network_member_currencies($1::uuid,$2::uuid,$3::text[]) AS item', [ids.alder, alder.institutionId, ['USD', 'EUR']]);
    await item(admin, 'SELECT freehold.network_member_currencies($1::uuid,$2::uuid,$3::text[]) AS item', [ids.birch, birch.institutionId, ['USD', 'EUR']]);
    const eurPay = await openPayment(ids.alder, alder.institutionId, birch.institutionId, alderEur.accountId, birchEur.accountId, '12', 'eur-only', `eur-${stamp}`, alderCert.certificateId, keys.alder.privateKey, 'EUR');
    await validate(eurPay.paymentId);
    const usdOnly = await build(ids.operator, 'BILATERAL', [alder.institutionId, birch.institutionId]);
    assert.equal(usdOnly.created, false);
    assert.equal((await admin.query('SELECT state FROM freehold.network_payments WHERE id = $1', [eurPay.paymentId])).rows[0].state, 'VALIDATED');
    await item(admin, 'SELECT freehold.network_payment_cancel($1::uuid,$2::uuid) AS item', [ids.alder, eurPay.paymentId]);

    const unknownPay = await openPayment(ids.alder, alder.institutionId, birch.institutionId, alderCustomer.accountId, birchCustomer.accountId, '6', 'unknown-pay', `unk-${stamp}`, alderCert.certificateId, keys.alder.privateKey);
    await validate(unknownPay.paymentId);
    const unknownBuild = await build(ids.operator, 'BILATERAL', [alder.institutionId, birch.institutionId]);
    await item(admin, 'SELECT freehold.network_cycle_finalize($1::uuid,$2::uuid) AS item', [ids.operator, unknownBuild.cycleId]);
    await item(admin, 'SELECT freehold.network_settlement_submit($1::uuid,$2::uuid) AS item', [ids.operator, unknownBuild.cycleId]);
    const journalsAtUnknown = (await admin.query('SELECT count(*)::int AS n FROM freehold.institution_journals')).rows[0].n;
    const unknown = await item(admin, 'SELECT freehold.network_settlement_unknown($1::uuid,$2::uuid) AS item', [ids.operator, unknownBuild.cycleId]);
    assert.equal(unknown.state, 'UNKNOWN');
    assert.equal(unknown.posted, false);
    assert.equal(unknown.final, false);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.institution_journals')).rows[0].n, journalsAtUnknown);
    const outage = await item(admin, 'SELECT freehold.network_stress($1::uuid,$2::uuid,$3::text) AS item', [ids.operator, alder.institutionId, 'PROVIDER_OUTAGE']);
    assert.equal(outage.modeledFinality, 'UNKNOWN');
    assert.equal(outage.providerAcknowledgementIsFinal, false);

    await item(admin, 'SELECT freehold.network_settlement_submit($1::uuid,$2::uuid) AS item', [ids.operator, triangle.cycleId]);
    await assert.rejects(
      () => tx(() => item(admin, 'SELECT freehold.network_settlement_confirm($1::uuid,$2::uuid,$3::text) AS item', [ids.operator, triangle.cycleId, 'ab'.repeat(64)])),
      error => error.message === 'NETWORK_SIGNATURE',
    );
    assert.equal((await admin.query(`SELECT state FROM freehold.network_payments WHERE id = $1`, [first.paymentId])).rows[0].state, 'SETTLEMENT_SUBMITTED');
    const confirmed = await tx(() => item(admin, 'SELECT freehold.network_settlement_confirm($1::uuid,$2::uuid,$3::text) AS item', [ids.operator, triangle.cycleId, simulatedConfirmationSignature(triangle.cycleId, 'USD', SIM_KEY)]));
    assert.equal(confirmed.simulated, true);
    assert.equal(confirmed.posted, false);
    assert.equal(confirmed.finality, 'SIMULATED_CONFIRMED_NOT_FINAL');
    const confirmedAgain = await tx(() => item(admin, 'SELECT freehold.network_settlement_confirm($1::uuid,$2::uuid,$3::text) AS item', [ids.operator, triangle.cycleId, 'cd'.repeat(64)]));
    assert.equal(confirmedAgain.duplicate, true);
    await expectMessage(
      () => item(admin, 'SELECT freehold.network_settlement_finalize($1::uuid,$2::uuid) AS item', [ids.alder, triangle.cycleId]),
      'NETWORK_SELF_APPROVAL',
    );
    const beforeCrash = (await admin.query('SELECT count(*)::int AS n FROM freehold.institution_journals')).rows[0].n;
    await admin.query('BEGIN');
    await item(admin, 'SELECT freehold.network_settlement_finalize($1::uuid,$2::uuid) AS item', [ids.operator, triangle.cycleId]);
    await admin.query('ROLLBACK');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.institution_journals')).rows[0].n, beforeCrash);
    assert.equal((await admin.query('SELECT state FROM freehold.network_payments WHERE id = $1', [first.paymentId])).rows[0].state, 'SETTLEMENT_CONFIRMED');
    const alderBefore = (await admin.query('SELECT balance_minor::text AS n FROM freehold.institution_ledger_accounts WHERE id = $1', [alderCustomer.accountId])).rows[0].n;
    const settled = await item(admin, 'SELECT freehold.network_settlement_finalize($1::uuid,$2::uuid) AS item', [ids.operator, triangle.cycleId]);
    assert.equal(settled.state, 'FINAL');
    assert.equal(settled.duplicate, false);
    assert.equal(settled.externalSettlement, false);
    assert.equal(settled.postedPayments, 3);
    const settledAgain = await item(admin, 'SELECT freehold.network_settlement_finalize($1::uuid,$2::uuid) AS item', [ids.operator, triangle.cycleId]);
    assert.equal(settledAgain.duplicate, true);
    const alderAfter = (await admin.query('SELECT balance_minor::text AS n FROM freehold.institution_ledger_accounts WHERE id = $1', [alderCustomer.accountId])).rows[0].n;
    assert.equal(BigInt(alderAfter) - BigInt(alderBefore), -40n);
    const replay = await item(admin, 'SELECT freehold.network_settlement_finalize($1::uuid,$2::uuid) AS item', [ids.operator, triangle.cycleId]);
    assert.equal(replay.duplicate, true);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.institution_journals WHERE idempotency_key = $1', [`netfinal:${first.paymentId}:origin`])).rows[0].n, 1);
    const reversed = await item(admin, 'SELECT freehold.network_settlement_reverse($1::uuid,$2::uuid) AS item', [ids.operator, first.paymentId]);
    assert.equal(reversed.originalJournalsKept, true);
    assert.equal((await admin.query('SELECT state FROM freehold.network_payments WHERE id = $1', [first.paymentId])).rows[0].state, 'REVERSED_BY_NEW_OPERATION');
    assert.equal((await admin.query(`SELECT status FROM freehold.network_obligations WHERE payment_id = $1`, [first.paymentId])).rows[0].status, 'SETTLED');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.institution_journals WHERE idempotency_key = $1', [`netfinal:${first.paymentId}:origin`])).rows[0].n, 1);
    const restoredCustomer = (await admin.query('SELECT balance_minor::text AS n FROM freehold.institution_ledger_accounts WHERE id = $1', [alderCustomer.accountId])).rows[0].n;
    assert.equal(BigInt(restoredCustomer) - BigInt(alderBefore), 10n);

    const thinPay = await openPayment(ids.alder, alder.institutionId, birch.institutionId, unfunded.accountId, birchCustomer.accountId, '4', 'thin-pay', `thin-${stamp}`, alderCert.certificateId, keys.alder.privateKey);
    await validate(thinPay.paymentId);
    const thinBuild = await build(ids.operator, 'BILATERAL', [alder.institutionId, birch.institutionId]);
    await item(admin, 'SELECT freehold.network_cycle_finalize($1::uuid,$2::uuid) AS item', [ids.operator, thinBuild.cycleId]);
    await item(admin, 'SELECT freehold.network_settlement_submit($1::uuid,$2::uuid) AS item', [ids.operator, thinBuild.cycleId]);
    await tx(() => item(admin, 'SELECT freehold.network_settlement_confirm($1::uuid,$2::uuid,$3::text) AS item', [ids.operator, thinBuild.cycleId, simulatedConfirmationSignature(thinBuild.cycleId, 'USD', SIM_KEY)]));
    await expectMessage(
      () => item(admin, 'SELECT freehold.network_settlement_finalize($1::uuid,$2::uuid) AS item', [ids.operator, thinBuild.cycleId]),
      'INSTITUTION_INSUFFICIENT',
    );
    assert.equal((await admin.query('SELECT state FROM freehold.network_payments WHERE id = $1', [thinPay.paymentId])).rows[0].state, 'SETTLEMENT_CONFIRMED');
    await item(admin, 'SELECT freehold.institution_fund_simulated($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::uuid) AS item', [ids.alder, alder.institutionId, unfunded.accountId, '4', `fund-thin-${stamp}`, randomUUID()]);
    const thinSettled = await item(admin, 'SELECT freehold.network_settlement_finalize($1::uuid,$2::uuid) AS item', [ids.operator, thinBuild.cycleId]);
    assert.equal(thinSettled.postedPayments, 1);
    const thinAgain = await item(admin, 'SELECT freehold.network_settlement_finalize($1::uuid,$2::uuid) AS item', [ids.operator, thinBuild.cycleId]);
    assert.equal(thinAgain.duplicate, true);

    const terminatedPay = await openPayment(ids.alder, alder.institutionId, drift.institutionId, alderCustomer.accountId, driftCustomer.accountId, '3', 'ended-member', `end-${stamp}`, alderCert.certificateId, keys.alder.privateKey);
    await transition(ids.operator, drift.institutionId, 'TERMINATED');
    await expectMessage(() => validate(terminatedPay.paymentId), 'NETWORK_MEMBER_SUSPENDED');
    await item(admin, 'SELECT freehold.network_payment_cancel($1::uuid,$2::uuid) AS item', [ids.alder, terminatedPay.paymentId]);

    const message = buildSimulatedMessage({ family: 'pacs.008.001.08', messageId: `msg${stamp}abcd`, paymentId: secondLeg.paymentId, amountMinor: '20', currency: 'USD', purpose: 'triangle-bc' });
    assert.equal(message.certification, false);
    assert.equal(message.liveSend, false);
    assert.equal(validateSimulatedMessage(message).ok, true);
    assert.equal(validateSimulatedMessage({ family: 'pacs.008.001.08', messageId: message.messageId, body: '<Document></Document>' }).ok, false);
    const recorded = await item(admin, 'SELECT freehold.network_message_record($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item', [ids.birch, secondLeg.paymentId, message.family, message.messageId, message.body]);
    assert.equal(recorded.certification, false);
    await expectMessage(
      () => item(admin, 'SELECT freehold.network_message_record($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item', [ids.birch, secondLeg.paymentId, message.family, message.messageId, message.body]),
      'NETWORK_MESSAGE_DUPLICATE',
    );
    const endpoint = await item(admin, 'SELECT freehold.institution_webhook_open($1::uuid,$2::uuid,$3::text) AS item', [ids.alder, alder.institutionId, 'https://example.test/network-alder']);
    await item(admin, 'SELECT freehold.institution_webhook_subscribe($1::uuid,$2::uuid,$3::uuid,$4::text) AS item', [ids.alder, alder.institutionId, endpoint.endpointId, 'network.payment.final']);
    const events = await admin.query(`SELECT body FROM freehold.institution_webhook_events WHERE institution_id = $1 AND event_type = 'network.payment.final'`, [alder.institutionId]);
    assert.ok(events.rows.some(row => row.body.state === 'FINAL' && row.body.simulated === true && row.body.externalSettlement === false));

    const balancesBeforeStress = (await admin.query('SELECT COALESCE(sum(balance_minor),0)::text AS n FROM freehold.institution_ledger_accounts')).rows[0].n;
    for (const scenario of ['MEMBER_FAILS_TO_SETTLE', 'LIQUIDITY_LOSS', 'OUTGOING_SURGE', 'DEBIT_LIMIT_EXCEEDED', 'PROVIDER_OUTAGE', 'SUSPENDED_DURING_CLEARING', 'DELAYED_CONFIRMATION', 'DUPLICATE_MESSAGE', 'UNEXPECTED_RETURN', 'CORRUPTED_EVIDENCE']) {
      const run = await item(admin, 'SELECT freehold.network_stress($1::uuid,$2::uuid,$3::text) AS item', [ids.operator, alder.institutionId, scenario]);
      assert.equal(run.inventedFunding, false);
      assert.equal(run.mutatedAccounts, false);
      assert.equal(run.regulatoryDetermination, false);
    }
    assert.equal((await admin.query('SELECT COALESCE(sum(balance_minor),0)::text AS n FROM freehold.institution_ledger_accounts')).rows[0].n, balancesBeforeStress);
    const loss = await item(admin, 'SELECT freehold.network_stress($1::uuid,$2::uuid,$3::text) AS item', [ids.operator, alder.institutionId, 'LIQUIDITY_LOSS']);
    assert.equal(loss.modeledAvailableMinor, '0');
    assert.equal((await admin.query('SELECT opening_liquidity_minor::text AS n FROM freehold.network_members WHERE institution_id = $1', [alder.institutionId])).rows[0].n, '100000000');

    const networkPayments = (await admin.query('SELECT count(*)::int AS n FROM freehold.network_payments')).rows[0].n;
    const worker1 = randomUUID();
    const worker2 = randomUUID();
    const claimed = await item(worker, 'SELECT freehold.network_outbox_claim($1::uuid,$2::integer) AS item', [worker1, 0]);
    assert.equal(claimed.postsPayments, false);
    assert.ok(claimed.claimed > 0);
    const reclaimed = await item(workerB, 'SELECT freehold.network_outbox_claim($1::uuid,$2::integer) AS item', [worker2, 30]);
    assert.ok(reclaimed.claimed > 0);
    for (const id of reclaimed.ids) {
      const done = await item(workerB, 'SELECT freehold.network_outbox_complete($1::uuid,$2::uuid) AS item', [worker2, id]);
      assert.equal(done.paymentRowsUnchanged, true);
    }
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.network_payments')).rows[0].n, networkPayments);

    const board = await item(admin, 'SELECT freehold.network_dashboard($1::uuid) AS item', [ids.operator]);
    assert.equal(board.customerNamesIncluded, false);
    assert.equal(board.liveRails, false);
    assert.equal(board.licensedPaymentSystem, false);
    assert.equal(board.independentVerificationStored, false);
    assert.equal(JSON.stringify(board).includes('Alder Simulation Tenant'), false);
    assert.equal(JSON.stringify(board).includes(`${stamp} customer`), false);
    await expectMessage(() => item(admin, 'SELECT freehold.network_activate_live($1::uuid) AS item', [ids.operator]), 'LIVE_MONETARY_ACTIVATION_REFUSED');
    await expectMessage(() => item(admin, 'SELECT freehold.institution_activate_live($1::uuid) AS item', [ids.alder]), 'LIVE_MONETARY_ACTIVATION_REFUSED');

    const networkCodes = report => JSON.stringify(report.accountingViolations.filter(row => String(row.code).startsWith('NETWORK_')).slice(0, 6));
    const clean = await verifyLedger(verifier);
    assert.equal(clean.network.claimsOutcome, 'NETWORK_CLAIMS_VERIFIED', networkCodes(clean));
    assert.equal(clean.network.externalSettlement, 'EXTERNAL_SETTLEMENT_UNAVAILABLE');
    assert.equal(clean.network.balancedInternalPositionIsExternalSettlement, false);
    assert.equal(clean.accountingViolations.some(row => String(row.code).startsWith('NETWORK_')), false);
    assert.equal(clean.accountingViolations.some(row => row.code === 'MONETARY_CHAIN_SUPPLY_MISMATCH'), chainBefore);

    const plantedPosition = (await admin.query('SELECT institution_id, gross_outgoing_minor, net_minor FROM freehold.network_cycle_positions WHERE cycle_id = $1 AND institution_id = $2', [triangle.cycleId, alder.institutionId])).rows[0];
    await admin.query('BEGIN');
    await admin.query(`SELECT set_config('freehold.network_writer','on',true)`);
    await expectMessage(
      () => admin.query('UPDATE freehold.network_payments SET signature_hex = $2 WHERE id = $1', [first.paymentId, '11'.repeat(64)]),
      'NETWORK_FINALITY_IMMUTABLE',
    );
    await admin.query('ROLLBACK');
    await admin.query('ALTER TABLE freehold.network_cycle_positions DISABLE TRIGGER network_positions_guard');
    await admin.query('ALTER TABLE freehold.network_payments DISABLE TRIGGER network_payments_guard');
    triggersOff = true;
    await admin.query('UPDATE freehold.network_cycle_positions SET gross_outgoing_minor = gross_outgoing_minor + 1, net_minor = net_minor - 1 WHERE cycle_id = $1 AND institution_id = $2', [triangle.cycleId, alder.institutionId]);
    const corrupted = await verifyLedger(verifier);
    assert.ok(corrupted.accountingViolations.some(row => row.code === 'NETWORK_POSITION' || row.code === 'NETWORK_NET_SUM'));
    assert.equal(corrupted.network.claimsOutcome, 'MISMATCH');
    await admin.query('UPDATE freehold.network_cycle_positions SET gross_outgoing_minor = $3, net_minor = $4 WHERE cycle_id = $1 AND institution_id = $2', [triangle.cycleId, alder.institutionId, plantedPosition.gross_outgoing_minor, plantedPosition.net_minor]);
    const originalSignature = (await admin.query('SELECT signature_hex FROM freehold.network_payments WHERE id = $1', [first.paymentId])).rows[0].signature_hex;
    await admin.query('UPDATE freehold.network_payments SET signature_hex = $2 WHERE id = $1', [first.paymentId, '11'.repeat(64)]);
    const forged = await verifyLedger(verifier);
    assert.ok(forged.accountingViolations.some(row => row.code === 'NETWORK_SIGNATURE'));
    await admin.query('UPDATE freehold.network_payments SET signature_hex = $2 WHERE id = $1', [first.paymentId, originalSignature]);
    await admin.query('ALTER TABLE freehold.network_cycle_positions ENABLE TRIGGER network_positions_guard');
    await admin.query('ALTER TABLE freehold.network_payments ENABLE TRIGGER network_payments_guard');
    triggersOff = false;
    const restored = await verifyLedger(verifier);
    assert.equal(restored.network.claimsOutcome, 'NETWORK_CLAIMS_VERIFIED');
    assert.equal(restored.accountingViolations.some(row => row.code === 'MONETARY_CHAIN_SUPPLY_MISMATCH'), chainBefore);
    assert.equal(restored.accountingViolations.some(row => String(row.code).startsWith('NETWORK_')), false);

    const started = Date.now();
    const scaleIds = [];
    for (let index = 0; index < 10; index += 1) {
      const opened = await openInstitution(ids.operator, `s${index}${stamp}`, `Scale ${index} Simulation Tenant`);
      await item(admin, 'SELECT freehold.network_member_apply($1::uuid,$2::uuid) AS item', [ids.operator, opened.institutionId]);
      await transition(ids.alder, opened.institutionId, 'UNDER_REVIEW');
      await transition(ids.birch, opened.institutionId, 'APPROVED_FOR_SIMULATION');
      await item(admin, 'SELECT freehold.network_rulebook_accept($1::uuid,$2::uuid,$3::uuid) AS item', [ids.operator, opened.institutionId, proposed.rulebookId]);
      await transition(ids.cedar, opened.institutionId, 'ACTIVE_SIMULATION');
      await setLiquidity(ids.operator, opened.institutionId, '100000000', '100000000', '100000000');
      const account = await customer(ids.operator, opened.institutionId, `s${index}-${stamp}`);
      await item(admin, 'SELECT freehold.institution_fund_simulated($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::uuid) AS item', [ids.operator, opened.institutionId, account.accountId, '10', `scale-fund-${index}-${stamp}`, randomUUID()]);
      scaleIds.push({ institutionId: opened.institutionId, accountId: account.accountId });
    }
    for (const row of scaleIds) {
      const key = generateMemberKeyPair();
      const cert = await register(ids.operator, row.institutionId, key.publicKeyHex, new Date(Date.now() - 60000), future);
      row.certificateId = cert.certificateId;
      row.privateKey = key.privateKey;
    }
    for (let index = 0; index < scaleIds.length; index += 1) {
      const origin = scaleIds[index];
      const beneficiary = scaleIds[(index + 1) % scaleIds.length];
      const opened = await openPayment(ids.operator, origin.institutionId, beneficiary.institutionId, origin.accountId, beneficiary.accountId, '1', `scale-${index}`, `scale-${index}-${stamp}`, origin.certificateId, origin.privateKey);
      await item(admin, 'SELECT freehold.network_payment_validate($1::uuid,$2::uuid) AS item', [ids.operator, opened.paymentId]);
    }
    const cycleStarted = Date.now();
    const scaleCycle = await build(ids.operator, 'MULTILATERAL', scaleIds.map(row => row.institutionId));
    const cycleMs = Date.now() - cycleStarted;
    const netStarted = Date.now();
    const scaleNet = await item(admin, 'SELECT freehold.network_cycle_finalize($1::uuid,$2::uuid) AS item', [ids.operator, scaleCycle.cycleId]);
    const netMs = Date.now() - netStarted;
    assert.equal(scaleNet.netSumMinor, '0');
    assert.equal(scaleCycle.included, 10);
    console.log(`NETWORK_PERF institutions=10 payments=10 cycleMs=${cycleMs} netMs=${netMs} setupMs=${Date.now() - started} rss=${process.memoryUsage().rss} notComparableToPhase7=313.887/s`);
    if (netMs < 3000 && cycleMs < 3000) {
      console.log('NETWORK_PERF institutions=100 skipped=false');
      const wide = [];
      const wideStarted = Date.now();
      for (let index = 0; index < 100; index += 1) {
        const opened = await openInstitution(ids.operator, `w${index}${stamp}`, `Wide ${index} Simulation Tenant`);
        await item(admin, 'SELECT freehold.network_member_apply($1::uuid,$2::uuid) AS item', [ids.operator, opened.institutionId]);
        await transition(ids.alder, opened.institutionId, 'UNDER_REVIEW');
        await transition(ids.birch, opened.institutionId, 'APPROVED_FOR_SIMULATION');
        await item(admin, 'SELECT freehold.network_rulebook_accept($1::uuid,$2::uuid,$3::uuid) AS item', [ids.operator, opened.institutionId, proposed.rulebookId]);
        await transition(ids.cedar, opened.institutionId, 'ACTIVE_SIMULATION');
        await setLiquidity(ids.operator, opened.institutionId, '100000000', '100000000', '100000000');
        wide.push(opened.institutionId);
      }
      console.log(`NETWORK_PERF institutions=100 membershipMs=${Date.now() - wideStarted} payments=0 rss=${process.memoryUsage().rss} notComparableToPhase7=313.887/s`);
    } else {
      console.log('NETWORK_PERF institutions=100 skipped=true reason=host budget notComparableToPhase7=313.887/s');
    }
    const afterScale = await verifyLedger(verifier);
    assert.equal(afterScale.network.claimsOutcome, 'NETWORK_CLAIMS_VERIFIED', networkCodes(afterScale));
    assert.equal(afterScale.network.externalSettlement, 'EXTERNAL_SETTLEMENT_UNAVAILABLE');
    assert.equal(afterScale.accountingViolations.some(row => String(row.code).startsWith('NETWORK_')), false);
    assert.equal(afterScale.accountingViolations.some(row => row.code === 'MONETARY_CHAIN_SUPPLY_MISMATCH'), chainBefore);

    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.ledger_journals')).rows[0].n, journalsBefore);
    assert.equal((await admin.query('SELECT COALESCE(sum(available_minor),0)::text AS n FROM freehold.accounts')).rows[0].n, availableBefore);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.institution_payments')).rows[0].n, paymentsBefore);
    assert.equal((await admin.query(`SELECT outstanding::text AS n FROM freehold.monetary_supply WHERE book_id = '20000000-0000-4000-8000-000000000001'`)).rows[0].n, supplyBefore);
    assert.equal((await admin.query('SELECT bool_or(live_authorized) AS live FROM freehold.institutions')).rows[0].live, false);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.legal_entities WHERE id = $1', [ENTITY])).rows[0].n, 1);
  } finally {
    if (triggersOff) {
      await admin.query('ALTER TABLE freehold.network_cycle_positions ENABLE TRIGGER network_positions_guard').catch(() => undefined);
      await admin.query('ALTER TABLE freehold.network_payments ENABLE TRIGGER network_payments_guard').catch(() => undefined);
    }
    await Promise.all([admin.end(), admin2.end(), api.end(), worker.end(), workerB.end(), verifier.end()].map(job => job.catch(() => undefined)));
  }
});
