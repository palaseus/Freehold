#!/usr/bin/env node
// Disposable HTTP transfer load with real API, auth, PostgreSQL, and worker processes.
// Refuses any database that is not loopback and named disposable. At-least-once delivery.
// Does not claim exactly-once, off-site backup, or comparability with the Phase 5 SQL baseline.
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';
import { refuseEvidenceOverwrite } from './lib/evidence-output.mjs';
import { sourceRevision } from './lib/source-revision.mjs';

const origin = 'http://127.0.0.1:3000';
const ops = Number(process.env.PHASE6_HTTP_OPS ?? 1000);
const burst = Number(process.env.PHASE6_BURST_OPS ?? 400);
const dbName = process.env.PHASE6_DB ?? '';
const pgHost = process.env.PHASE6_PG_HOST ?? '';
const pgPort = process.env.PHASE6_PG_PORT ?? '';
if (!['127.0.0.1', 'localhost'].includes(pgHost) || !dbName.includes('disposable')) {
  throw new Error('Refusing a database that is not a loopback disposable worker bench');
}
const evidencePath = process.env.PHASE6_EVIDENCE_OUT ?? 'docs/evidence/worker-bench-latest.json';
refuseEvidenceOverwrite(evidencePath);
if (!Number.isInteger(ops) || ops < 1 || ops > 100000) throw new Error('PHASE6_HTTP_OPS must be an integer from 1 to 100000');
if (!Number.isInteger(burst) || burst < 1 || burst > 5000) throw new Error('PHASE6_BURST_OPS must be an integer from 1 to 5000');
if (freemem() < (1 << 30)) throw new Error(`Refusing to start with free memory ${freemem()}`);

const pgUrl = (user, password) => {
  const url = new URL(`postgresql://${pgHost}:${pgPort}/${dbName}`);
  url.username = user;
  url.password = password;
  return url.toString();
};
const adminUrl = pgUrl('postgres', process.env.PHASE6_PG_PASSWORD);
const workerUrl = pgUrl('freehold_worker', process.env.PHASE6_WORKER_PASSWORD);
const verifierUrl = pgUrl('freehold_verifier', process.env.PHASE6_VERIFIER_PASSWORD);
const apiUrl = pgUrl('freehold_api', process.env.PHASE6_API_PASSWORD);
const authUrl = pgUrl('freehold_auth', process.env.PHASE6_AUTH_PASSWORD);
const redisUrl = process.env.PHASE6_REDIS_URL;
const authToken = process.env.PHASE6_AUTH_TOKEN;
const totpKey = process.env.PHASE6_TOTP_KEY;
if (!redisUrl || !authToken || authToken.length < 32 || !totpKey) throw new Error('Redis, auth token, and TOTP key are required');

const redact = text => String(text ?? '').replace(/postgres(?:ql)?:\/\/\S+/g, 'postgresql://redacted').slice(0, 2000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = value => Math.round(value * 1000) / 1000;
const percentile = (samples, p) => {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);
};
const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG ?? 'C.UTF-8', TMPDIR: process.env.TMPDIR ?? '/tmp' };
const scratch = process.env.PHASE6_SCRATCH ?? `/tmp/freehold-worker-bench-${process.pid}`;
mkdirSync(scratch, { recursive: true });
const children = [];

