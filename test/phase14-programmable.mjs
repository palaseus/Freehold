import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { verifyLedger } from '../scripts/lib/ledger-verifier.mjs';

const BOOK = '20000000-0000-4000-8000-000000000001';
const admin = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
const admin2 = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
const api = new Client({ connectionString: process.env.DATABASE_URL });
const worker = new Client({ connectionString: process.env.WORKER_DATABASE_URL });
const verifier = new Client({ connectionString: process.env.VERIFY_DATABASE_URL });

const item = async (client, sql, params = []) => (await client.query(sql, params)).rows[0].item;
const expectMessage = async (fn, message) => {
  await assert.rejects(fn, error => {
    assert.equal(error.message, message, `${error.code ?? ''} ${error.message}`);
    return true;
  });
};
const count = async (sql, params = []) => (await admin.query(sql, params)).rows[0].n;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('phase 14 simulates programmable finance without live issuance', async () => {
  await Promise.all([admin.connect(), admin2.connect(), api.connect(), worker.connect(), verifier.connect()]);
  const stamp = randomUUID().slice(0, 8);
  const ids = Object.fromEntries(['adminA', 'govA', 'payA', 'adminB', 'outsider'].map(name => [name, randomUUID()]));
  const verifierSource = readFileSync(new URL('../scripts/lib/ledger-verifier.mjs', import.meta.url), 'utf8');
  assert.equal(verifierSource.includes('network-trust'), false);
  assert.match(verifierSource, /LEDGER_VERIFIER_VERSION = '1\.7\.0'/);
  assert.equal(verifierSource.includes('freehold._program_execute'), false);
  const journalsBefore = await count('SELECT count(*)::int AS n FROM freehold.ledger_journals');
  const availableBefore = (await admin.query('SELECT COALESCE(sum(available_minor),0)::text AS n FROM freehold.accounts')).rows[0].n;
  const supplyBefore = (await admin.query('SELECT outstanding::text AS n FROM freehold.monetary_supply WHERE book_id = $1', [BOOK])).rows[0].n;
  const monetaryJournalsBefore = await count('SELECT count(*)::int AS n FROM freehold.monetary_journals');
  const chainBefore = (await verifyLedger(verifier)).accountingViolations.some(row => row.code === 'MONETARY_CHAIN_SUPPLY_MISMATCH');
  const from = new Date(Date.now() - 3600_000).toISOString();
  const until = new Date(Date.now() + 10 * 365 * 86400_000).toISOString();
  const later = new Date(Date.now() + 3600_000).toISOString();
  const soon = () => new Date(Date.now() + 2500).toISOString();
  const past = new Date(Date.now() - 1000).toISOString();
  const key = name => `p14${name}${stamp}`.slice(0, 40);
  const demo = {
    simulationOnly: true,
    liveIssuance: false,
    legalEscrow: false,
    distributedAtomicity: false,
    publicExchange: false,
  };
  let triggersOff = false;
  let north = null;
  let harbor = null;
  try {
    const names = Object.keys(ids);
    const values = names.flatMap(name => [ids[name], `p14-${name.toLowerCase()}-${stamp}@example.test`]);
    const placeholders = names.map((_, index) => `($${index * 2 + 1},$${index * 2 + 2},$${names.length * 2 + 1},$${names.length * 2 + 2 + index})`).join(',');
    await admin.query(
      `INSERT INTO freehold.users(id,email_normalized,password_hash,role) VALUES ${placeholders}`,
      [...values, 'phase14-unused-password-hash', ...names.map(name => name === 'outsider' ? 'USER' : 'ADMIN')],
    );
    await assert.rejects(
      () => api.query('SELECT freehold.program_workflow_run_due($1::uuid,$2::integer)', [randomUUID(), 1]),
      error => error.message.includes('permission denied for function program_workflow_run_due'),
    );
    await assert.rejects(
      () => api.query('SELECT id FROM freehold.program_workflows'),
      error => error.message.includes('permission denied for table program_workflows'),
    );
    await assert.rejects(
      () => verifier.query('SELECT freehold.program_dashboard($1::uuid)', [ids.adminA]),
      error => error.message.includes('permission denied for function program_dashboard'),
    );

    const open = async (actor, code, legalName) => item(admin, 'SELECT freehold.institution_open($1::uuid,$2::text,$3::text) AS item', [actor, code, legalName]);
    north = await open(ids.adminA, `p14n-${stamp}`, `North Program ${stamp}`);
    harbor = await open(ids.adminB, `p14h-${stamp}`, `Harbor Program ${stamp}`);
    const grant = (actor, institution, member, capability) => item(admin,
      'SELECT freehold.institution_grant($1::uuid,$2::uuid,$3::uuid,$4::text) AS item',
      [actor, institution, member, capability]);
    await grant(ids.adminA, north.institutionId, ids.govA, 'GOVERNANCE');
    await grant(ids.adminA, north.institutionId, ids.payA, 'PAYMENTS');
    await grant(ids.adminB, harbor.institutionId, ids.adminA, 'GOVERNANCE');
    await grant(ids.adminB, harbor.institutionId, ids.adminA, 'PAYMENTS');
    const customer = async (actor, institution, ref) => item(admin,
      'SELECT freehold.institution_customer_open($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item',
      [actor, institution, ref, `Simulated ${ref}`, 'USD']);
    const northCustomer = await customer(ids.adminA, north.institutionId, `n-${stamp}`);
    const harborCustomer = await customer(ids.adminB, harbor.institutionId, `h-${stamp}`);
    const fund = (actor, institution, account, amount, name) => item(admin,
      'SELECT freehold.institution_fund_simulated($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::uuid) AS item',
      [actor, institution, account, amount, key(name), randomUUID()]);
    await fund(ids.adminA, north.institutionId, northCustomer.accountId, '400000', 'fn');
    await fund(ids.adminB, harbor.institutionId, harborCustomer.accountId, '400000', 'fh');
    const accounts = async institution => {
      const rows = (await admin.query(
        'SELECT id, kind, balance_minor::text AS balance FROM freehold.institution_ledger_accounts WHERE institution_id = $1',
        [institution],
      )).rows;
      return Object.fromEntries(rows.map(row => [row.kind, row]));
    };
    const northAccounts = await accounts(north.institutionId);
    const harborAccounts = await accounts(harbor.institutionId);
    assert.equal(northAccounts.CLEARING.balance, '0');
    assert.equal(northAccounts.OPERATING.balance, '400000');

    const policy = async (actor, approver, institution, domain) => {
      const max = '1000000000001';
      const body = {
        language: 'fh-policy-1', domain, maxExposureMinor: max, currency: 'USD', currencies: ['USD'],
        highRiskMinor: '100000', approvalThresholdMinor: '100000',
      };
      const drafted = await item(admin,
        'SELECT freehold.program_policy_draft($1::uuid,$2::uuid,$3::text,$4::jsonb,$5::integer,$6::bigint,$7::text,$8::timestamptz,$9::timestamptz) AS item',
        [actor, institution, domain, JSON.stringify(body), 10, max, 'USD', from, until]);
      return item(admin, 'SELECT freehold.program_policy_approve($1::uuid,$2::uuid) AS item', [approver, drafted.policyId]);
    };
    for (const domain of ['PAYMENT', 'ESCROW', 'TREASURY', 'SETTLEMENT', 'ISSUANCE', 'ASSET_TRANSFER']) {
      await policy(ids.adminA, ids.govA, north.institutionId, domain);
    }
    for (const domain of ['PAYMENT', 'ESCROW', 'SETTLEMENT', 'ASSET_TRANSFER']) {
      await policy(ids.adminB, ids.adminA, harbor.institutionId, domain);
    }
    await expectMessage(
      () => policy(ids.adminA, ids.adminA, north.institutionId, 'RISK'),
      'PROGRAM_SELF_APPROVAL',
    );

    const draft = (actor, institution, definition, name, deadline = later, max = '1000000') => item(admin,
      'SELECT freehold.program_workflow_draft($1::uuid,$2::uuid,$3::jsonb,$4::bigint,$5::text,$6::timestamptz,$7::text,$8::integer) AS item',
      [actor, institution, JSON.stringify(definition), max, 'USD', deadline, key(name), 1]);
    const submit = (actor, workflowId) => item(admin, 'SELECT freehold.program_workflow_submit($1::uuid,$2::uuid) AS item', [actor, workflowId]);
    const approve = (actor, workflowId) => item(admin, 'SELECT freehold.program_workflow_approve($1::uuid,$2::uuid) AS item', [actor, workflowId]);
    const execute = (actor, workflowId, name) => item(admin,
      'SELECT freehold.program_workflow_execute($1::uuid,$2::uuid,$3::text) AS item',
      [actor, workflowId, key(name)]);
    const transferDef = (amount, fromAccount, toAccount) => ({
      language: 'fh-workflow-1', domain: 'PAYMENT',
      steps: [{ op: 'TRANSFER', fromAccount, toAccount, amountMinor: amount }],
    });

    await expectMessage(
      () => draft(ids.payA, north.institutionId, { language: 'fh-workflow-1', domain: 'PAYMENT', sql: 'select 1', steps: [{ op: 'RECONCILE' }] }, 'inj'),
      'PROGRAM_LANGUAGE',
    );
    await expectMessage(
      () => execute(ids.outsider, randomUUID(), 'out'),
      'PROGRAM_STATE',
    );
    const hidden = await draft(ids.payA, north.institutionId, { language: 'fh-workflow-1', domain: 'PAYMENT', steps: [{ op: 'RECONCILE' }] }, 'hid');
    await expectMessage(() => execute(ids.outsider, hidden.workflowId, 'outh'), 'INSTITUTION_FORBIDDEN');
    await expectMessage(
      () => admin.query('INSERT INTO freehold.program_workflows(institution_id, created_by, definition, definition_hash, max_exposure_minor, currency_code, deadline, idempotency_key, required_approvals) VALUES ($1,$2,$3::jsonb,$4,1,$5,clock_timestamp() + interval \'1 day\',$6,1)', [north.institutionId, ids.payA, '{}', 'ab'.repeat(32), 'USD', key('dir')]),
      'PROGRAM_DIRECT_WRITE_FORBIDDEN',
    );

    const payment = await draft(ids.payA, north.institutionId, transferDef('1000', northAccounts.OPERATING.id, northAccounts.TREASURY.id), 'pay');
    await submit(ids.payA, payment.workflowId);
    await expectMessage(() => approve(ids.payA, payment.workflowId), 'PROGRAM_SELF_APPROVAL');
    const journalsAtPreview = await count('SELECT count(*)::int AS n FROM freehold.institution_journals');
    const preview = await item(admin, 'SELECT freehold.program_workflow_preview($1::uuid,$2::uuid) AS item', [ids.payA, payment.workflowId]);
    assert.equal(preview.preview, true);
    assert.equal(preview.executed, false);
    assert.equal(preview.committedSandboxAccounting, false);
    assert.equal(await count('SELECT count(*)::int AS n FROM freehold.institution_journals'), journalsAtPreview);
    const approvedPayment = await approve(ids.govA, payment.workflowId);
    assert.equal(approvedPayment.status, 'APPROVED');
    await admin.query(`SELECT set_config('freehold.program_writer','on',false)`);
    await expectMessage(
      () => admin.query('UPDATE freehold.program_workflows SET definition = definition || \'{"note":"changed"}\'::jsonb WHERE id = $1', [payment.workflowId]),
      'PROGRAM_DEFINITION_IMMUTABLE',
    );
    const pinned = (await admin.query('SELECT policy_id FROM freehold.program_workflows WHERE id = $1', [payment.workflowId])).rows[0].policy_id;
    await expectMessage(
      () => admin.query(`UPDATE freehold.program_policies SET body = body || '{"note":"changed"}'::jsonb WHERE id = $1`, [pinned]),
      'PROGRAM_POLICY_IMMUTABLE',
    );
    await admin.query(`SELECT set_config('freehold.program_writer','off',false)`);
    const ran = await execute(ids.payA, payment.workflowId, 'payex');
    assert.equal(ran.state, 'COMPLETED');
    assert.equal(ran.atomicity, 'SINGLE_DATABASE');
    const replay = await execute(ids.payA, payment.workflowId, 'payex');
    assert.equal(replay.duplicate, true);
    assert.equal(replay.executionId, ran.executionId);
    const reversal = await draft(ids.payA, north.institutionId, {
      language: 'fh-workflow-1', domain: 'PAYMENT', steps: [{ op: 'REVERSAL', executionId: ran.executionId }],
    }, 'rev');
    await submit(ids.payA, reversal.workflowId);
    await approve(ids.govA, reversal.workflowId);
    const reversed = await execute(ids.payA, reversal.workflowId, 'revex');
    assert.equal(reversed.state, 'COMPLETED');
    let northNow = await accounts(north.institutionId);
    assert.equal(northNow.OPERATING.balance, '400000');
    assert.equal(northNow.TREASURY.balance, '0');

    const hold = await draft(ids.payA, north.institutionId, {
      language: 'fh-workflow-1', domain: 'PAYMENT',
      steps: [
        { op: 'HOLD', ref: 'h1', fromAccount: northAccounts.OPERATING.id, amountMinor: '500', beneficiaryInstitutionId: north.institutionId },
        { op: 'RELEASE', ref: 'h1', toAccount: northAccounts.TREASURY.id },
        { op: 'RECONCILE' },
      ],
    }, 'hold');
    await submit(ids.payA, hold.workflowId);
    await approve(ids.govA, hold.workflowId);
    const held = await execute(ids.payA, hold.workflowId, 'holdex');
    assert.equal(held.state, 'COMPLETED');
    northNow = await accounts(north.institutionId);
    assert.equal(northNow.OPERATING.balance, '399500');
    assert.equal(northNow.TREASURY.balance, '500');
    assert.equal(northNow.SUSPENSE.balance, '0');
    assert.equal(northNow.CLEARING.balance, '0');
    demo.conditionalPayment = true;
    demo.escrowRelease = true;

    const escrow = await item(admin,
      'SELECT freehold.program_escrow_fund($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::uuid,$6::text,$7::jsonb,$8::timestamptz,$9::text) AS item',
      [ids.payA, north.institutionId, northAccounts.OPERATING.id, '200', harbor.institutionId, 'cross', JSON.stringify({ language: 'fh-workflow-1', release: 'AUTHORIZED' }), later, key('esc')]);
    assert.equal(escrow.legalEscrow, false);
    const escrowRedone = item(admin,
      'SELECT freehold.program_escrow_fund($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::uuid,$6::text,$7::jsonb,$8::timestamptz,$9::text) AS item',
      [ids.payA, north.institutionId, northAccounts.OPERATING.id, '201', harbor.institutionId, 'cross', JSON.stringify({ language: 'fh-workflow-1', release: 'AUTHORIZED' }), later, key('esc')]);
    await expectMessage(
      () => escrowRedone,
      'PROGRAM_IDEMPOTENCY_CONFLICT',
    );
    const released = await item(admin, 'SELECT freehold.program_escrow_release($1::uuid,$2::uuid,$3::uuid) AS item', [ids.govA, escrow.escrowId, harborAccounts.OPERATING.id]);
    assert.equal(released.released, true);
    assert.equal(released.legalEscrow, false);
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_escrow_release($1::uuid,$2::uuid,$3::uuid) AS item', [ids.govA, escrow.escrowId, harborAccounts.OPERATING.id]),
      'PROGRAM_ESCROW',
    );
    const disputed = await item(admin,
      'SELECT freehold.program_escrow_fund($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::uuid,$6::text,$7::jsonb,$8::timestamptz,$9::text) AS item',
      [ids.payA, north.institutionId, northAccounts.OPERATING.id, '50', north.institutionId, 'dispute', JSON.stringify({ language: 'fh-workflow-1', release: 'AUTHORIZED' }), later, key('esd')]);
    await item(admin, 'SELECT freehold.program_escrow_dispute($1::uuid,$2::uuid) AS item', [ids.govA, disputed.escrowId]);
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_escrow_release($1::uuid,$2::uuid,$3::uuid) AS item', [ids.adminA, disputed.escrowId, northAccounts.TREASURY.id]),
      'PROGRAM_ESCROW',
    );
    await admin.query(`SELECT set_config('freehold.program_writer','on',false)`);
    await expectMessage(
      () => admin.query(`UPDATE freehold.program_escrows SET conditions = '{"language":"fh-workflow-1","release":"TIME"}'::jsonb WHERE id = $1`, [disputed.escrowId]),
      'PROGRAM_ESCROW_IMMUTABLE',
    );
    await admin.query(`SELECT set_config('freehold.program_writer','off',false)`);
    demo.escrowFunding = true;

    const recommend = await item(admin,
      'SELECT freehold.program_treasury_recommend($1::uuid,$2::uuid,$3::text,$4::bigint,$5::text,$6::text,$7::text) AS item',
      [ids.adminA, north.institutionId, 'SWEEP', '1000', 'USD', 'OPERATING', 'TREASURY']);
    assert.equal(recommend.executed, false);
    const journalsAtRecommend = await count('SELECT count(*)::int AS n FROM freehold.institution_journals');
    assert.equal(journalsAtRecommend, await count('SELECT count(*)::int AS n FROM freehold.institution_journals'));
    await item(admin, 'SELECT freehold.program_treasury_approve($1::uuid,$2::uuid) AS item', [ids.govA, recommend.treasuryId]);
    const swept = await item(admin, 'SELECT freehold.program_treasury_execute($1::uuid,$2::uuid,$3::text) AS item', [ids.payA, recommend.treasuryId, key('sw')]);
    assert.equal(swept.executed, true);
    assert.equal(swept.duplicate, false);
    const sweptAgain = await item(admin, 'SELECT freehold.program_treasury_execute($1::uuid,$2::uuid,$3::text) AS item', [ids.payA, recommend.treasuryId, key('sw')]);
    assert.equal(sweptAgain.duplicate, true);
    assert.equal(sweptAgain.journalId, swept.journalId);
    const tooLarge = await item(admin,
      'SELECT freehold.program_treasury_recommend($1::uuid,$2::uuid,$3::text,$4::bigint,$5::text,$6::text,$7::text) AS item',
      [ids.adminA, north.institutionId, 'SWEEP', '1000000000002', 'USD', 'OPERATING', 'TREASURY']);
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_treasury_approve($1::uuid,$2::uuid) AS item', [ids.govA, tooLarge.treasuryId]),
      'PROGRAM_POLICY',
    );
    const alert = await item(admin,
      'SELECT freehold.program_treasury_recommend($1::uuid,$2::uuid,$3::text,$4::bigint,$5::text,$6::text,$7::text) AS item',
      [ids.adminA, north.institutionId, 'CONCENTRATION_ALERT', '1', 'USD', 'OPERATING', 'TREASURY']);
    await item(admin, 'SELECT freehold.program_treasury_approve($1::uuid,$2::uuid) AS item', [ids.govA, alert.treasuryId]);
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_treasury_execute($1::uuid,$2::uuid,$3::text) AS item', [ids.payA, alert.treasuryId, key('al')]),
      'PROGRAM_TREASURY',
    );
    const monitor = await item(admin, 'SELECT freehold.program_treasury_monitor($1::uuid,$2::uuid) AS item', [ids.adminA, north.institutionId]);
    assert.equal(monitor.executed, false);
    assert.equal(monitor.inventedLiquidity, false);
    assert.equal(monitor.redemptionForecastScope, 'NOT_INSTITUTION_SCOPED');
    assert.equal(monitor.redemptionForecastMinor, '0');
    demo.treasuryRecommendation = true;
    demo.treasuryTransfer = true;

    const both = await item(admin,
      'SELECT freehold.program_settle_atomic($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::jsonb) AS item',
      [ids.adminA, north.institutionId, key('s1'), later, JSON.stringify([
        { institutionId: north.institutionId, debitAccount: northAccounts.TREASURY.id, creditAccount: northAccounts.OPERATING.id, amountMinor: '100' },
        { institutionId: north.institutionId, debitAccount: northAccounts.OPERATING.id, creditAccount: northAccounts.TREASURY.id, amountMinor: '100' },
      ])]);
    assert.equal(both.state, 'COMPLETED');
    assert.equal(both.atomicity, 'SINGLE_DATABASE');
    assert.equal(both.distributedAtomicity, false);
    const journalsAfterBoth = await count('SELECT count(*)::int AS n FROM freehold.institution_journals');
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_settle_atomic($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::jsonb) AS item',
        [ids.adminA, north.institutionId, key('s2'), later, JSON.stringify([
          { institutionId: north.institutionId, debitAccount: randomUUID(), creditAccount: northAccounts.OPERATING.id, amountMinor: '100' },
        ])]),
      'PROGRAM_FORBIDDEN',
    );
    assert.equal(await count('SELECT count(*)::int AS n FROM freehold.institution_journals'), journalsAfterBoth);
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_settle_atomic($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::jsonb) AS item',
        [ids.adminA, north.institutionId, key('s3'), later, JSON.stringify([
          { institutionId: north.institutionId, debitAccount: northAccounts.TREASURY.id, creditAccount: northAccounts.OPERATING.id, amountMinor: '10' },
          { institutionId: north.institutionId, debitAccount: northAccounts.TREASURY.id, creditAccount: northAccounts.OPERATING.id, amountMinor: '900000000000' },
        ])]),
      'INSTITUTION_INSUFFICIENT',
    );
    assert.equal(await count('SELECT count(*)::int AS n FROM freehold.institution_journals'), journalsAfterBoth);
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_settle_atomic($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::jsonb) AS item',
        [ids.payA, north.institutionId, key('s4'), later, JSON.stringify([
          { institutionId: harbor.institutionId, debitAccount: harborAccounts.TREASURY.id, creditAccount: harborAccounts.OPERATING.id, amountMinor: '10' },
        ])]),
      'INSTITUTION_FORBIDDEN',
    );
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_settle_atomic($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::jsonb) AS item',
        [ids.adminA, north.institutionId, key('sfx'), later, JSON.stringify([
          { institutionId: north.institutionId, debitAccount: northAccounts.TREASURY.id, creditAccount: northAccounts.OPERATING.id, amountMinor: '10', rate: '1.5' },
        ])]),
      'PROGRAM_LANGUAGE',
    );
    const duplicate = await item(admin,
      'SELECT freehold.program_settle_atomic($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::jsonb) AS item',
      [ids.adminA, north.institutionId, key('s1'), later, JSON.stringify([
        { institutionId: north.institutionId, debitAccount: northAccounts.TREASURY.id, creditAccount: northAccounts.OPERATING.id, amountMinor: '100' },
        { institutionId: north.institutionId, debitAccount: northAccounts.OPERATING.id, creditAccount: northAccounts.TREASURY.id, amountMinor: '100' },
      ])]);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.executionId, both.executionId);
    assert.equal(await count('SELECT count(*)::int AS n FROM freehold.institution_journals'), journalsAfterBoth);
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_settle_atomic($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::jsonb) AS item',
        [ids.adminA, north.institutionId, key('s1'), later, JSON.stringify([
          { institutionId: north.institutionId, debitAccount: northAccounts.TREASURY.id, creditAccount: northAccounts.OPERATING.id, amountMinor: '100' },
        ])]),
      'PROGRAM_IDEMPOTENCY_CONFLICT',
    );
    assert.equal(await count('SELECT count(*)::int AS n FROM freehold.institution_journals'), journalsAfterBoth);
    await admin.query('BEGIN');
    await admin.query('SELECT freehold.program_settle_atomic($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::jsonb)', [
      ids.adminA, north.institutionId, key('scrash'), later, JSON.stringify([
        { institutionId: north.institutionId, debitAccount: northAccounts.TREASURY.id, creditAccount: northAccounts.OPERATING.id, amountMinor: '5' },
      ]),
    ]);
    await admin.query('ROLLBACK');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM freehold.program_executions WHERE idempotency_key = $1', [key('scrash')])).rows[0].n, 0);
    const coordinated = await item(admin,
      'SELECT freehold.program_settle_coordinate($1::uuid,$2::uuid,$3::text,$4::jsonb) AS item',
      [ids.adminA, north.institutionId, key('coord'), JSON.stringify([{ amountMinor: '25' }])]);
    assert.equal(coordinated.state, 'UNKNOWN');
    assert.equal(coordinated.posted, false);
    assert.equal(coordinated.distributedAtomicity, false);
    assert.equal(coordinated.externalFinality, 'EXTERNAL_EVIDENCE_UNAVAILABLE');
    const coordinatedAgain = await item(admin,
      'SELECT freehold.program_settle_coordinate($1::uuid,$2::uuid,$3::text,$4::jsonb) AS item',
      [ids.adminA, north.institutionId, key('coord'), JSON.stringify([{ amountMinor: '25' }])]);
    assert.equal(coordinatedAgain.duplicate, true);
    assert.equal(coordinatedAgain.executionId, coordinated.executionId);
    assert.equal(await count('SELECT count(*)::int AS n FROM freehold.institution_journals'), journalsAfterBoth);
    northNow = await accounts(north.institutionId);
    const racingLegs = JSON.stringify([
      { institutionId: north.institutionId, debitAccount: northAccounts.TREASURY.id, creditAccount: northAccounts.OPERATING.id, amountMinor: northNow.OPERATING.balance },
    ]);
    const race = await Promise.allSettled([
      item(admin, 'SELECT freehold.program_settle_atomic($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::jsonb) AS item', [ids.adminA, north.institutionId, key('racea'), later, racingLegs]),
      item(admin2, 'SELECT freehold.program_settle_atomic($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::jsonb) AS item', [ids.adminA, north.institutionId, key('raceb'), later, racingLegs]),
    ]);
    const raceOk = race.filter(row => row.status === 'fulfilled');
    const raceFail = race.filter(row => row.status === 'rejected');
    assert.equal(raceOk.length, 1);
    assert.equal(raceFail.length, 1);
    assert.equal(raceFail[0].reason.message, 'INSTITUTION_INSUFFICIENT');
    const negative = await count('SELECT count(*)::int AS n FROM freehold.institution_ledger_accounts WHERE institution_id = $1 AND balance_minor < 0 AND kind <> \'SUSPENSE\'', [north.institutionId]);
    assert.equal(negative, 0);
    await item(admin,
      'SELECT freehold.program_settle_atomic($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::jsonb) AS item',
      [ids.adminA, north.institutionId, key('back'), later, JSON.stringify([
        { institutionId: north.institutionId, debitAccount: northAccounts.OPERATING.id, creditAccount: northAccounts.TREASURY.id, amountMinor: northNow.OPERATING.balance },
      ])]);
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_settle_atomic($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::jsonb) AS item',
        [ids.adminA, north.institutionId, key('liq'), later, JSON.stringify([
          { institutionId: north.institutionId, debitAccount: northAccounts.TREASURY.id, creditAccount: northAccounts.OPERATING.id, amountMinor: '900000000000' },
        ])]),
      'INSTITUTION_INSUFFICIENT',
    );
    const timed = await item(admin,
      'SELECT freehold.program_settle_atomic($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::jsonb) AS item',
      [ids.adminA, north.institutionId, key('time'), past, JSON.stringify([
        { institutionId: north.institutionId, debitAccount: northAccounts.TREASURY.id, creditAccount: northAccounts.OPERATING.id, amountMinor: '1' },
      ])]);
    assert.equal(timed.state, 'EXPIRED');
    assert.equal(timed.posted, false);
    await item(admin, 'SELECT freehold.program_suspend($1::uuid,$2::uuid,$3::boolean) AS item', [ids.govA, north.institutionId, true]);
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_settle_atomic($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::jsonb) AS item',
        [ids.adminA, north.institutionId, key('sus'), later, JSON.stringify([
          { institutionId: north.institutionId, debitAccount: northAccounts.TREASURY.id, creditAccount: northAccounts.OPERATING.id, amountMinor: '1' },
        ])]),
      'PROGRAM_SUSPENDED',
    );
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_suspend($1::uuid,$2::uuid,$3::boolean) AS item', [ids.govA, north.institutionId, false]),
      'PROGRAM_SELF_APPROVAL',
    );
    await item(admin, 'SELECT freehold.program_suspend($1::uuid,$2::uuid,$3::boolean) AS item', [ids.adminA, north.institutionId, false]);
    demo.multiLeg = true;
    demo.failedRecovery = true;

    const supply = (await admin.query('SELECT outstanding::text AS outstanding, pending_issuance::text AS pending FROM freehold.monetary_supply WHERE book_id = $1', [BOOK])).rows[0];
    const cap = (await admin.query('SELECT authorized_max_outstanding::text AS n FROM freehold.monetary_books WHERE id = $1', [BOOK])).rows[0].n;
    const eligible = (await admin.query('SELECT freehold._monetary_eligible($1::uuid)::text AS n', [BOOK])).rows[0].n;
    const requested = await item(admin,
      'SELECT freehold.program_fusd_request($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::timestamptz) AS item',
      [ids.adminA, north.institutionId, BOOK, '1', key('fu1'), null]);
    assert.equal(requested.supplyChanged, false);
    assert.equal(requested.liveIssuance, false);
    assert.equal((await admin.query('SELECT outstanding::text AS n FROM freehold.monetary_supply WHERE book_id = $1', [BOOK])).rows[0].n, supplyBefore);
    const requestedAgain = await item(admin,
      'SELECT freehold.program_fusd_request($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::timestamptz) AS item',
      [ids.adminA, north.institutionId, BOOK, '1', key('fu1'), null]);
    assert.equal(requestedAgain.duplicate, true);
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_fusd_request($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::timestamptz) AS item',
        [ids.adminA, north.institutionId, BOOK, '2', key('fu1'), null]),
      'PROGRAM_IDEMPOTENCY_CONFLICT',
    );
    const capped = await item(admin,
      'SELECT freehold.program_fusd_request($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::timestamptz) AS item',
      [ids.adminA, north.institutionId, BOOK, String(BigInt(cap) + 1n), key('fucap'), null]);
    assert.equal(capped.status, 'REJECTED_CAP');
    assert.equal(capped.supplyChanged, false);
    const coverageAmount = BigInt(supply.outstanding) + BigInt(supply.pending) + BigInt(eligible) + 1n;
    if (coverageAmount <= BigInt(cap)) {
      const uncovered = await item(admin,
        'SELECT freehold.program_fusd_request($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::timestamptz) AS item',
        [ids.adminA, north.institutionId, BOOK, coverageAmount.toString(), key('fucov'), null]);
      assert.equal(uncovered.status, 'REJECTED_COVERAGE');
      assert.equal(uncovered.supplyChanged, false);
    }
    const fusdWorkflow = await draft(ids.adminA, north.institutionId, {
      language: 'fh-workflow-1', domain: 'ISSUANCE',
      steps: [{ op: 'FUSD_ISSUE_REQUEST', bookId: BOOK, amountMinor: '1' }],
    }, 'fuw');
    await submit(ids.adminA, fusdWorkflow.workflowId);
    await approve(ids.govA, fusdWorkflow.workflowId);
    const fusdRan = await execute(ids.adminA, fusdWorkflow.workflowId, 'fuwex');
    assert.equal(fusdRan.supplyChanged, false);
    assert.equal((await admin.query('SELECT outstanding::text AS n FROM freehold.monetary_supply WHERE book_id = $1', [BOOK])).rows[0].n, supplyBefore);
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_activate_live($1::uuid) AS item', [ids.adminA]),
      'LIVE_MONETARY_ACTIVATION_REFUSED',
    );
    demo.fusdTransfer = true;

    await expectMessage(
      () => item(admin, 'SELECT freehold.program_asset_register($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item', [ids.adminA, north.institutionId, 'REAL_DEPOSIT', 'NODEP', 'USD']),
      'PROGRAM_ASSET',
    );
    const base = await item(admin, 'SELECT freehold.program_asset_register($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item', [ids.adminA, north.institutionId, 'SECURITY', `P14B${stamp.slice(0, 4).toUpperCase()}`, 'USD']);
    const quote = await item(admin, 'SELECT freehold.program_asset_register($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item', [ids.adminA, north.institutionId, 'RECEIVABLE', `P14Q${stamp.slice(0, 4).toUpperCase()}`, 'USD']);
    assert.equal(base.legalInstrument, false);
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_asset_authorize($1::uuid,$2::uuid) AS item', [ids.adminA, base.assetId]),
      'PROGRAM_SELF_APPROVAL',
    );
    await item(admin, 'SELECT freehold.program_asset_authorize($1::uuid,$2::uuid) AS item', [ids.govA, base.assetId]);
    await item(admin, 'SELECT freehold.program_asset_authorize($1::uuid,$2::uuid) AS item', [ids.govA, quote.assetId]);
    const issued = await item(admin, 'SELECT freehold.program_asset_issue($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text) AS item', [ids.payA, north.institutionId, base.assetId, '100', key('isb')]);
    assert.equal(issued.duplicate, false);
    assert.equal(issued.supplyMinor, '100');
    const issuedAgain = await item(admin, 'SELECT freehold.program_asset_issue($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text) AS item', [ids.payA, north.institutionId, base.assetId, '100', key('isb')]);
    assert.equal(issuedAgain.duplicate, true);
    assert.equal(issuedAgain.supplyMinor, '100');
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_asset_issue($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text) AS item', [ids.payA, north.institutionId, base.assetId, '101', key('isb')]),
      'PROGRAM_IDEMPOTENCY_CONFLICT',
    );
    await item(admin, 'SELECT freehold.program_asset_issue($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text) AS item', [ids.payA, north.institutionId, quote.assetId, '100', key('isq')]);
    await item(admin, 'SELECT freehold.program_asset_transfer($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::text) AS item', [ids.payA, north.institutionId, quote.assetId, harbor.institutionId, '40', key('tq')]);
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_asset_transfer($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::text) AS item', [ids.payA, north.institutionId, base.assetId, harbor.institutionId, '101', key('dbl')]),
      'PROGRAM_ASSET',
    );
    const spent = await Promise.allSettled([
      item(admin, 'SELECT freehold.program_asset_transfer($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::text) AS item', [ids.payA, north.institutionId, base.assetId, harbor.institutionId, '100', key('spa')]),
      item(admin2, 'SELECT freehold.program_asset_transfer($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::text) AS item', [ids.payA, north.institutionId, base.assetId, harbor.institutionId, '100', key('spb')]),
    ]);
    assert.equal(spent.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(spent.filter(row => row.status === 'rejected')[0].reason.message, 'PROGRAM_ASSET');
    await item(admin, 'SELECT freehold.program_asset_issue($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text) AS item', [ids.payA, north.institutionId, base.assetId, '30', key('isb2')]);
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_collateral_pledge($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::integer,$6::text) AS item', [ids.payA, harbor.institutionId, base.assetId, '1', 1000, 'nope']),
      'INSTITUTION_FORBIDDEN',
    );
    const pledged = await item(admin, 'SELECT freehold.program_collateral_pledge($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::integer,$6::text) AS item', [ids.payA, north.institutionId, base.assetId, '10', 1000, `arr${stamp}`]);
    assert.equal(pledged.countsAsReserve, false);
    assert.equal(pledged.loanCreated, false);
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_collateral_pledge($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::integer,$6::text) AS item', [ids.payA, north.institutionId, base.assetId, '10', 1000, `arr${stamp}`]),
      'PROGRAM_COLLATERAL',
    );
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_collateral_pledge($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::integer,$6::text) AS item', [ids.payA, north.institutionId, base.assetId, '30', 500, `big${stamp}`]),
      'PROGRAM_COLLATERAL',
    );
    const beforeDefault = (await admin.query('SELECT pledged_minor::text AS n FROM freehold.program_asset_positions WHERE asset_id = $1 AND holder_institution_id = $2', [base.assetId, north.institutionId])).rows[0].n;
    const defaulted = await item(admin, 'SELECT freehold.program_collateral_default($1::uuid,$2::uuid) AS item', [ids.govA, pledged.collateralId]);
    assert.equal(defaulted.unitsMoved, false);
    assert.equal(defaulted.loanCreated, false);
    const afterDefault = (await admin.query('SELECT pledged_minor::text AS n FROM freehold.program_asset_positions WHERE asset_id = $1 AND holder_institution_id = $2', [base.assetId, north.institutionId])).rows[0].n;
    assert.equal(afterDefault, beforeDefault);
    demo.assetRegistered = true;
    demo.collateral = true;

    await item(admin, 'SELECT freehold.program_exchange_admit($1::uuid,$2::uuid) AS item', [ids.govA, north.institutionId]);
    await item(admin, 'SELECT freehold.program_exchange_admit($1::uuid,$2::uuid) AS item', [ids.adminB, harbor.institutionId]);
    const firm = await item(admin,
      'SELECT freehold.program_quote_open($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::bigint,$7::text,$8::timestamptz) AS item',
      [ids.payA, north.institutionId, base.assetId, quote.assetId, '2', '5', 'FIRM', later]);
    assert.equal(firm.marketQuote, false);
    assert.equal(firm.executableMarket, false);
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_quote_execute($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text) AS item', [ids.adminB, harbor.institutionId, firm.quoteId, '3', key('badpx')]),
      'PROGRAM_PRICE',
    );
    assert.equal(await count('SELECT count(*)::int AS n FROM freehold.program_trades WHERE quote_id = $1', [firm.quoteId]), 0);
    const indicative = await item(admin,
      'SELECT freehold.program_quote_open($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::bigint,$7::text,$8::timestamptz) AS item',
      [ids.payA, north.institutionId, base.assetId, quote.assetId, '2', '1', 'INDICATIVE', later]);
    await expectMessage(
      () => item(admin, 'SELECT freehold.program_quote_execute($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text) AS item', [ids.adminB, harbor.institutionId, indicative.quoteId, '2', key('ind')]),
      'PROGRAM_QUOTE',
    );
    const traded = await item(admin,
      'SELECT freehold.program_quote_execute($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text) AS item',
      [ids.adminB, harbor.institutionId, firm.quoteId, '2', key('tr')]);
    assert.equal(traded.atomicity, 'SINGLE_DATABASE');
    assert.equal(traded.marketQuote, false);
    const tradedAgain = await item(admin,
      'SELECT freehold.program_quote_execute($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text) AS item',
      [ids.adminB, harbor.institutionId, firm.quoteId, '2', key('tr')]);
    assert.equal(tradedAgain.duplicate, true);
    demo.quote = true;
    demo.exchangeSettlement = true;

    const due = await draft(ids.payA, north.institutionId, { language: 'fh-workflow-1', domain: 'PAYMENT', steps: [{ op: 'RECONCILE' }] }, 'due');
    await submit(ids.payA, due.workflowId);
    await approve(ids.govA, due.workflowId);
    await admin.query('BEGIN');
    await admin.query('SELECT freehold.program_workflow_run_due($1::uuid,$2::integer)', [randomUUID(), 5]);
    await admin.query('ROLLBACK');
    assert.equal((await admin.query('SELECT status FROM freehold.program_workflows WHERE id = $1', [due.workflowId])).rows[0].status, 'APPROVED');
    const workerRan = await item(worker, 'SELECT freehold.program_workflow_run_due($1::uuid,$2::integer) AS item', [randomUUID(), 5]);
    assert.equal(workerRan.workerPosts, false);
    assert.equal(workerRan.databaseFunctionMayPost, true);
    assert.equal((await admin.query('SELECT status FROM freehold.program_workflows WHERE id = $1', [due.workflowId])).rows[0].status, 'COMPLETED');

    const scheduled = await draft(ids.payA, north.institutionId, {
      language: 'fh-workflow-1', domain: 'PAYMENT',
      steps: [{ op: 'RECONCILE', notBefore: soon() }],
    }, 'sch', later);
    await submit(ids.payA, scheduled.workflowId);
    await approve(ids.govA, scheduled.workflowId);
    const waiting = await execute(ids.payA, scheduled.workflowId, 'schex');
    assert.equal(waiting.state, 'SCHEDULED');
    assert.equal(waiting.executed, false);
    const expiring = await draft(ids.payA, north.institutionId, { language: 'fh-workflow-1', domain: 'PAYMENT', steps: [{ op: 'RECONCILE' }] }, 'exp', soon());
    await submit(ids.payA, expiring.workflowId);
    await approve(ids.govA, expiring.workflowId);
    const expiringEscrow = await item(admin,
      'SELECT freehold.program_escrow_fund($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::uuid,$6::text,$7::jsonb,$8::timestamptz,$9::text) AS item',
      [ids.payA, north.institutionId, northAccounts.OPERATING.id, '15', north.institutionId, 'short', JSON.stringify({ language: 'fh-workflow-1', release: 'AUTHORIZED' }), soon(), key('short')]);
    const expiringQuote = await item(admin,
      'SELECT freehold.program_quote_open($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::bigint,$7::text,$8::timestamptz) AS item',
      [ids.payA, north.institutionId, base.assetId, quote.assetId, '2', '1', 'FIRM', soon()]);
    await sleep(3200);
    const expiredWorkflow = await execute(ids.payA, expiring.workflowId, 'expex');
    assert.equal(expiredWorkflow.state, 'EXPIRED');
    assert.equal(expiredWorkflow.executed, false);
    const expiredEscrow = await item(admin, 'SELECT freehold.program_escrow_release($1::uuid,$2::uuid,$3::uuid) AS item', [ids.govA, expiringEscrow.escrowId, northAccounts.TREASURY.id]);
    assert.equal(expiredEscrow.released, false);
    assert.equal(expiredEscrow.status, 'EXPIRED');
    const expiredQuote = await item(admin,
      'SELECT freehold.program_quote_execute($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text) AS item',
      [ids.adminB, harbor.institutionId, expiringQuote.quoteId, '2', key('exq')]);
    assert.equal(expiredQuote.executed, false);
    assert.equal(expiredQuote.status, 'EXPIRED');
    const dueNow = await item(worker, 'SELECT freehold.program_workflow_run_due($1::uuid,$2::integer) AS item', [randomUUID(), 5]);
    assert.ok(dueNow.ran >= 1);
    assert.equal((await admin.query('SELECT status FROM freehold.program_workflows WHERE id = $1', [scheduled.workflowId])).rows[0].status, 'COMPLETED');

    const unknownWorkflow = await draft(ids.payA, north.institutionId, { language: 'fh-workflow-1', domain: 'PAYMENT', steps: [{ op: 'RECONCILE' }] }, 'unk');
    await submit(ids.payA, unknownWorkflow.workflowId);
    await approve(ids.govA, unknownWorkflow.workflowId);
    await item(admin, 'SELECT freehold.program_execution_unknown($1::uuid,$2::uuid) AS item', [ids.govA, unknownWorkflow.workflowId]);
    await expectMessage(() => execute(ids.payA, unknownWorkflow.workflowId, 'unk2'), 'PROGRAM_UNKNOWN_BLOCKED');

    const externalWorkflow = await draft(ids.payA, north.institutionId, {
      language: 'fh-workflow-1', domain: 'PAYMENT', steps: [{ op: 'COORDINATED_EXTERNAL', amountMinor: '40', note: 'awaiting an outside ledger' }],
    }, 'ext');
    await submit(ids.payA, externalWorkflow.workflowId);
    await approve(ids.govA, externalWorkflow.workflowId);
    const externalRan = await execute(ids.payA, externalWorkflow.workflowId, 'extex');
    assert.equal(externalRan.state, 'UNKNOWN');
    assert.equal(externalRan.distributedAtomicity, false);
    assert.equal(externalRan.executed, false);

    assert.equal(await count('SELECT count(*)::int AS n FROM freehold.ledger_journals'), journalsBefore);
    assert.equal((await admin.query('SELECT COALESCE(sum(available_minor),0)::text AS n FROM freehold.accounts')).rows[0].n, availableBefore);
    assert.equal((await admin.query('SELECT outstanding::text AS n FROM freehold.monetary_supply WHERE book_id = $1', [BOOK])).rows[0].n, supplyBefore);
    assert.equal(await count('SELECT count(*)::int AS n FROM freehold.monetary_journals'), monetaryJournalsBefore);
    assert.equal((await accounts(north.institutionId)).CLEARING.balance, '0');
    assert.equal((await accounts(harbor.institutionId)).CLEARING.balance, '0');
    const clean = await verifyLedger(verifier);
    assert.equal(clean.program.defects, 0, JSON.stringify(clean.accountingViolations.filter(row => String(row.code).startsWith('PROGRAM_'))));
    assert.equal(clean.program.externalEvidence, 'EXTERNAL_EVIDENCE_UNAVAILABLE');
    assert.equal(clean.program.internalAccountingProvesExternalClaim, false);
    assert.equal(clean.program.legalEscrow, false);
    assert.equal(clean.program.distributedAtomicity, false);
    assert.equal(clean.program.liveIssuance, false);
    assert.equal(clean.accountingViolations.some(row => row.code === 'MONETARY_CHAIN_SUPPLY_MISMATCH'), chainBefore);
    const originalHash = (await admin.query('SELECT snapshot_hash FROM freehold.program_policies WHERE id = $1', [pinned])).rows[0].snapshot_hash;
    await admin.query('ALTER TABLE freehold.program_policies DISABLE TRIGGER program_policies_guard');
    triggersOff = true;
    await admin.query('UPDATE freehold.program_policies SET snapshot_hash = $2 WHERE id = $1', [pinned, 'ab'.repeat(32)]);
    const planted = await verifyLedger(verifier);
    assert.ok(planted.accountingViolations.some(row => row.code === 'PROGRAM_POLICY_HASH'));
    assert.equal(planted.outcome, 'MISMATCH');
    await admin.query('UPDATE freehold.program_policies SET snapshot_hash = $2 WHERE id = $1', [pinned, originalHash]);
    await admin.query('ALTER TABLE freehold.program_policies ENABLE TRIGGER program_policies_guard');
    triggersOff = false;
    const restored = await verifyLedger(verifier);
    assert.equal(restored.program.defects, 0, JSON.stringify(restored.accountingViolations.filter(row => String(row.code).startsWith('PROGRAM_'))));
    assert.equal(restored.accountingViolations.some(row => row.code === 'MONETARY_CHAIN_SUPPLY_MISMATCH'), chainBefore);
    demo.verified = true;
    demo.isolation = true;

    const started = Date.now();
    for (let index = 0; index < 20; index += 1) {
      await item(admin, 'SELECT freehold.program_workflow_preview($1::uuid,$2::uuid) AS item', [ids.payA, payment.workflowId]);
    }
    const elapsedMs = Date.now() - started;
    console.log(`PROGRAM_PERF previews=20 elapsedMs=${elapsedMs} rss=${process.memoryUsage().rss} notComparableToPhase7=313.887/s`);
    console.log(`PROGRAM_DEMO ${JSON.stringify(demo)}`);
    assert.equal(demo.conditionalPayment, true);
    assert.equal(demo.verified, true);
  } finally {
    if (triggersOff) {
      await admin.query('ALTER TABLE freehold.program_policies ENABLE TRIGGER program_policies_guard').catch(() => undefined);
    }
    if (north) {
      const controls = (await admin.query('SELECT suspended, suspended_by FROM freehold.program_controls WHERE institution_id = $1', [north.institutionId])).rows[0];
      if (controls?.suspended) {
        const clearer = controls.suspended_by === ids.adminA ? ids.govA : ids.adminA;
        await admin.query('SELECT freehold.program_suspend($1::uuid,$2::uuid,false)', [clearer, north.institutionId]).catch(() => undefined);
      }
    }
    await Promise.all([admin.end(), admin2.end(), api.end(), worker.end(), verifier.end()].map(task => task.catch(() => undefined)));
  }
});
