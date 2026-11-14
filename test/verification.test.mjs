import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { verifyLedger } from '../scripts/lib/ledger-verifier.mjs';

let admin;
let verifier;
let api;
let worker;

before(async () => {
  admin = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
  verifier = new Client({ connectionString: process.env.VERIFY_DATABASE_URL });
  api = new Client({ connectionString: process.env.DATABASE_URL });
  worker = new Client({ connectionString: process.env.WORKER_DATABASE_URL });
  await Promise.all([admin.connect(), verifier.connect(), api.connect(), worker.connect()]);
});
after(async () => { await Promise.all([admin?.end(), verifier?.end(), api?.end(), worker?.end()]); });

async function mutate(sql, params = []) {
  await admin.query('BEGIN');
  try {
    await admin.query('SET LOCAL session_replication_role = replica');
    await admin.query(sql, params);
    await admin.query('COMMIT');
  } catch (e) { await admin.query('ROLLBACK'); throw e; }
}
async function hasViolation(code) {
  const r = await verifyLedger(verifier);
  assert.equal(r.outcome, 'MISMATCH', JSON.stringify(r, null, 2));
  const all = [...r.projectionDiscrepancies, ...r.referentialIntegrityViolations,
    ...r.idempotencyInconsistencies, ...r.accountingViolations, ...r.operationalEventViolations, ...r.governanceViolations];
  assert.ok(all.some(x => x.code === code), `missing ${code}; saw ${all.map(x => x.code).join(', ')}`);
  return r;
}
async function fixture() {
  const result = await admin.query(`SELECT j.id AS journal_id,j.operation_id,e.id AS entry_id,e.line_no,e.ledger_account_id,e.currency_code,e.side,e.amount_minor::text,
      la.customer_account_id,la.bucket,a.available_minor::text,a.reserved_minor::text
    FROM freehold.ledger_journals j JOIN freehold.ledger_entries e ON e.journal_id=j.id
    JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id
    LEFT JOIN freehold.accounts a ON a.id=la.customer_account_id
    ORDER BY j.recorded_at DESC,e.line_no LIMIT 1`);
  assert.ok(result.rowCount, 'integration fixture must contain a journal entry');
  return result.rows[0];
}

test('independent verifier accepts the clean ledger and exposes a machine-readable run identity', async () => {
  const r = await verifyLedger(verifier);
  assert.equal(r.outcome, 'VERIFIED', JSON.stringify(r, null, 2));
  assert.match(r.verificationRunId, /^[0-9a-f-]{36}$/);
  assert.equal(r.reportType, 'freehold.independent-ledger-verification');
  assert.equal(r.snapshot.isolation, 'REPEATABLE READ');
  assert.equal(r.snapshot.readOnly, true);
  assert.ok(r.counts.journalEntries > 0);
  assert.ok(r.counts.governanceRequests >= 0);
  assert.deepEqual(r.governanceViolations,[]);
  assert.ok(r.perCurrencyTotals.every(x => x.balanced));
});

test('independent verifier detects a governance approval forged as self approval', async () => {
  const row=(await admin.query(`SELECT r.id,r.initiator_id,d.principal_id,d.capability
    FROM freehold.governance_requests r JOIN freehold.governance_decisions d ON d.request_id=r.id
    WHERE r.status='EXECUTED' AND r.operation='FREEZE_ACCOUNT' AND d.decision='APPROVE' LIMIT 1`)).rows[0];
  assert.ok(row,'integration governance fixture must include an executed dual-control request');
  await mutate('UPDATE freehold.governance_decisions SET principal_id=$1 WHERE request_id=$2 AND principal_id=$3',[row.initiator_id,row.id,row.principal_id]);
  try { await hasViolation('GOVERNANCE_SELF_APPROVAL'); }
  finally { await mutate('UPDATE freehold.governance_decisions SET principal_id=$1 WHERE request_id=$2 AND principal_id=$3',[row.principal_id,row.id,row.initiator_id]); }
});