function startNode(script, env, logName) {
  const logPath = `${scratch}/${logName}.log`;
  const fd = openSync(logPath, 'a');
  const child = spawn(process.execPath, [script], { env: { ...baseEnv, ...env }, stdio: ['ignore', fd, fd] });
  child.logPath = logPath;
  child.once('exit', () => { try { closeSync(fd); } catch { /* already closed */ } });
  children.push(child);
  return child;
}
function alive(child) { try { process.kill(child.pid, 0); return child.exitCode === null; } catch { return false; } }
function waitExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}
function tail(child) {
  try { return redact(readFileSync(child.logPath, 'utf8').slice(-2500)); } catch { return ''; }
}
function rssBytes(pid) {
  try {
    const line = readFileSync(`/proc/${pid}/status`, 'utf8').split('\n').find(row => row.startsWith('VmRSS:'));
    const kb = Number(line?.split(/\s+/)[1] ?? 0);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch { return 0; }
}
function cpuTicks(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return Number(rest[11]) + Number(rest[12]);
  } catch { return 0; }
}
async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
async function waitLog(child, pattern, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (readFileSync(child.logPath, 'utf8').includes(pattern)) return readFileSync(child.logPath, 'utf8');
    if (!alive(child)) throw new Error(`${pattern} process exited\n${tail(child)}`);
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${pattern}\n${tail(child)}`);
}

const admin = new Client({ connectionString: adminUrl, application_name: 'freehold-worker-bench-admin' });
await admin.connect();
const sampler = new Client({ connectionString: adminUrl, application_name: 'freehold-worker-bench-sampler' });
await sampler.connect();
const one = async (sql, args = []) => (await admin.query(sql, args)).rows[0];
const counts = async () => one(`SELECT
  (SELECT count(*)::int FROM freehold.ledger_journals) AS journals,
  (SELECT count(*)::int FROM freehold.outbox_events) AS events,
  (SELECT count(*)::int FROM freehold.outbox_events WHERE dispatched_at IS NOT NULL) AS acked,
  (SELECT count(*)::int FROM freehold.outbox_events WHERE dispatched_at IS NULL AND quarantined_at IS NULL) AS pending,
  (SELECT count(*)::int FROM freehold.worker_inbox WHERE attempt_count > 1) AS redelivered,
  (SELECT count(*)::int FROM (SELECT operation_id FROM freehold.ledger_journals GROUP BY operation_id HAVING count(*) > 1) d) AS duplicate_journals,
  (SELECT count(*)::int FROM (SELECT journal_id FROM freehold.ledger_entries GROUP BY journal_id HAVING sum(CASE WHEN side='DEBIT' THEN amount_minor ELSE -amount_minor END) <> 0) u) AS unbalanced`);
const backlog = async () => (await sampler.query('SELECT freehold.worker_backlog_status() AS status')).rows[0].status;

let api;
let auth;
let workers = [];
const samples = [];
let sampling = false;
let samplerTask = Promise.resolve();
const resources = { workerRssPeakBytes: 0, apiRssPeakBytes: 0, authRssPeakBytes: 0 };

async function sampleLoop() {
  while (sampling) {
    try {
      const status = await backlog();
      const workerRss = workers.reduce((sum, child) => sum + (alive(child) ? rssBytes(child.pid) : 0), 0);
      const apiRss = api && alive(api) ? rssBytes(api.pid) : 0;
      const authRss = auth && alive(auth) ? rssBytes(auth.pid) : 0;
      resources.workerRssPeakBytes = Math.max(resources.workerRssPeakBytes, workerRss);
      resources.apiRssPeakBytes = Math.max(resources.apiRssPeakBytes, apiRss);
      resources.authRssPeakBytes = Math.max(resources.authRssPeakBytes, authRss);
      samples.push({
        at: new Date().toISOString(),
        pending: Number(status.count ?? 0),
        oldestAgeSeconds: status.oldestAgeSeconds === null || status.oldestAgeSeconds === undefined ? null : Number(status.oldestAgeSeconds),
        quarantined: Number(status.quarantinedCount ?? 0),
        workerRssBytes: workerRss,
      });
    } catch { /* a restart window is recorded by the phase that caused it */ }
    await sleep(200);
  }
}

function startWorkers(count, extra) {
  const started = [];
  for (let index = 0; index < count; index += 1) {
    started.push(startNode('dist/src/worker.js', {
      WORKER_DATABASE_URL: workerUrl,
      WORKER_POLL_MS: '250',
      WORKER_RECONCILE_MS: '3600000',
      WORKER_ALERT_AGE_SECONDS: '300',
      WORKER_LEASE_SECONDS: extra.leaseSeconds ?? '30',
      WORKER_HOLD_LEASE_MS: extra.holdLeaseMs ?? '0',
    }, `worker-${Date.now()}-${index}`));
  }
  workers.push(...started);
  return started;
}
async function stopWorkers(signal) {
  const current = workers.splice(0);
  for (const child of current) if (alive(child)) process.kill(child.pid, signal);
  const codes = [];
  for (const child of current) codes.push(await waitExit(child, signal === 'SIGTERM' ? 25000 : 5000));
  return codes;
}
async function startAuth() {
  auth = startNode('dist/src/auth-server.js', {
    AUTH_DATABASE_URL: authUrl,
    AUTH_INTERNAL_TOKEN: authToken,
    AUTH_BIND_HOST: '127.0.0.1',
    AUTH_PORT: '0',
    REDIS_URL: redisUrl,
    TOTP_ENCRYPTION_KEY: totpKey,
  }, 'auth');
  const log = await waitLog(auth, 'AUTH_LISTENING ', 20000);
  const port = log.match(/AUTH_LISTENING (\d+)/)?.[1];
  if (!port) throw new Error('Auth did not publish a port');
  return `http://127.0.0.1:${port}`;
}
async function startApi() {
  const port = await freePort();
  api = startNode('dist/src/main.js', {
    NODE_ENV: 'test',
    BIND_HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_URL: apiUrl,
    AUTH_SERVICE_URL: authService,
    AUTH_INTERNAL_TOKEN: authToken,
    REDIS_URL: redisUrl,
    TOTP_ENCRYPTION_KEY: totpKey,
    APP_ORIGIN: origin,
    COOKIE_SECURE: 'false',
    DEMO_MODE: 'false',
  }, 'api');
  const ready = `${apiBase(port)}/openapi.json`;
  const started = Date.now();
  while (Date.now() - started < 30000) {
    if (!alive(api)) throw new Error(`API exited\n${tail(api)}`);
    try {
      const response = await fetch(ready, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return apiBase(port);
    } catch { /* not listening yet */ }
    await sleep(100);
  }
  throw new Error(`API did not become ready\n${tail(api)}`);
}
const apiBase = port => `http://127.0.0.1:${port}`;

let authService = '';
let apiBaseUrl = '';
const report = {
  generatedAt: new Date().toISOString(),
  reportType: 'freehold.phase6-worker-throughput',
  sourceRevision: 'unknown',
  signature: null,
  signatureCustody: 'REQUIRES_EXTERNAL_REVIEW',
  deliverySemantics: 'at-least-once',
  exactlyOnce: false,
  comparableToPhase5Medium: false,
  phase5MediumNote: 'Phase 5 medium measured 100000 direct SQL transfers at 108.882/s with no HTTP API and no worker. This run posts through HTTP while worker processes consume the outbox. The rates are not the same workload.',
  phase5MediumTransfersPerSecond: 108.882,
  workload: { httpTransfers: ops, burstWhileWorkersStopped: burst, httpConcurrency: 8, workerProcesses: 2 },
  funding: 'Customer accounts were funded with sandbox_fund_account. That credits a customer liability and debits sandbox equity. It does not create an external asset.',
  resourcesAtStart: { freeMemoryBytes: freemem(), totalMemoryBytes: totalmem(), cpus: availableParallelism(), loadAverage: loadavg() },
};
const failures = [];
const fail = message => { failures.push(message); };

try {
  authService = await startAuth();
  apiBaseUrl = await startApi();
  const password = `Bench-${randomBytes(18).toString('base64url')}`;
  const sessionOf = async email => {
    const registered = await fetch(`${apiBaseUrl}/v1/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email, password }),
    });
    if (registered.status !== 201) throw new Error(`register ${registered.status} ${redact(await registered.text())}`);
    const logged = await fetch(`${apiBaseUrl}/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email, password }),
    });
    const body = await logged.json();
    const cookie = logged.headers.getSetCookie?.().find(item => item.startsWith('freehold_session='))?.split(';')[0];
    if (!logged.ok || !cookie || !body.csrfToken) throw new Error(`login ${logged.status}`);
    return { cookie, csrf: body.csrfToken };
  };
  const customers = [];
  for (let index = 0; index < 8; index += 1) {
    const email = `bench-${index}-${randomUUID()}@example.com`;
    const session = await sessionOf(email);
    const created = await fetch(`${apiBaseUrl}/v1/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie: session.cookie, 'x-csrf-token': session.csrf, 'idempotency-key': randomUUID() },
      body: JSON.stringify({ currency: 'USD' }),
    });
    const account = await created.json();
    if (!created.ok || !account.accountId) throw new Error(`account create ${created.status} ${redact(JSON.stringify(account))}`);
    customers.push({ email, session, accountId: account.accountId });
  }
  const funder = randomUUID();
  await admin.query(`INSERT INTO freehold.users(id,email_normalized,password_hash,role) VALUES ($1,$2,'bench-unused','ADMIN')`, [funder, `bench-funder-${funder}@example.com`]);
  await admin.query('UPDATE freehold.ledger_settings SET sandbox_enabled=true WHERE singleton');
  const pairs = [];
  for (let index = 0; index < customers.length; index += 2) {
    const funded = await one('SELECT freehold.sandbox_fund_account($1,$2,100000000,$3,$4,$5) AS result', [funder, customers[index].accountId, `bench-fund-${randomUUID()}`, 'Disposable worker bench funding', randomUUID()]);
    if (funded.result?.state !== 'COMPLETED') throw new Error(`sandbox funding ${funded.result?.error ?? funded.result?.state}`);
    pairs.push({ source: customers[index], destination: customers[index + 1].accountId });
  }
  const postTransfer = async (pair, key = randomUUID()) => {
    const started = performance.now();
    try {
      const response = await fetch(`${apiBaseUrl}/v1/transfers`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', origin, cookie: pair.source.session.cookie,
          'x-csrf-token': pair.source.session.csrf, 'idempotency-key': key,
        },
        body: JSON.stringify({ sourceAccountId: pair.source.accountId, destinationAccountId: pair.destination, currency: 'USD', amountMinor: '1' }),
        signal: AbortSignal.timeout(20000),
      });
      const body = await response.json().catch(() => null);
      return { ms: performance.now() - started, status: response.status, body, error: null, key };
    } catch (error) {
      return { ms: performance.now() - started, status: 0, body: null, error: error.name ?? 'FETCH_FAILED', key };
    }
  };
  const runPosts = async (count, concurrency) => {
    const results = new Array(count);
    let cursor = 0;
    const run = async () => {
      while (cursor < count) {
        const index = cursor++;
        results[index] = await postTransfer(pairs[index % pairs.length]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, count) }, run));
    return results;
  };
  const summarize = (name, results, startedMs) => {
    const elapsedMs = performance.now() - startedMs;
    const completed = results.filter(row => row.body?.state === 'COMPLETED');
    const samplesMs = results.filter(row => row.status > 0).map(row => row.ms);
    return {
      name, attempts: results.length, completed: completed.length,
      httpErrors: results.filter(row => row.error).length,
      rejected: results.filter(row => row.body?.state === 'REJECTED').length,
      elapsedMs: round(elapsedMs),
      completedPerSecond: elapsedMs > 0 ? round(completed.length / (elapsedMs / 1000)) : 0,
      latencyMs: { p50: percentile(samplesMs, 50), p95: percentile(samplesMs, 95), p99: percentile(samplesMs, 99), max: samplesMs.length ? round(Math.max(...samplesMs)) : null },
      method: 'Client-observed HTTP latency, nearest-rank percentiles, including queueing behind the concurrency limit.',
    };
  };

  const pacedWorkers = startWorkers(2, { leaseSeconds: '30', holdLeaseMs: '0' });
  const heartbeats = Date.now();
  let seen = 0;
  while (Date.now() - heartbeats < 20000) {
    seen = (await one(`SELECT count(*)::int AS n FROM freehold.worker_heartbeats WHERE seen_at > clock_timestamp() - interval '15 seconds'`)).n;
    if (seen >= 2) break;
    if (pacedWorkers.some(child => !alive(child))) throw new Error(`Worker exited before heartbeat\n${pacedWorkers.map(tail).join('\n')}`);
    await sleep(200);
  }
  if (seen < 2) throw new Error('Workers did not record heartbeats');
  sampling = true;
  samplerTask = sampleLoop();
  const before = await counts();
  const pacedStarted = performance.now();
  const paced = await runPosts(ops, 8);
  const pacedSummary = summarize('httpTransfersWithWorkers', paced, pacedStarted);
  const afterPaced = await counts();
  const pacedEvents = afterPaced.events - before.events;
  report.transactionGeneration = pacedSummary;
  report.eventCreation = {
    created: pacedEvents,
    perSecond: pacedSummary.elapsedMs > 0 ? round(pacedEvents / (pacedSummary.elapsedMs / 1000)) : 0,
  };
  if (pacedSummary.completed !== ops) fail(`HTTP completed ${pacedSummary.completed} of ${ops}`);

  const pausedAt = await backlog();
  for (const child of pacedWorkers) if (alive(child)) process.kill(child.pid, 'SIGSTOP');
  const burstStarted = performance.now();
  const burstResults = await runPosts(burst, 8);
  const burstElapsed = performance.now() - burstStarted;
  const grew = await backlog();
  for (const child of pacedWorkers) if (alive(child)) process.kill(child.pid, 'SIGCONT');
  const drainStarted = performance.now();
  let drained = grew;
  while (performance.now() - drainStarted < 120000) {
    drained = await backlog();
    if (Number(drained.count) === 0) break;
    await sleep(200);
  }
  const drainMs = performance.now() - drainStarted;
  const afterDrain = await counts();
  const latency = await one(`SELECT
    count(*)::int AS acked,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY extract(epoch FROM (dispatched_at - created_at)) * 1000) AS p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (dispatched_at - created_at)) * 1000) AS p95,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM (dispatched_at - created_at)) * 1000) AS p99,
    max(extract(epoch FROM (dispatched_at - created_at)) * 1000) AS max
    FROM freehold.outbox_events WHERE dispatched_at IS NOT NULL`);
  report.burst = summarize('burstWhileWorkersStopped', burstResults, burstStarted);
  report.backlog = {
    maxPending: samples.reduce((max, row) => Math.max(max, row.pending), 0),
    pendingWhenStopped: Number(pausedAt.count ?? 0),
    pendingAfterBurst: Number(grew.count ?? 0),
    growthPerSecond: burstElapsed > 0 ? round((Number(grew.count ?? 0) - Number(pausedAt.count ?? 0)) / (burstElapsed / 1000)) : 0,
    oldestAgeSecondsMax: samples.reduce((max, row) => Math.max(max, row.oldestAgeSeconds ?? 0), 0),
    drainMs: round(drainMs),
    drainPerSecond: drainMs > 0 ? round(Number(grew.count ?? 0) / (drainMs / 1000)) : 0,
    pendingAfterDrain: Number(drained.count ?? 0),
    sampleCount: samples.length,
  };
  report.acknowledgment = {
    ackedDuringMeasuredDrain: afterDrain.acked - afterPaced.acked,
    endToEndLatencyMs: { p50: round(Number(latency.p50)), p95: round(Number(latency.p95)), p99: round(Number(latency.p99)), max: round(Number(latency.max)) },
    method: 'dispatched_at minus created_at for acknowledged outbox rows. This includes queue time, not only worker CPU.',
  };
  if (Number(drained.count) !== 0) fail(`Backlog did not drain: ${drained.count}`);
  if (burstResults.filter(row => row.body?.state === 'COMPLETED').length !== burst) fail('Burst did not complete every HTTP transfer');
  const redeliveredBeforeCrash = afterDrain.redelivered;
  const leaseRow = await one(`SELECT
    count(*)::int AS inbox_rows,
    count(*) FILTER (WHERE attempt_count > 1)::int AS attempt_above_one,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY extract(epoch FROM (processed_at - claimed_at)) * 1000) AS p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (processed_at - claimed_at)) * 1000) AS p95,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM (processed_at - claimed_at)) * 1000) AS p99,
    max(extract(epoch FROM (processed_at - claimed_at)) * 1000) AS max
    FROM freehold.worker_inbox`);
  const attemptHistogram = (await admin.query(`SELECT attempt_count::int AS attempt_count, count(*)::int AS rows FROM freehold.worker_inbox GROUP BY attempt_count ORDER BY attempt_count`)).rows;
  const leaseMs = value => value == null || Number.isNaN(Number(value)) ? null : round(Number(value));
  report.leaseProfile = {
    measuredBeforeCrashDrill: true,
    inboxRows: leaseRow.inbox_rows,
    attemptAboveOne: leaseRow.attempt_above_one,
    lastClaimProcessingMs: { p50: leaseMs(leaseRow.p50), p95: leaseMs(leaseRow.p95), p99: leaseMs(leaseRow.p99), max: leaseMs(leaseRow.max) },
    attemptHistogram,
    note: 'claimed_at is overwritten when a row is reclaimed, so lastClaimProcessingMs is the last claim only. attempt_count above 1 is a redelivery. It is not a second journal.',
  };

  const gracefulCodes = await stopWorkers('SIGTERM');
  report.gracefulShutdown = { signal: 'SIGTERM', exitCodes: gracefulCodes, allExited: gracefulCodes.every(code => code === 0) };
  if (!report.gracefulShutdown.allExited) fail(`Graceful worker exit codes ${gracefulCodes.join(',')}`);

  const crashPair = pairs[0];
  const crashPosts = await Promise.all(Array.from({ length: 10 }, () => postTransfer(crashPair)));
  const crashKeys = crashPosts.map(row => row.key);
  if (crashPosts.filter(row => row.body?.state === 'COMPLETED').length !== 10) fail('Crash batch did not complete before the worker was started');
  const crashWorkers = startWorkers(1, { leaseSeconds: '5', holdLeaseMs: '8000' });
  let held = 0;
  const holdStarted = Date.now();
  while (Date.now() - holdStarted < 20000) {
    held = (await one(`SELECT count(*)::int AS n FROM freehold.worker_inbox i JOIN freehold.idempotency_requests r ON r.operation_id = (SELECT operation_id FROM freehold.outbox_events e WHERE e.id=i.event_id) WHERE r.key = ANY($1::text[]) AND i.status='PROCESSING'`, [crashKeys])).n;
    if (held >= 10) break;
    await sleep(100);
  }
  const killedAt = performance.now();
  process.kill(crashWorkers[0].pid, 'SIGKILL');
  const crashExit = await waitExit(crashWorkers[0], 5000);
  workers = workers.filter(child => child !== crashWorkers[0]);
  const recovery = startWorkers(1, { leaseSeconds: '5', holdLeaseMs: '0' });
  let recovered = false;
  while (performance.now() - killedAt < 20000) {
    const done = await one(`SELECT count(*)::int AS n FROM freehold.outbox_events e JOIN freehold.idempotency_requests r ON r.operation_id=e.operation_id WHERE r.key = ANY($1::text[]) AND e.dispatched_at IS NOT NULL`, [crashKeys]);
    if (done.n === 10) { recovered = true; break; }
    await sleep(200);
  }
  const recoveryMs = performance.now() - killedAt;
  const crashRow = await one(`SELECT count(*)::int AS journals, count(*) FILTER (WHERE attempt_count > 1)::int AS redelivered
    FROM (
      SELECT j.operation_id, i.attempt_count
      FROM freehold.idempotency_requests r
      JOIN freehold.ledger_journals j ON j.operation_id=r.operation_id
      LEFT JOIN freehold.worker_inbox i ON i.event_id=(SELECT e.id FROM freehold.outbox_events e WHERE e.operation_id=r.operation_id)
      WHERE r.key = ANY($1::text[])
    ) s`, [crashKeys]);
  report.workerCrash = {
    killed: 1, signal: 'SIGKILL', exitCode: crashExit, leasesHeldBeforeKill: held,
    leaseSeconds: 5, recovered, recoveryMs: round(recoveryMs),
    journals: crashRow.journals, redelivered: crashRow.redelivered,
    note: 'The killed process had claimed the batch and had not acknowledged it. The replacement worker reclaimed after the lease expired. Redelivery is at-least-once. Journal count stays one per transfer.',
  };
  if (!recovered || crashRow.journals !== 10 || crashRow.redelivered < 10) fail(`Crash recovery journals ${crashRow.journals} redelivered ${crashRow.redelivered} held ${held}`);
  await stopWorkers('SIGTERM');
  if (recovery[0] && alive(recovery[0])) process.kill(recovery[0].pid, 'SIGKILL');

  const replay = await postTransfer(pairs[1]);
  const replayAgain = await postTransfer(pairs[1], replay.key);
  const replayJournals = await one('SELECT count(*)::int AS n FROM freehold.ledger_journals WHERE operation_id=$1', [replay.body?.operationId]);
  report.lostResponseReplay = {
    sameOperation: replay.body?.operationId && replay.body.operationId === replayAgain.body?.operationId,
    journals: replayJournals.n,
  };
  if (!report.lostResponseReplay.sameOperation || replayJournals.n !== 1) fail('Idempotent replay did not keep one journal');

  const interruptKeys = Array.from({ length: 16 }, () => randomUUID());
  const interrupted = interruptKeys.map(key => postTransfer(pairs[2], key));
  await sleep(20);
  process.kill(api.pid, 'SIGKILL');
  const interruptResults = await Promise.all(interrupted);
  await waitExit(api, 5000);
  apiBaseUrl = await startApi();
  const retried = [];
  for (const key of interruptKeys) retried.push(await postTransfer(pairs[2], key));
  const interruptRow = await one(`SELECT count(DISTINCT j.operation_id)::int AS operations, count(*)::int AS journals
    FROM freehold.ledger_journals j JOIN freehold.idempotency_requests r ON r.operation_id=j.operation_id
    WHERE r.key = ANY($1::text[])`, [interruptKeys]);
  report.apiInterruption = {
    signal: 'SIGKILL',
    firstAttemptErrors: interruptResults.filter(row => row.error || row.status === 0).length,
    retriesCompleted: retried.filter(row => row.body?.state === 'COMPLETED').length,
    distinctOperations: interruptRow.operations,
    journals: interruptRow.journals,
    note: 'The API process was killed while transfer requests were in flight. Retries used the same idempotency keys. PostgreSQL rolls back an uncommitted transfer; a committed transfer is returned again.',
  };
  if (interruptRow.journals !== 16 || interruptRow.operations !== 16 || report.apiInterruption.retriesCompleted !== 16) {
    fail(`API interruption journals ${interruptRow.journals} retries ${report.apiInterruption.retriesCompleted}`);
  }

  const poisonWorker = startWorkers(1, { leaseSeconds: '30', holdLeaseMs: '0' });
  await sleep(400);
  if (alive(poisonWorker[0])) process.kill(poisonWorker[0].pid, 'SIGSTOP');
  const poison = await postTransfer(pairs[3]);
  const poisonEvent = await one('SELECT id FROM freehold.outbox_events WHERE operation_id=$1 AND dispatched_at IS NULL', [poison.body?.operationId]);
  if (!poisonEvent?.id) fail('Poison transfer was acknowledged before the payload could be marked');
  else {
    await admin.query(`UPDATE freehold.outbox_events SET payload = payload || '{"poison":true}'::jsonb WHERE id=$1 AND dispatched_at IS NULL`, [poisonEvent.id]);
    process.kill(poisonWorker[0].pid, 'SIGCONT');
    let quarantined = false;
    const poisonStarted = Date.now();
    while (Date.now() - poisonStarted < 30000) {
      const row = await one(`SELECT e.quarantined_at IS NOT NULL AS quarantined, e.available_at > clock_timestamp() AS deferred, e.quarantine_reason AS reason
        FROM freehold.outbox_events e WHERE e.id=$1`, [poisonEvent.id]);
      if (row.quarantined) { quarantined = row.reason === 'POISON'; break; }
      if (row.deferred) {
        await admin.query('UPDATE freehold.outbox_events SET available_at=clock_timestamp() WHERE id=$1 AND quarantined_at IS NULL', [poisonEvent.id]);
        await admin.query(`UPDATE freehold.worker_inbox SET lease_until=clock_timestamp() - interval '1 second' WHERE event_id=$1 AND status='PROCESSING'`, [poisonEvent.id]);
      }
      await sleep(250);
    }
    const poisonJournals = await one('SELECT count(*)::int AS n FROM freehold.ledger_journals WHERE operation_id=$1', [poison.body.operationId]);
    if (quarantined) {
      // The poison flag is an operational annotation. The posted response stays the financial payload.
      await admin.query(`UPDATE freehold.outbox_events e SET payload = r.response_body
        FROM freehold.idempotency_requests r
        WHERE e.id = $1 AND r.operation_id = e.operation_id AND e.quarantined_at IS NOT NULL`, [poisonEvent.id]);
    }
    report.poison = {
      quarantined, journals: poisonJournals.n,
      payloadRestoredAfterQuarantine: quarantined,
      note: 'The worker quarantines a poison payload after 8 claims. This drill pulled available_at forward so the measurement did not wait out the full exponential delay. The delay formula in SQL is unchanged: least(3600, 2^attempt_count) seconds. Quarantine does not reverse the financial journal. After quarantine, the drill restored the outbox payload from the idempotency response so the poison annotation is not left as a financial-record mismatch.',
    };
    if (!quarantined || poisonJournals.n !== 1) fail('Poison event was not quarantined with exactly one journal');
  }
  sampling = false;
  await samplerTask;
  await stopWorkers('SIGKILL');

  const finalCounts = await counts();
  report.integrity = {
    journals: finalCounts.journals,
    events: finalCounts.events,
    acked: finalCounts.acked,
    pending: finalCounts.pending,
    redeliveredBeforeCrash,
    redelivered: finalCounts.redelivered,
    duplicateJournals: finalCounts.duplicate_journals,
    unbalancedJournals: finalCounts.unbalanced,
  };
  if (finalCounts.duplicate_journals !== 0 || finalCounts.unbalanced !== 0 || finalCounts.pending !== 0) {
    fail(`Integrity duplicate ${finalCounts.duplicate_journals} unbalanced ${finalCounts.unbalanced} pending ${finalCounts.pending}`);
  }
  report.leaseExpirations = {
    beforeCrash: redeliveredBeforeCrash,
    totalInboxRowsWithAttemptAboveOne: finalCounts.redelivered,
    note: 'attempt_count above 1 is a redelivery. It is not a second financial posting.',
  };
  if (process.env.PHASE7_COMBINED === '1' && failures.length === 0) {
    const schedulerPassword = process.env.PHASE6_SCHEDULER_PASSWORD;
    if (!schedulerPassword) throw new Error('PHASE6_SCHEDULER_PASSWORD is required for the combined workload');
    const schedulerUrl = pgUrl('freehold_scheduler', schedulerPassword);
    const scheduler = startNode('dist/src/scheduler.js', {
      SCHEDULER_DATABASE_URL: schedulerUrl,
      SCHEDULER_POLL_MS: '1000',
    }, 'scheduler');
    await waitLog(scheduler, 'scheduler_started', 20000);
    const source = pairs[0].source;
    const relogged = await fetch(`${apiBaseUrl}/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email: source.email, password }),
    });
    const relogBody = await relogged.json();
    const relogCookie = relogged.headers.getSetCookie?.().find(item => item.startsWith('freehold_session='))?.split(';')[0];
    if (!relogged.ok || !relogCookie || !relogBody.csrfToken) throw new Error(`combined login ${relogged.status}`);
    const nextExecutionAt = new Date(Date.now() + 45000).toISOString();
    const createdSchedule = await fetch(`${apiBaseUrl}/v1/scheduled-transfers`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', origin, cookie: relogCookie,
        'x-csrf-token': relogBody.csrfToken, 'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        sourceAccountId: source.accountId, destinationAccountId: pairs[0].destination,
        currency: 'USD', amountMinor: '1', cadence: 'ONCE', nextExecutionAt,
      }),
    });
    const scheduleBody = await createdSchedule.json().catch(() => null);
    if (!createdSchedule.ok || !scheduleBody?.instructionId) throw new Error(`schedule create ${createdSchedule.status} ${redact(JSON.stringify(scheduleBody))}`);
    const journalsBeforeSchedule = (await one('SELECT count(*)::int AS n FROM freehold.ledger_journals')).n;
    let execution = null;
    const scheduleWaitStarted = Date.now();
    while (Date.now() - scheduleWaitStarted < 90000) {
      execution = await one(`SELECT e.outcome, e.operation_id,
        (SELECT count(*)::int FROM freehold.ledger_journals j WHERE j.operation_id=e.operation_id) AS journals
        FROM freehold.scheduled_transfer_executions e WHERE e.instruction_id=$1`, [scheduleBody.instructionId]);
      if (execution) break;
      if (!alive(scheduler)) throw new Error(`Scheduler exited before execution\n${tail(scheduler)}`);
      await sleep(500);
    }
    const journalsAfterSchedule = (await one('SELECT count(*)::int AS n FROM freehold.ledger_journals')).n;
    if (!execution || execution.outcome !== 'COMPLETED' || execution.journals !== 1 || journalsAfterSchedule !== journalsBeforeSchedule + 1) {
      fail(`Combined schedule did not post exactly one journal (${execution?.outcome ?? 'NONE'}, journals ${journalsAfterSchedule - journalsBeforeSchedule})`);
    }
    const from = new Date(Date.now() - 2 * 86400000).toISOString();
    const to = new Date(Date.now() + 2 * 86400000).toISOString();
    const statementResponse = await fetch(`${apiBaseUrl}/v1/accounts/${source.accountId}/statement?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=20`, {
      headers: { cookie: relogCookie, origin },
    });
    const statement = await statementResponse.json().catch(() => null);
    const projected = await one('SELECT available_minor::text AS available FROM freehold.accounts WHERE id=$1', [source.accountId]);
    if (!statementResponse.ok || statement?.closingAvailableMinor !== projected.available) {
      fail(`Combined statement closing ${statement?.closingAvailableMinor ?? 'missing'} did not match projection ${projected.available}`);
    }
    const drainWorkers = startWorkers(2, { leaseSeconds: '30', holdLeaseMs: '0' });
    const drainStarted = Date.now();
    let pendingAfterSchedule = null;
    while (Date.now() - drainStarted < 30000) {
      pendingAfterSchedule = (await one(`SELECT count(*)::int AS n FROM freehold.outbox_events WHERE dispatched_at IS NULL AND quarantined_at IS NULL`)).n;
      if (pendingAfterSchedule === 0) break;
      if (drainWorkers.some(child => !alive(child))) break;
      await sleep(200);
    }
    await stopWorkers('SIGTERM');
    if (pendingAfterSchedule !== 0) fail(`Combined schedule backlog did not drain: ${pendingAfterSchedule}`);
    await admin.query(`SELECT freehold.governance_provision_capability($1,'INSTITUTION_ADMIN','phase7 combined bench',true)`, [funder]);
    const operatorSecret = randomBytes(32);
    const authVersion = (await one('SELECT auth_version FROM freehold.users WHERE id=$1', [funder])).auth_version;
    await admin.query('SELECT freehold.auth_bind_session($1::uuid,$2::bigint,$3::bytea,NULL,3600)', [funder, authVersion, operatorSecret]);
    const journalsBeforeMonitor = (await one('SELECT count(*)::int AS n FROM freehold.ledger_journals')).n;
    const apiDb = new Client({ connectionString: apiUrl, application_name: 'freehold-combined-api', statement_timeout: 30000 });
    await apiDb.connect();
    let monitor; let alerts; let institutional; let gl;
    try {
      await apiDb.query('BEGIN');
      await apiDb.query(`SELECT set_config('freehold.session_secret',$1,true)`, [operatorSecret.toString('hex')]);
      monitor = (await apiDb.query('SELECT freehold.monitor_evaluate($1::uuid) AS result', [funder])).rows[0].result;
      alerts = (await apiDb.query('SELECT freehold.alert_list($1::uuid,50) AS alerts', [funder])).rows[0].alerts;
      institutional = (await apiDb.query('SELECT freehold.institutional_report($1::uuid) AS report', [funder])).rows[0].report;
      gl = (await apiDb.query(`SELECT freehold.gl_report($1::uuid,'INCOME_STATEMENT','') AS report`, [funder])).rows[0].report;
      await apiDb.query('COMMIT');
    } catch (error) {
      try { await apiDb.query('ROLLBACK'); } catch { /* keep the original error */ }
      throw error;
    } finally { await apiDb.end().catch(() => {}); }
    const journalsAfterMonitor = (await one('SELECT count(*)::int AS n FROM freehold.ledger_journals')).n;
    const backup = Array.isArray(alerts) ? alerts.find(alert => alert.alertKey === 'backup-telemetry') : null;
    if (monitor?.financialRecordsChanged !== false || journalsAfterMonitor !== journalsBeforeMonitor) fail('Combined monitor changed financial records');
    if (backup?.details?.telemetry !== 'UNAVAILABLE') fail('Combined monitor did not keep backup telemetry unavailable');
    if (institutional?.externalAssets?.status !== 'UNAVAILABLE') fail('Combined institutional report invented external assets');
    if (gl?.filingStatus !== 'NOT_A_REGULATORY_FILING') fail('Combined general ledger report was not marked as a non-filing');
    const after = await counts();
    if (after.duplicate_journals !== 0 || after.unbalanced !== 0) fail(`Combined integrity duplicate ${after.duplicate_journals} unbalanced ${after.unbalanced}`);
    if (alive(scheduler)) process.kill(scheduler.pid, 'SIGTERM');
    const schedulerExit = await waitExit(scheduler, 25000);
    report.combined = {
      httpTransfers: ops,
      workerProcessesDuringTransfer: 2,
      schedulerProcess: true,
      schedulerPollMs: 1000,
      schedulerExit,
      schedule: {
        instructionId: scheduleBody.instructionId,
        outcome: execution?.outcome ?? null,
        journals: execution?.journals ?? null,
        journalDelta: journalsAfterSchedule - journalsBeforeSchedule,
        waitMs: Date.now() - scheduleWaitStarted,
      },
      statement: {
        httpStatus: statementResponse.status,
        closingAvailableMinor: statement?.closingAvailableMinor ?? null,
        matchesProjection: statement?.closingAvailableMinor === projected.available,
      },
      monitor: {
        financialRecordsChanged: monitor?.financialRecordsChanged ?? null,
        backupTelemetry: backup?.details?.telemetry ?? null,
        journalDelta: journalsAfterMonitor - journalsBeforeMonitor,
        openAlerts: monitor?.openAlerts ?? null,
      },
      institutionalReport: { externalAssets: institutional?.externalAssets?.status ?? null },
      generalLedger: { kind: gl?.kind ?? null, filingStatus: gl?.filingStatus ?? null },
      drain: { pendingAfterSchedule, workerExit: 'SIGTERM' },
      integrity: { duplicateJournals: after.duplicate_journals, unbalancedJournals: after.unbalanced, pending: after.pending },
    };
  }
} catch (error) {
  sampling = false;
  fail(redact(error.stack || error.message));
} finally {
  sampling = false;
  await samplerTask;
  for (const child of children) if (alive(child)) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ } }
  await admin.end().catch(() => {});
  await sampler.end().catch(() => {});
}

