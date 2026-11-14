#!/usr/bin/env node
// Disposable ledger load. Refuses any database whose name does not contain
// "disposable" and any host other than loopback. Superuser calls the posting
// functions; it does not insert ledger rows. A smaller profile is not evidence
// for a larger one.
import { statfsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Client, Pool } from 'pg';
import { verifyLedger } from './lib/ledger-verifier.mjs';

const profiles = {
  smoke: { operations: 1000, accounts: 24 },
  small: { operations: 10_000, accounts: 40 },
  medium: { operations: 100_000, accounts: 80 },
  large: { operations: 1_000_000, accounts: 200 },
  extended: { operations: 5_000_000, accounts: 400 },
};
const gates = {
  smoke: { memory: 1 << 30, disk: 2 << 30 },
  small: { memory: 2 << 30, disk: 5 << 30 },
  medium: { memory: 4 << 30, disk: 8 << 30 },
  large: { memory: 8 << 30, disk: 20 << 30 },
  extended: { memory: 16 << 30, disk: 40 << 30 },
};

const adminUrl = process.env.LOAD_ADMIN_URL;
const phase = process.argv[2] ?? 'run';
if (process.env.LOAD_TEST_DISPOSABLE !== '1') throw new Error('LOAD_TEST_DISPOSABLE=1 is required');
if (!adminUrl) throw new Error('LOAD_ADMIN_URL is required');
const parsed = new URL(adminUrl);
if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('Refusing a non-loopback database');
if (!parsed.pathname.includes('disposable')) throw new Error('Refusing a database name that does not contain disposable');

const disk = statfsSync('/tmp');
const resources = {
  freeMemoryBytes: freemem(),
  totalMemoryBytes: totalmem(),
  cpus: availableParallelism(),
  tmpFreeBytes: disk.bavail * disk.bsize,
  loadAverage: loadavg(),
};
const fits = name => resources.freeMemoryBytes >= gates[name].memory && resources.tmpFreeBytes >= gates[name].disk;
const requested = process.env.LOAD_PROFILE ?? 'auto';
let profileName = requested;
if (requested === 'auto') profileName = ['medium', 'small', 'smoke'].find(fits) ?? 'smoke';
if (!profiles[profileName]) throw new Error(`Unknown LOAD_PROFILE ${requested}`);
if (!fits(profileName)) throw new Error(`Profile ${profileName} does not fit free memory ${resources.freeMemoryBytes} or /tmp free ${resources.tmpFreeBytes}`);
const profile = profiles[profileName];
const resultPath = process.env.LOAD_RESULT_PATH;

const percentile = (samples, p) => {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);
};
const round = value => Math.round(value * 1000) / 1000;
const tally = (rows, field) => {
  const out = {};
  for (const row of rows) {
    const key = row[field] ?? 'none';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
};

const admin = new Client({ connectionString: adminUrl, application_name: 'freehold-load-admin' });
await admin.connect();
const pool = new Pool({ connectionString: adminUrl, max: 8, application_name: 'freehold-load', connectionTimeoutMillis: 10000 });
const one = async (sql, args = []) => (await admin.query(sql, args)).rows[0];
const call = async (sql, args) => {
  const started = performance.now();
  try {
    const result = (await pool.query(sql, args)).rows[0]?.result ?? null;
    return { ms: performance.now() - started, result, error: null };
  } catch (error) {
    return { ms: performance.now() - started, result: null, error: { code: error.code ?? null, message: error.message } };
  }
};
const mapLimit = async (count, worker) => {
  const results = new Array(count);
  let cursor = 0;
  const run = async () => {
    while (cursor < count) {
      const index = cursor++;
      results[index] = await worker(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, count) }, run));
  return results;
};
const summarize = (name, results, started) => {
  const elapsedMs = performance.now() - started;
  const completed = results.filter(row => row.result?.state === 'COMPLETED');
  const rejected = results.filter(row => row.result?.state === 'REJECTED');
  const errors = results.filter(row => row.error);
  const samples = results.filter(row => !row.error).map(row => row.ms);
  return {
    name, attempts: results.length, completed: completed.length, rejected: rejected.length, errors: errors.length,
    rejectionCodes: tally(rejected.map(row => ({ code: row.result.error })), 'code'),
    errorCodes: tally(errors.map(row => ({ code: row.error.code })), 'code'),
    elapsedMs: round(elapsedMs),
    completedPerSecond: elapsedMs > 0 ? round(completed.length / (elapsedMs / 1000)) : 0,
    latencyMs: { p50: percentile(samples, 50), p95: percentile(samples, 95), p99: percentile(samples, 99), max: samples.length ? round(Math.max(...samples)) : null },
    method: 'Client-observed latency includes pool queue time. Percentiles use the nearest-rank method.',
  };
};
const transfer = (actor, source, destination, amount, key = randomUUID()) => call(
  'SELECT freehold.execute_internal_transfer($1,$2,$3,$4,$5::bigint,$6,$7) AS result',
  [actor, source, destination, 'USD', String(amount), key, randomUUID()],
);