test('query timeout is INCOMPLETE and can never report VERIFIED', async () => {
  const r = await verifyLedger(verifier,{statementTimeoutMs:1000,afterSnapshot:()=>verifier.query('SELECT pg_sleep(1.2)')});
  assert.equal(r.outcome,'INCOMPLETE');
  assert.equal(r.error.code,'57014');
});

test('verifier credentials are read-only and cannot use financial functions', async () => {
  await assert.rejects(verifier.query("UPDATE freehold.accounts SET available_minor=available_minor WHERE false"), { code: '42501' });
  await assert.rejects(verifier.query("SELECT freehold.execute_internal_transfer(NULL,NULL,NULL,NULL,NULL,NULL,NULL)"), { code: '42501' });
  await assert.rejects(worker.query('UPDATE freehold.ledger_entries SET amount_minor=amount_minor WHERE false'), { code: '42501' });
  await assert.rejects(api.query('UPDATE freehold.ledger_entries SET amount_minor=amount_minor WHERE false'), { code: '42501' });
  await admin.query('GRANT UPDATE ON freehold.accounts TO freehold_verifier');
  try { assert.equal((await verifyLedger(verifier)).outcome,'ERROR','verifier must fail closed on privilege drift'); }
  finally { await admin.query('REVOKE UPDATE ON freehold.accounts FROM freehold_verifier'); }
});

test('detects corrupted account projection and reserved-hold projection', async () => {
  const accountRow = (await admin.query('SELECT id FROM freehold.accounts ORDER BY id LIMIT 1')).rows[0];
  assert.ok(accountRow);
  await mutate('UPDATE freehold.accounts SET available_minor=available_minor+1 WHERE id=$1', [accountRow.id]);
  try { await hasViolation('ACCOUNT_PROJECTION_MISMATCH'); }
  finally { await mutate('UPDATE freehold.accounts SET available_minor=available_minor-1 WHERE id=$1', [accountRow.id]); }
  const account = await admin.query("SELECT id FROM freehold.accounts WHERE reserved_minor < 9223372036854775807 LIMIT 1");
  const id = account.rows[0].id;
  await mutate('UPDATE freehold.accounts SET reserved_minor=reserved_minor+1 WHERE id=$1', [id]);
  try { await hasViolation('ACTIVE_HOLDS_RESERVED_MISMATCH'); }
  finally { await mutate('UPDATE freehold.accounts SET reserved_minor=reserved_minor-1 WHERE id=$1', [id]); }
});

test('detects orphaned outbox events and confirms duplicate operation events are prevented by a unique constraint', async () => {
  const event = (await admin.query('SELECT id,operation_id FROM freehold.outbox_events ORDER BY id LIMIT 1')).rows[0];
  assert.ok(event);
  await mutate('UPDATE freehold.outbox_events SET operation_id=$1 WHERE id=$2',[randomUUID(),event.id]);
  try { await hasViolation('OUTBOX_EVENT_ORPHAN_OPERATION'); }
  finally { await mutate('UPDATE freehold.outbox_events SET operation_id=$1 WHERE id=$2',[event.operation_id,event.id]); }
  await assert.rejects(admin.query(`INSERT INTO freehold.outbox_events(aggregate_id,operation_id,event_type,payload)
    SELECT aggregate_id,operation_id,event_type,payload FROM freehold.outbox_events WHERE id=$1`,[event.id]), { code:'23505' });
  assert.equal((await verifyLedger(verifier)).outcome,'VERIFIED');
});