// The spawn above cannot receive arguments after start. Run verification as its own step
// only when the financial checks did not already abort the database connection.
let verification = { outcome: 'NOT_RUN', reason: failures.length ? 'Skipped because an earlier check failed' : null };
if (failures.length === 0) {
  const verifyOut = `${scratch}/verify.json`;
  const started = performance.now();
  const verify = spawn(process.execPath, ['scripts/verify-ledger.mjs', '--out', verifyOut], {
    env: { ...baseEnv, VERIFY_DATABASE_URL: verifierUrl, VERIFY_STATEMENT_TIMEOUT_MS: '120000' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let verifyRss = rssBytes(verify.pid);
  const rssTimer = setInterval(() => { verifyRss = Math.max(verifyRss, rssBytes(verify.pid)); }, 30);
  const exitCode = await new Promise(resolve => verify.once('exit', resolve));
  clearInterval(rssTimer);
  try {
    const body = JSON.parse(readFileSync(verifyOut, 'utf8'));
    verification = {
      outcome: body.outcome,
      algorithmVersion: body.algorithmVersion,
      elapsedMs: round(performance.now() - started),
      journals: body.counts?.journals ?? null,
      journalEntries: body.counts?.journalEntries ?? null,
      violationCount: body.violationCount ?? null,
      rssBytesPeak: body.resources?.rssBytesPeak ?? null,
      heapUsedPeak: body.resources?.heapUsedPeak ?? null,
      processRssPeakBytes: verifyRss,
      scan: body.scan ?? null,
      exitCode,
      violationCodes: [...new Set(['operationalEventViolations', 'accountingViolations', 'projectionDiscrepancies', 'referentialIntegrityViolations', 'idempotencyInconsistencies', 'governanceViolations']
        .flatMap(key => (body[key] ?? []).map(row => row.code).filter(Boolean)))].slice(0, 20),
    };
    if (body.outcome !== 'VERIFIED') fail(`Verifier outcome ${body.outcome}${verification.violationCodes.length ? `: ${verification.violationCodes.join(',')}` : ''}`);
  } catch (error) {
    verification = { outcome: 'ERROR', elapsedMs: round(performance.now() - started), exitCode, message: redact(error.message) };
    fail('Verifier output was not readable');
  }
}

let deadlockCount = 0;
let deadlockLogs = 0;
let ackNotOwned = 0;
let batchesClaimed = 0;
for (const name of readdirSync(scratch)) {
  if (!name.endsWith('.log')) continue;
  deadlockLogs += 1;
  const text = readFileSync(`${scratch}/${name}`, 'utf8');
  deadlockCount += text.match(/"error_code":"40P01"/g)?.length ?? 0;
  ackNotOwned += text.match(/"event":"outbox_ack_not_owned"/g)?.length ?? 0;
  batchesClaimed += text.match(/"event":"outbox_batch_claimed"/g)?.length ?? 0;
}
report.deadlocks = { code: '40P01', count: deadlockCount, logFiles: deadlockLogs, isolationUnchanged: true };
report.workerLogs = {
  outboxAckNotOwned: ackNotOwned,
  outboxBatchClaimed: batchesClaimed,
  logFiles: deadlockLogs,
  note: 'Counts include the crash and poison drills. They are not limited to the paced 100000-transfer window.',
};
report.sourceRevision = sourceRevision();
report.verification = verification;
report.completedAt = new Date().toISOString();
report.resources = { ...report.resourcesAtStart, ...resources, note: 'RSS peaks are summed VmRSS of the live worker processes, and the API and auth processes, sampled about every 200ms.' };
report.failures = failures;
report.ok = failures.length === 0;
const hashBody = { ...report };
delete hashBody.contentSha256;
report.contentSha256 = createHash('sha256').update(JSON.stringify(hashBody)).digest('hex');
report.contentHashCovers = 'every field except contentSha256, using JSON.stringify key order';
mkdirSync('docs/evidence', { recursive: true });
writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
if (!report.ok) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}
const gen = report.transactionGeneration;
const lag = report.acknowledgment?.endToEndLatencyMs;
process.stdout.write(`PASS worker bench HTTP ${gen.completed}/${gen.attempts} in ${gen.elapsedMs} ms ${gen.completedPerSecond}/s p95 ${gen.latencyMs.p95} p99 ${gen.latencyMs.p99} drain ${report.backlog.drainMs} ms verifier ${report.verification.outcome} rss ${report.verification.rssBytesPeak}\n`);
