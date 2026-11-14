#!/usr/bin/env node
// SQL phases for the disposable PITR drill. The shell owns containers and WAL files.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { verifyLedger } from './lib/ledger-verifier.mjs';

const phase = process.argv[2];
const statePath = process.env.PITR_STATE;
const adminUrl = process.env.PITR_ADMIN_URL;
if (!statePath || !adminUrl) throw new Error('PITR_STATE and PITR_ADMIN_URL are required');
const parsed = new URL(adminUrl);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !parsed.pathname.includes('disposable')) {
  throw new Error('Refusing a database that is not a loopback disposable PITR target');
}
const readState = async () => JSON.parse(await readFile(statePath, 'utf8'));
const writeState = async state => writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
const client = new Client({ connectionString: adminUrl, application_name: `freehold-pitr-${phase}` });
await client.connect();
const one = async (sql, args = []) => (await client.query(sql, args)).rows[0];
const fail = message => { throw new Error(message); };

try {
  if (phase === 'setup') {
    await client.query('UPDATE freehold.ledger_settings SET sandbox_enabled=true WHERE singleton');
    const actor = randomUUID();
    const reviewer = randomUUID();
    const beneficiary = randomUUID();
    await client.query(`INSERT INTO freehold.users(id,email_normalized,password_hash,role) VALUES
      ($1,$2,'pitr-unused','ADMIN'),($3,$4,'pitr-unused','ADMIN'),($5,$6,'pitr-unused','USER')`,
      [actor, `pitr-${actor}@invalid.test`, reviewer, `pitr-reviewer-${reviewer}@invalid.test`, beneficiary, `pitr-${beneficiary}@invalid.test`]);
    await client.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)', [actor, 'ACCOUNT_ADMIN', 'disposable pitr']);
    await client.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)', [actor, 'EMERGENCY_CONTROL', 'disposable pitr']);
    await client.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)', [reviewer, 'FINANCIAL_REVIEWER', 'disposable pitr']);
    await client.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)', [reviewer, 'INSTITUTION_ADMIN', 'disposable pitr']);
    const source = (await one('SELECT freehold.create_account($1,$2,$3,$4) AS result', [actor, 'USD', `pitr-source-${randomUUID()}`, randomUUID()])).result.accountId;
    const destination = (await one('SELECT freehold.create_account($1,$2,$3,$4) AS result', [beneficiary, 'USD', `pitr-dest-${randomUUID()}`, randomUUID()])).result.accountId;
    await client.query('SELECT freehold.sandbox_fund_account($1,$2,10000,$3,$4,$5)', [actor, source, `pitr-fund-${randomUUID()}`, 'Disposable PITR funding', randomUUID()]);
    const transferA = (await one('SELECT freehold.execute_internal_transfer($1,$2,$3,$4,100,$5,$6) AS result', [actor, source, destination, 'USD', `pitr-a-${randomUUID()}`, randomUUID()])).result;
    if (transferA.state !== 'COMPLETED') fail(`transaction A did not complete: ${transferA.state}`);
    const lostKey = `pitr-lost-${randomUUID()}`;
    const lostCorrelation = randomUUID();
    const lost = (await one('SELECT freehold.execute_internal_transfer($1,$2,$3,$4,9,$5,$6) AS result', [actor, source, destination, 'USD', lostKey, lostCorrelation])).result;
    const lostRetry = (await one('SELECT freehold.execute_internal_transfer($1,$2,$3,$4,9,$5,$6) AS result', [actor, source, destination, 'USD', lostKey, lostCorrelation])).result;
    const lostJournals = (await one('SELECT count(*)::int AS count FROM freehold.ledger_journals WHERE operation_id=$1', [lost.operationId])).count;
    if (lost.operationId !== lostRetry.operationId || lostJournals !== 1) fail('lost response retry did not keep a single journal');
    await client.query('SELECT freehold.governance_suspend_writes($1,$2)', [actor, 'Disposable PITR suspension']);
    const request = (await one('SELECT freehold.governance_create_resume_request($1,$2,$3) AS result', [actor, 'Disposable PITR governance', `pitr-gov-${randomUUID()}`])).result;
    await client.query('SELECT freehold.governance_decide($1,$2,$3)', [reviewer, request.requestId, 'APPROVE']);
    const executed = (await one('SELECT freehold.governance_execute($1,$2,$3,$4) AS result', [reviewer, request.requestId, `pitr-exec-${randomUUID()}`, randomUUID()])).result;
    if (executed.status !== 'EXECUTED') fail(`governance execution status ${executed.status}`);
    const journals = (await one('SELECT count(*)::int AS count FROM freehold.ledger_journals')).count;
    await writeState({ actor, reviewer, beneficiary, source, destination, transferA: transferA.operationId, lostOperation: lost.operationId, requestId: request.requestId, journalsBeforeB: journals });
    console.log(`setup journals ${journals} operationA ${transferA.operationId}`);
  } else if (phase === 'mark') {
    const state = await readState();
    await client.query('SELECT pg_switch_wal()');
    const marked = await one("SELECT clock_timestamp() AS ts, pg_current_wal_lsn() AS lsn");
    state.boundaryTime = marked.ts.toISOString();
    state.boundaryLsn = marked.lsn;
    await writeState(state);
    console.log(`boundary ${state.boundaryTime} ${state.boundaryLsn}`);
  } else if (phase === 'post-b') {
    const state = await readState();
    const transferB = (await one('SELECT freehold.execute_internal_transfer($1,$2,$3,$4,4,$5,$6) AS result', [state.actor, state.source, state.destination, 'USD', `pitr-b-${randomUUID()}`, randomUUID()])).result;
    if (transferB.state !== 'COMPLETED') fail(`transaction B did not complete: ${transferB.state}`);
    await client.query('SELECT pg_switch_wal()');
    state.transferB = transferB.operationId;
    state.journalsAfterB = (await one('SELECT count(*)::int AS count FROM freehold.ledger_journals')).count;
    await writeState(state);
    console.log(`posted B ${transferB.operationId} journals ${state.journalsAfterB}`);
  } else if (phase === 'assert-target') {
    const state = await readState();
    const countA = (await one('SELECT count(*)::int AS count FROM freehold.ledger_journals WHERE operation_id=$1', [state.transferA])).count;
    const countB = (await one('SELECT count(*)::int AS count FROM freehold.ledger_journals WHERE operation_id=$1', [state.transferB])).count;
    const request = await one('SELECT status FROM freehold.governance_requests WHERE id=$1', [state.requestId]);
    const replay = (await one('SELECT freehold.governance_execute($1,$2,$3,$4) AS result', [state.reviewer, state.requestId, `pitr-replay-${randomUUID()}`, randomUUID()])).result;
    const journals = (await one('SELECT count(*)::int AS count FROM freehold.ledger_journals')).count;
    if (countA !== 1) fail('transaction A is missing at the recovery target');
    if (countB !== 0) fail('transaction B is present, so the recovery target did not exclude it');
    if (request.status !== 'EXECUTED' || replay.status !== 'EXECUTED') fail('executed governance request was not replay-safe');
    const verifier = new Client({ connectionString: process.env.VERIFY_DATABASE_URL, application_name: 'freehold-pitr-verifier' });
    await verifier.connect();
    let report;
    const started = Date.now();
    try { report = await verifyLedger(verifier, { statementTimeoutMs: 120000 }); }
    finally { await verifier.end(); }
    state.target = { countA, countB, journals, governanceStatus: request.status, replayStatus: replay.status, verification: report.outcome, verificationMs: Date.now() - started, bAbsentBecause: 'Transaction B committed after the recorded recovery boundary. Replay stopped at that boundary, so B was never applied. Its absence is the selected target, not a damaged journal.' };
    await writeState(state);
    if (report.outcome !== 'VERIFIED') fail(`target verification ${report.outcome}`);
    console.log(`PASS target journals ${journals} verification ${report.outcome} in ${state.target.verificationMs} ms; B absent by recovery target`);
  } else if (phase === 'assert-crash') {
    const unbalanced = (await one("SELECT count(*)::int AS count FROM (SELECT journal_id FROM freehold.ledger_entries GROUP BY journal_id HAVING sum(CASE WHEN side='DEBIT' THEN amount_minor ELSE -amount_minor END)<>0) u")).count;
    const verifier = new Client({ connectionString: process.env.VERIFY_DATABASE_URL, application_name: 'freehold-pitr-crash-verifier' });
    await verifier.connect();
    let report;
    const started = Date.now();
    try { report = await verifyLedger(verifier, { statementTimeoutMs: 120000 }); }
    finally { await verifier.end(); }
    const state = await readState();
    state.crash = { unbalancedJournals: unbalanced, verification: report.outcome, verificationMs: Date.now() - started, journals: report.counts.journals };
    await writeState(state);
    if (unbalanced !== 0 || report.outcome !== 'VERIFIED') fail(`crash recovery verification ${report.outcome} unbalanced ${unbalanced}`);
    console.log(`PASS crash recovery ${report.outcome} journals ${report.counts.journals}`);
  } else if (phase === 'inconsistent') {
    const state = await readState();
    await client.query('ALTER TABLE freehold.accounts DISABLE TRIGGER USER');
    await client.query('UPDATE freehold.accounts SET available_minor = available_minor + 1 WHERE id=$1', [state.source]);
    await client.query('ALTER TABLE freehold.accounts ENABLE TRIGGER USER');
    const verifier = new Client({ connectionString: process.env.VERIFY_DATABASE_URL, application_name: 'freehold-pitr-inconsistent' });
    await verifier.connect();
    let report;
    try { report = await verifyLedger(verifier, { statementTimeoutMs: 120000 }); }
    finally { await verifier.end(); }
    state.inconsistent = { verification: report.outcome, projectionDiscrepancies: report.projectionDiscrepancies?.length ?? null };
    await writeState(state);
    if (report.outcome === 'VERIFIED') fail('verifier reported VERIFIED after a deliberate projection change');
    console.log(`PASS inconsistent projection reported ${report.outcome}`);
  } else fail(`unknown phase ${phase}`);
} finally { await client.end().catch(() => {}); }