test('detects a missing journal entry', async () => {
  const f = await fixture();
  const saved = (await admin.query('SELECT * FROM freehold.ledger_entries WHERE id=$1', [f.entry_id])).rows[0];
  await mutate('DELETE FROM freehold.ledger_entries WHERE id=$1', [f.entry_id]);
  try { await hasViolation('JOURNAL_LINE_COUNT_INVALID'); }
  finally {
    await mutate(`INSERT INTO freehold.ledger_entries(id,journal_id,line_no,ledger_account_id,currency_code,side,amount_minor)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [saved.id,saved.journal_id,saved.line_no,saved.ledger_account_id,saved.currency_code,saved.side,saved.amount_minor]);
  }
});

test('detects an unbalanced operation and an extra duplicate journal line', async () => {
  const f = await fixture();
  await mutate('UPDATE freehold.ledger_entries SET amount_minor=amount_minor+1 WHERE id=$1', [f.entry_id]);
  try { await hasViolation('JOURNAL_UNBALANCED'); }
  finally { await mutate('UPDATE freehold.ledger_entries SET amount_minor=amount_minor-1 WHERE id=$1', [f.entry_id]); }

  const e = (await admin.query('SELECT * FROM freehold.ledger_entries WHERE id=$1', [f.entry_id])).rows[0];
  const duplicateId = randomUUID();
  await mutate(`INSERT INTO freehold.ledger_entries(id,journal_id,line_no,ledger_account_id,currency_code,side,amount_minor)
    VALUES($1,$2,3,$3,$4,$5,$6)`, [duplicateId,e.journal_id,e.ledger_account_id,e.currency_code,e.side,e.amount_minor]);
  try { await hasViolation('JOURNAL_LINE_COUNT_INVALID'); }
  finally { await mutate('DELETE FROM freehold.ledger_entries WHERE id=$1', [duplicateId]); }
});

test('detects currency mismatch and orphaned journal operation reference', async () => {
  const f = await fixture();
  const otherCurrency = (await admin.query('SELECT code FROM freehold.currencies WHERE code<>$1 ORDER BY code LIMIT 1', [f.currency_code])).rows[0]?.code;
  assert.ok(otherCurrency);
  await mutate('UPDATE freehold.ledger_entries SET currency_code=$1 WHERE id=$2', [otherCurrency,f.entry_id]);
  try { await hasViolation('ENTRY_LEDGER_CURRENCY_MISMATCH'); }
  finally { await mutate('UPDATE freehold.ledger_entries SET currency_code=$1 WHERE id=$2', [f.currency_code,f.entry_id]); }

  const orphan = randomUUID();
  await mutate('UPDATE freehold.ledger_journals SET operation_id=$1 WHERE id=$2', [orphan,f.journal_id]);
  try { await hasViolation('JOURNAL_ORPHAN_OPERATION'); }
  finally { await mutate('UPDATE freehold.ledger_journals SET operation_id=$1 WHERE id=$2', [f.operation_id,f.journal_id]); }
});

test('a fabricated worker reconciliation cannot mask a detected ledger projection mismatch', async () => {
  const f = await fixture();
  const account = f.customer_account_id ?? (await admin.query('SELECT id FROM freehold.accounts LIMIT 1')).rows[0].id;
  const reportId = randomUUID();
  await admin.query(`INSERT INTO freehold.reconciliation_runs(reconciliation_id,balanced,report)
    VALUES($1,true,$2::jsonb)`, [reportId,JSON.stringify({ balanced: true, forged: true })]);
  await mutate('UPDATE freehold.accounts SET available_minor=available_minor+1 WHERE id=$1', [account]);
  try { await hasViolation('ACCOUNT_PROJECTION_MISMATCH'); }
  finally {
    await mutate('UPDATE freehold.accounts SET available_minor=available_minor-1 WHERE id=$1', [account]);
    await admin.query('DELETE FROM freehold.reconciliation_runs WHERE reconciliation_id=$1', [reportId]);
  }
});

test('detects inconsistent idempotency payload and hash', async () => {
  const req = (await admin.query(`SELECT operation_id,request_payload FROM freehold.idempotency_requests
    WHERE response_body IS NOT NULL LIMIT 1`)).rows[0];
  const changed = { ...req.request_payload, verifierCorruptionMarker: true };
  await mutate('UPDATE freehold.idempotency_requests SET request_payload=$1::jsonb WHERE operation_id=$2', [JSON.stringify(changed),req.operation_id]);
  try { await hasViolation('IDEMPOTENCY_PAYLOAD_HASH_MISMATCH'); }
  finally { await mutate('UPDATE freehold.idempotency_requests SET request_payload=$1::jsonb WHERE operation_id=$2', [JSON.stringify(req.request_payload),req.operation_id]); }
});

test('repeatable-read verification sees a stable snapshot while a transfer commits', async () => {
  const source = (await admin.query(`SELECT a.id,a.owner_user_id::text AS actor,a.currency_code
    FROM freehold.accounts a WHERE a.status='ACTIVE' AND a.available_minor>2
    ORDER BY a.id LIMIT 1`)).rows[0];
  const destination = (await admin.query(`SELECT id FROM freehold.accounts
    WHERE currency_code=$1 AND id<>$2 AND status='ACTIVE' ORDER BY id LIMIT 1`, [source.currency_code,source.id])).rows[0];
  assert.ok(source && destination, 'integration fixture requires two active same-currency accounts and spendable funds');
  let writerResult;
  const owner = (await admin.query('SELECT totp_secret_encrypted IS NOT NULL AS totp FROM freehold.users WHERE id=$1', [source.actor])).rows[0];
  const secret = randomBytes(32);
  await admin.query('SELECT freehold.auth_bind_session($1::uuid,1,$2::bytea,$3::timestamptz,3600)', [source.actor, secret, owner.totp ? new Date() : null]);
  const oldSnapshot = await verifyLedger(verifier, { afterSnapshot: async () => {
    await api.query('BEGIN');
    await api.query(`SELECT set_config('freehold.session_secret',$1,true)`, [secret.toString('hex')]);
    try {
      const result = await api.query(`SELECT freehold.execute_internal_transfer($1,$2,$3,$4,1,$5,$6) AS result`,
        [source.actor,source.id,destination.id,source.currency_code,`verify-race-${randomUUID()}`,randomUUID()]);
      writerResult = result.rows[0].result;
      await api.query('COMMIT');
    } catch (e) { await api.query('ROLLBACK'); throw e; }
  }});
  assert.equal(writerResult.state, 'COMPLETED');
  assert.equal(oldSnapshot.outcome, 'VERIFIED', JSON.stringify(oldSnapshot, null, 2));
  const currentSnapshot = await verifyLedger(verifier);
  assert.equal(currentSnapshot.outcome, 'VERIFIED', JSON.stringify(currentSnapshot, null, 2));
  assert.equal(currentSnapshot.counts.journals, oldSnapshot.counts.journals + 1);
  assert.equal(currentSnapshot.algorithmVersion, '1.7.0');
  assert.equal(currentSnapshot.accountingOutcome, 'VERIFIED');
  assert.equal(currentSnapshot.externalReserveOutcome, 'NOT_REQUIRED');
  assert.equal(currentSnapshot.scan.mode, 'server-aggregate');
  assert.equal(currentSnapshot.scan.complete, true);
  assert.equal(currentSnapshot.scan.processRetainedEntryRows, 0);
});

test('cancellation and a resource limit are incomplete and never verified', async () => {
  let calls = 0;
  const cancelled = await verifyLedger(verifier, { onProgress() { calls += 1; }, shouldCancel: () => calls > 2 });
  assert.equal(cancelled.outcome, 'INCOMPLETE');
  assert.equal(cancelled.error.code, 'CANCELLED');
  assert.ok(calls > 2);
  const limited = await verifyLedger(verifier, { maxRssBytes: 1 });
  assert.equal(limited.outcome, 'INCOMPLETE');
  assert.equal(limited.error.code, 'RESOURCE_LIMIT');
});