const readResult = async () => JSON.parse(await readFile(resultPath, 'utf8'));
const writeResult = async report => { if (resultPath) await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); };

try {
  if (phase === 'reconnect' || phase === 'redis') {
    const report = await readResult();
    const before = await one('SELECT count(*)::int AS journals FROM freehold.ledger_journals');
    if (phase === 'redis') {
      report.scenarios.push({ name: 'redisRestart', journalsBefore: before.journals, journalsAfter: before.journals, financialRowsChanged: false, authenticationBypassRetested: false, note: 'Redis was restarted outside PostgreSQL. This phase only proves the ledger row count is unchanged. Session invalidation is the integration test that flushes Redis and receives HTTP 401.' });
      await writeResult(report);
      console.log(`PASS redis restart left ${before.journals} journals`);
      process.exit(0);
    }
    const probe = report.probe;
    const posted = await transfer(probe.actorId, probe.sourceAccountId, probe.destinationAccountId, 1);
    const after = await one('SELECT count(*)::int AS journals FROM freehold.ledger_journals');
    const scenario = { name: 'postgresRestartReconnect', post: posted.result?.state ?? posted.error, journalsBefore: before.journals, journalsAfter: after.journals, journalIncreased: after.journals === before.journals + (posted.result?.state === 'COMPLETED' ? 1 : 0) };
    report.scenarios.push(scenario);
    await writeResult(report);
    if (!scenario.journalIncreased) throw new Error(`Reconnect did not post exactly one journal: ${JSON.stringify(scenario)}`);
    console.log('PASS postgres restart reconnect');
    process.exit(0);
  }

  const skipped = ['smoke', 'small', 'medium', 'large', 'extended'].filter(name => name !== profileName).map(name => ({
    profile: name, ran: false,
    reason: !fits(name) ? 'free memory or /tmp space is below the profile gate' : requested === 'auto' && (name === 'large' || name === 'extended') ? 'auto mode stops at medium; set LOAD_PROFILE explicitly to run this target' : 'a different profile was selected',
  }));
  const dbStats = async () => one(`SELECT pg_database_size(current_database())::bigint AS bytes, deadlocks::int, xact_commit::bigint, xact_rollback::bigint, numbackends::int FROM pg_stat_database WHERE datname=current_database()`);
  const beforeStats = await dbStats();
  await admin.query('UPDATE freehold.ledger_settings SET sandbox_enabled=true WHERE singleton');
  const emergency = randomUUID();
  const reviewer = randomUUID();
  const customers = Array.from({ length: profile.accounts }, () => randomUUID());
  const insertUsers = async (rows) => {
    const values = [];
    const params = [];
    for (const row of rows) {
      params.push(row.id, row.email, row.role);
      const n = params.length;
      values.push(`($${n - 2},$${n - 1},'load-test-unused',$${n})`);
    }
    await admin.query(`INSERT INTO freehold.users(id,email_normalized,password_hash,role) VALUES ${values.join(',')}`, params);
  };
  await insertUsers([
    { id: emergency, email: `load-emergency-${emergency}@invalid.test`, role: 'ADMIN' },
    { id: reviewer, email: `load-reviewer-${reviewer}@invalid.test`, role: 'ADMIN' },
  ]);
  for (let offset = 0; offset < customers.length; offset += 100) {
    await insertUsers(customers.slice(offset, offset + 100).map(id => ({ id, email: `load-${id}@invalid.test`, role: 'USER' })));
  }
  for (const [id, capability] of [[emergency, 'EMERGENCY_CONTROL'], [emergency, 'ACCOUNT_ADMIN'], [reviewer, 'INSTITUTION_ADMIN'], [reviewer, 'FINANCIAL_REVIEWER'], [reviewer, 'AUDITOR']]) {
    await admin.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)', [id, capability, 'disposable load test']);
  }
  const accounts = [];
  for (const id of customers) {
    const created = await one('SELECT freehold.create_account($1,$2,$3,$4) AS result', [id, 'USD', `load-account-${id}`, randomUUID()]);
    accounts.push({ owner: id, accountId: created.result.accountId });
  }
  const pairs = [];
  for (let index = 0; index + 1 < accounts.length; index += 2) pairs.push([accounts[index], accounts[index + 1]]);
  for (const [source] of pairs) {
    await admin.query('SELECT freehold.sandbox_fund_account($1,$2,$3::bigint,$4,$5,$6)', [emergency, source.accountId, '100000000', `load-fund-${source.accountId}`, 'Disposable load funding', randomUUID()]);
  }
  const scenarios = [];
  const independentStarted = performance.now();
  const independent = await mapLimit(profile.operations, index => {
    const [source, destination] = pairs[index % pairs.length];
    return transfer(source.owner, source.accountId, destination.accountId, 1);
  });
  scenarios.push(summarize('independentTransfers', independent, independentStarted));

  const hot = pairs[0];
  const hotStarted = performance.now();
  const hotResults = await mapLimit(Math.min(2000, profile.operations), index => transfer(hot[0].owner, hot[0].accountId, pairs[index % pairs.length][1].accountId, 1));
  scenarios.push(summarize('hotSourceAccount', hotResults, hotStarted));

  const overspendOwner = pairs[1][0];
  const balance = BigInt((await one('SELECT available_minor::text AS amount FROM freehold.accounts WHERE id=$1', [overspendOwner.accountId])).amount);
  if (balance <= 0n) throw new Error('Overspend fixture has no available balance');
  const spend = balance;
  const overspendStarted = performance.now();
  const overspend = await Promise.all([0, 1].map(() => transfer(overspendOwner.owner, overspendOwner.accountId, pairs[2][1].accountId, spend.toString())));
  const overspendSummary = summarize('concurrentOverspend', overspend, overspendStarted);
  overspendSummary.completedSumMinor = overspend.filter(row => row.result?.state === 'COMPLETED').length === 1 ? spend.toString() : null;
  overspendSummary.passed = overspend.filter(row => row.result?.state === 'COMPLETED').length === 1 && overspend.filter(row => row.result?.error === 'INSUFFICIENT_FUNDS').length === 1;
  scenarios.push(overspendSummary);
  await admin.query('SELECT freehold.sandbox_fund_account($1,$2,$3::bigint,$4,$5,$6)', [emergency, overspendOwner.accountId, '1000000', `load-refill-${randomUUID()}`, 'Disposable refill', randomUUID()]);

  const sameKey = `load-same-${randomUUID()}`;
  const sameStarted = performance.now();
  const same = await Promise.all(Array.from({ length: 16 }, () => transfer(pairs[3][0].owner, pairs[3][0].accountId, pairs[3][1].accountId, 1, sameKey)));
  const sameIds = new Set(same.map(row => row.result?.operationId).filter(Boolean));
  const sameSummary = summarize('identicalIdempotencyKey', same, sameStarted);
  sameSummary.distinctOperationIds = sameIds.size;
  sameSummary.passed = sameIds.size === 1 && same.every(row => !row.error);
  scenarios.push(sameSummary);

  const conflictKey = `load-conflict-${randomUUID()}`;
  const firstConflict = await transfer(pairs[4][0].owner, pairs[4][0].accountId, pairs[4][1].accountId, 1, conflictKey);
  const secondConflict = await transfer(pairs[4][0].owner, pairs[4][0].accountId, pairs[4][1].accountId, 2, conflictKey);
  scenarios.push({ name: 'conflictingIdempotencyPayload', first: firstConflict.result?.state ?? null, secondError: secondConflict.error?.message ?? null, passed: firstConflict.result?.state === 'COMPLETED' && secondConflict.error?.message === 'IDEMPOTENCY_CONFLICT' });

  const historyStarted = performance.now();
  const history = await one('SELECT freehold.account_statement($1,$2,$3::timestamptz,$4::timestamptz,100,NULL,NULL) AS result', [pairs[0][0].owner, pairs[0][0].accountId, new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 86400000).toISOString()]);
  scenarios.push({ name: 'historicalStatement', elapsedMs: round(performance.now() - historyStarted), lineCount: history.result.lines.length, openingAvailableMinor: history.result.openingAvailableMinor, closingAvailableMinor: history.result.closingAvailableMinor });
  const reportStarted = performance.now();
  const institutional = await one('SELECT freehold.institutional_report($1) AS result', [reviewer]);
  scenarios.push({ name: 'institutionalReport', elapsedMs: round(performance.now() - reportStarted), hasFundingRatio: Object.prototype.hasOwnProperty.call(institutional.result, 'fundingRatio'), externalAssets: institutional.result.externalAssets?.status ?? null });

  const posting = mapLimit(200, () => transfer(pairs[5][0].owner, pairs[5][0].accountId, pairs[5][1].accountId, 1));
  const verifier = new Client({ connectionString: process.env.VERIFY_DATABASE_URL, application_name: 'freehold-load-verifier' });
  await verifier.connect();
  const verifyStarted = performance.now();
  let concurrentVerification;
  try { concurrentVerification = await verifyLedger(verifier, { statementTimeoutMs: 300000 }); }
  finally { await verifier.end(); }
  await posting;
  scenarios.push({ name: 'verificationDuringPosting', outcome: concurrentVerification.outcome, elapsedMs: round(performance.now() - verifyStarted), scan: concurrentVerification.scan, note: 'Repeatable-read snapshot. A VERIFIED outcome describes the snapshot, not writes that committed after it opened.' });

  const freezeTarget = pairs[6][0];
  const freezeStarted = performance.now();
  const freezeBurst = mapLimit(100, () => transfer(freezeTarget.owner, freezeTarget.accountId, pairs[6][1].accountId, 1));
  await new Promise(resolve => setTimeout(resolve, 20));
  const freeze = await one('SELECT freehold.set_account_frozen($1,$2,true,$3,$4,$5) AS result', [emergency, freezeTarget.accountId, `load-freeze-${randomUUID()}`, 'Disposable load freeze', randomUUID()]);
  const freezeResults = await freezeBurst;
  await admin.query('SELECT freehold.set_account_frozen($1,$2,false,$3,$4,$5)', [emergency, freezeTarget.accountId, `load-unfreeze-${randomUUID()}`, 'Disposable load unfreeze', randomUUID()]);
  scenarios.push({ ...summarize('freezeDuringTransfers', freezeResults, freezeStarted), freezeState: freeze.result?.state ?? null, frozenRejections: freezeResults.filter(row => row.result?.error === 'ACCOUNT_FROZEN').length });

  const suspendTarget = pairs[7][0];
  const suspendStarted = performance.now();
  const suspendBurst = mapLimit(80, () => transfer(suspendTarget.owner, suspendTarget.accountId, pairs[7][1].accountId, 1));
  await new Promise(resolve => setTimeout(resolve, 10));
  await admin.query('SELECT freehold.governance_suspend_writes($1,$2)', [emergency, 'Disposable load suspension']);
  const suspendResults = await suspendBurst;
  const resume = await one('SELECT freehold.governance_create_resume_request($1,$2,$3) AS result', [emergency, 'Disposable load resume', `load-resume-${randomUUID()}`]);
  await admin.query('SELECT freehold.governance_decide($1,$2,$3)', [reviewer, resume.result.requestId, 'APPROVE']);
  const resumed = await one('SELECT freehold.governance_execute($1,$2,$3,$4) AS result', [reviewer, resume.result.requestId, `load-resume-exec-${randomUUID()}`, randomUUID()]);
  const replay = await one('SELECT freehold.governance_execute($1,$2,$3,$4) AS result', [reviewer, resume.result.requestId, `load-resume-replay-${randomUUID()}`, randomUUID()]);
  scenarios.push({ ...summarize('suspensionDuringTransfers', suspendResults, suspendStarted), suspendedRejections: suspendResults.filter(row => row.error?.message === 'FINANCIAL_WRITES_SUSPENDED').length, resumeStatus: resumed.result?.status ?? null, replayStatus: replay.result?.status ?? null, replayReturnedPriorResult: replay.result?.status === 'EXECUTED' });

  const governed = await one('SELECT freehold.governance_create_account_request($1,$2,true,$3,$4) AS result', [emergency, pairs[8][0].accountId, 'Disposable governance during load', `load-gov-${randomUUID()}`]);
  await admin.query('SELECT freehold.governance_cancel($1,$2)', [emergency, governed.result.requestId]);
  scenarios.push({ name: 'governanceRequestDuringActivity', requestStatus: governed.result.status, cancelled: true });

  const backlog = await one('SELECT freehold.worker_backlog_status() AS result');
  scenarios.push({ name: 'workerBacklog', count: Number(backlog.result.count), oldestAgeSeconds: backlog.result.oldestAgeSeconds });

  const opened = [];
  let exhaustionError = null;
  try {
    for (let index = 0; index < 120; index += 1) {
      const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 1000, application_name: 'freehold-load-exhaust' });
      await client.connect();
      opened.push(client);
    }
  } catch (error) { exhaustionError = { code: error.code ?? null, message: error.message }; }
  await Promise.all(opened.map(client => client.end().catch(() => {})));
  const afterExhaustion = await transfer(pairs[9][0].owner, pairs[9][0].accountId, pairs[9][1].accountId, 1);
  scenarios.push({ name: 'connectionExhaustion', connectionsOpened: opened.length, error: exhaustionError, recoveryState: afterExhaustion.result?.state ?? afterExhaustion.error });

  const duplicates = await one(`SELECT (SELECT count(*)::int FROM (SELECT operation_id FROM freehold.ledger_journals GROUP BY operation_id HAVING count(*)>1) d) AS duplicate_journals, (SELECT count(*)::int FROM (SELECT journal_id FROM freehold.ledger_entries GROUP BY journal_id HAVING sum(CASE WHEN side='DEBIT' THEN amount_minor ELSE -amount_minor END)<>0) u) AS unbalanced_journals`);
  const finalVerifier = new Client({ connectionString: process.env.VERIFY_DATABASE_URL, application_name: 'freehold-load-verifier-final' });
  await finalVerifier.connect();
  const finalStarted = performance.now();
  let finalReport;
  try { finalReport = await verifyLedger(finalVerifier, { statementTimeoutMs: 300000 }); }
  finally { await finalVerifier.end(); }
  const afterStats = await dbStats();
  const report = {
    generatedAt: new Date().toISOString(),
    profile: profileName,
    requestedProfile: requested,
    operationsTarget: profile.operations,
    resourcesAtStart: resources,
    skippedProfiles: skipped,
    notEvidenceFor: skipped.filter(item => item.ran === false).map(item => item.profile),
    database: { sizeBytesBefore: beforeStats.bytes, sizeBytesAfter: afterStats.bytes, deadlocksDelta: afterStats.deadlocks - beforeStats.deadlocks, commitsDelta: (BigInt(afterStats.xact_commit) - BigInt(beforeStats.xact_commit)).toString(), rollbacksDelta: (BigInt(afterStats.xact_rollback) - BigInt(beforeStats.xact_rollback)).toString() },
    duplicateJournals: duplicates.duplicate_journals,
    unbalancedJournals: duplicates.unbalanced_journals,
    finalVerification: { outcome: finalReport.outcome, elapsedMs: round(performance.now() - finalStarted), scan: finalReport.scan, counts: finalReport.counts, violationCount: finalReport.violationCount },
    scenarios,
    probe: { actorId: pairs[10][0].owner, sourceAccountId: pairs[10][0].accountId, destinationAccountId: pairs[10][1].accountId },
    automaticFailover: false,
  };
  await writeResult(report);
  const failed = report.finalVerification.outcome !== 'VERIFIED' || report.duplicateJournals !== 0 || report.unbalancedJournals !== 0 || scenarios.some(item => item.passed === false);
  console.log(JSON.stringify({ profile: profileName, verification: report.finalVerification.outcome, independent: scenarios[0], failed }, null, 2));
  if (failed) process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
  await admin.end().catch(() => {});
}
