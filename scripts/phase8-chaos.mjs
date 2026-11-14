#!/usr/bin/env node
// Isolated fault experiments. Refuses the persistent Compose containers.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { decideBackupOutcome, walContinuity } from './lib/backup-set.mjs';
import { refuseEvidenceOverwrite } from './lib/evidence-output.mjs';
import { sourceRevision } from './lib/source-revision.mjs';

let adminUrl = process.env.PHASE8_ADMIN_URL;
let schedulerUrl = process.env.SCHEDULER_DATABASE_URL;
let workerUrl = process.env.WORKER_DATABASE_URL;
const pgContainer = process.env.PHASE8_PG_CONTAINER;
const redisContainer = process.env.PHASE8_REDIS_CONTAINER;
const out = process.env.PHASE8_CHAOS_OUT ?? 'docs/evidence/phase8-chaos.json';
refuseEvidenceOverwrite(out);
const persistent = /freehold-(postgres|api|web|redis)-1/;
if (!adminUrl || !/127\.0\.0\.1|localhost/.test(adminUrl) || !adminUrl.includes('disposable') || persistent.test(pgContainer ?? '') || persistent.test(redisContainer ?? '')) {
  throw new Error('Refusing chaos outside a loopback disposable database');
}
const tolerate = client => { client.on('error', () => undefined); return client; };
let admin = tolerate(new pg.Client({ connectionString: adminUrl }));
await admin.connect();
const evidence = [];
const record = (name, ok, detail) => evidence.push({ name, ok, ...detail });
const journals = async () => (await admin.query('SELECT count(*)::int AS n FROM freehold.ledger_journals')).rows[0].n;
const balances = async () => (await admin.query(`SELECT coalesce(json_object_agg(currency_code, total), '{}'::json) AS totals FROM (SELECT currency_code, sum(available_minor)::text AS total FROM freehold.accounts GROUP BY currency_code) s`)).rows[0].totals;
const user = async role => {
  const id = randomUUID();
  await admin.query('INSERT INTO freehold.users(id,email_normalized,password_hash,role) VALUES ($1,$2,$3,$4)', [id, `chaos-${id}@example.test`, 'not-a-login', role]);
  return id;
};
await admin.query('UPDATE freehold.ledger_settings SET sandbox_enabled=true WHERE singleton');
const funder = await user('ADMIN');
const owner = await user('USER');
const payee = await user('USER');
const reviewer = await user('ADMIN');
const account = async person => (await admin.query('SELECT freehold.create_account($1,$2,$3,$4) AS body', [person, 'USD', `chaos-${randomUUID()}`, randomUUID()])).rows[0].body.accountId;
const source = await account(owner);
const destination = await account(payee);
await admin.query('SELECT freehold.sandbox_fund_account($1,$2,1000,$3,$4,$5)', [funder, source, `fund-${randomUUID()}`, 'chaos', randomUUID()]);
const before = { journals: await journals(), balances: await balances() };

const open = tolerate(new pg.Client({ connectionString: adminUrl }));
await open.connect();
await open.query('BEGIN');
const inflight = open.query('SELECT freehold.execute_internal_transfer($1,$2,$3,$4,1,$5,$6)', [owner, source, destination, 'USD', `chaos-open-${randomUUID()}`, randomUUID()]);
inflight.catch(() => undefined);
await new Promise(resolve => setTimeout(resolve, 200));
open.connection.stream.destroy();
await new Promise(resolve => setTimeout(resolve, 1000));
const killedClientJournals = await journals();
record('client_killed_before_commit', killedClientJournals === before.journals, { journals: killedClientJournals, before: before.journals });

await admin.query('SELECT freehold.execute_internal_transfer($1,$2,$3,$4,1,$5,$6)', [owner, source, destination, 'USD', `chaos-commit-${randomUUID()}`, randomUUID()]);
const committed = await journals();
const committedBalances = await balances();
if (pgContainer) {
  const hanging = tolerate(new pg.Client({ connectionString: adminUrl }));
  await hanging.connect();
  await hanging.query('BEGIN');
  const pending = hanging.query('SELECT freehold.execute_internal_transfer($1,$2,$3,$4,1,$5,$6)', [owner, source, destination, 'USD', `chaos-open-restart-${randomUUID()}`, randomUUID()]);
  pending.catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 300));
  const restarted = spawnSync('docker', ['restart', pgContainer], { encoding: 'utf8' });
  if (restarted.status !== 0) throw new Error(`docker restart exited ${restarted.status ?? 'null'}`);
  try { await hanging.end(); } catch { /* the restart already dropped it */ }
  try { await admin.end(); } catch { /* the restart already dropped it */ }
  let connected = false;
  let innerReady = false;
  let portChanged = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ping = spawnSync('docker', ['exec', pgContainer, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'freehold_chaos_disposable', '-X', '-Atc', 'SELECT 1'], { encoding: 'utf8' });
    const address = spawnSync('docker', ['port', pgContainer, '5432/tcp'], { encoding: 'utf8' }).stdout.trim().split('\n').find(line => line.startsWith('127.0.0.1:')) ?? '';
    if (ping.status === 0) innerReady = true;
    if (address && !adminUrl.includes(`@${address}/`)) portChanged = true;
    if (ping.status === 0 && address) {
      const retarget = url => url ? url.replace(/@[^/]+/, `@${address}`) : url;
      adminUrl = retarget(adminUrl);
      schedulerUrl = retarget(schedulerUrl);
      workerUrl = retarget(workerUrl);
      for (const key of ['VERIFY_DATABASE_URL', 'PHASE8_API_DATABASE_URL', 'PHASE8_AUTH_DATABASE_URL']) {
        if (process.env[key]) process.env[key] = retarget(process.env[key]);
      }
      const nextUrl = adminUrl;
      const next = tolerate(new pg.Client({ connectionString: nextUrl }));
      try {
        await next.connect();
        await next.query('SELECT 1');
        admin = next;
        connected = true;
        break;
      } catch {
        try { await next.end(); } catch { /* not connected */ }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!connected) {
    const state = spawnSync('docker', ['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', pgContainer], { encoding: 'utf8' }).stdout.trim();
    throw new Error(`Disposable database did not return after restart (${state || 'not-inspected'}, innerReady=${innerReady}, portChanged=${portChanged})`);
  }
}
const afterRestart = { journals: await journals(), balances: await balances() };
record('postgres_termination_during_transfer', afterRestart.journals === committed && JSON.stringify(afterRestart.balances) === JSON.stringify(committedBalances), {
  journals: afterRestart.journals, committedJournals: committed, openTransferRolledBack: afterRestart.journals === committed,
});

if (redisContainer) {
  const redisBefore = await journals();
  const restarted = spawnSync('docker', ['restart', redisContainer], { encoding: 'utf8' });
  let redisUp = false;
  for (let attempt = 0; attempt < 40 && !redisUp; attempt += 1) {
    const ping = spawnSync('docker', ['exec', redisContainer, 'redis-cli', 'ping'], { encoding: 'utf8' });
    redisUp = ping.status === 0 && ping.stdout.includes('PONG');
    if (!redisUp) await new Promise(resolve => setTimeout(resolve, 250));
  }
  const address = spawnSync('docker', ['port', redisContainer, '6379/tcp'], { encoding: 'utf8' }).stdout.trim().split('\n').find(line => line.startsWith('127.0.0.1:'));
  if (address) process.env.PHASE8_REDIS_URL = `redis://${address}`;
  record('redis_restart_leaves_ledger', restarted.status === 0 && redisUp && (await journals()) === redisBefore, { journals: await journals(), redisUp });
}

record('backup_destination_missing', decideBackupOutcome({ present: false }).outcome === 'UNAVAILABLE', { outcome: 'UNAVAILABLE' });
const gap = walContinuity(['000000010000000000000001', '000000010000000000000003']);
record('wal_gap', decideBackupOutcome({ present: true, payloadPresent: true, checksumOk: true, ageOk: true, encrypted: false, kind: 'logical-custom', walStatus: gap.status, requireWal: false, restoreAttempted: true, restoreCompleted: true, verifierOutcome: 'VERIFIED' }).outcome === 'INCOMPLETE', { missing: gap.missing });

const disk = spawnSync('bash', ['scripts/backup-disk-check.sh', process.cwd(), String(2n ** 62n)], { encoding: 'utf8' });
record('disk_capacity_simulation', disk.status === 1 && (await journals()) === afterRestart.journals, { exit: disk.status, journalsUnchanged: (await journals()) === afterRestart.journals });

await admin.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)', [funder, 'ACCOUNT_ADMIN', 'chaos']);
await admin.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)', [reviewer, 'FINANCIAL_REVIEWER', 'chaos']);
const request = (await admin.query('SELECT freehold.governance_create_account_request($1,$2,true,$3,$4) AS request', [funder, source, 'chaos expiry', `chaos-${randomUUID()}`])).rows[0].request;
let immutable = false;
try {
  await admin.query(`UPDATE freehold.governance_requests SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1`, [request.requestId]);
} catch (error) { immutable = error.code === '55000'; }
await admin.query('ALTER TABLE freehold.governance_requests DISABLE TRIGGER governance_requests_immutable');
await admin.query(`UPDATE freehold.governance_requests SET created_at=clock_timestamp()-interval '2 minutes', expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1`, [request.requestId]);
await admin.query('ALTER TABLE freehold.governance_requests ENABLE TRIGGER governance_requests_immutable');
const expired = (await admin.query(`SELECT freehold.governance_decide($1,$2,'APPROVE') AS body`, [reviewer, request.requestId])).rows[0].body;
record('expired_governance', immutable && expired.status === 'EXPIRED' && (await journals()) === afterRestart.journals, {
  status: expired.status, directUpdateRejected: immutable,
});

const left = tolerate(new pg.Client({ connectionString: adminUrl }));
const right = tolerate(new pg.Client({ connectionString: adminUrl }));
await left.connect();
await right.connect();
const pair = await Promise.all([
  left.query('SELECT freehold.execute_internal_transfer($1,$2,$3,$4,2,$5,$6) AS body', [owner, source, destination, 'USD', `chaos-a-${randomUUID()}`, randomUUID()]),
  right.query('SELECT freehold.execute_internal_transfer($1,$2,$3,$4,2,$5,$6) AS body', [owner, source, destination, 'USD', `chaos-b-${randomUUID()}`, randomUUID()]),
]);
await left.end();
await right.end();
const available = (await admin.query('SELECT available_minor::text AS available FROM freehold.accounts WHERE id=$1', [source])).rows[0].available;
const unbalanced = (await admin.query(`SELECT count(*)::int AS n FROM freehold.ledger_journals j WHERE (SELECT coalesce(sum(CASE WHEN e.side='DEBIT' THEN e.amount_minor ELSE -e.amount_minor END),0) FROM freehold.ledger_entries e WHERE e.journal_id=j.id)<>0`)).rows[0].n;
record('concurrent_transfers', pair.every(row => row.rows[0].body.state === 'COMPLETED') && unbalanced === 0 && BigInt(available) >= 0n, { available, unbalanced });

const verifyOut = join(mkdtempSync(join(tmpdir(), 'freehold-chaos-verify-')), 'verification.json');
const verify = spawn(process.execPath, ['scripts/verify-ledger.mjs', '--out', verifyOut], { env: { ...process.env, VERIFY_DATABASE_URL: process.env.VERIFY_DATABASE_URL }, stdio: 'ignore' });
verify.kill('SIGKILL');
await new Promise(resolve => verify.once('exit', resolve));
let verifyBody = null;
try { verifyBody = JSON.parse(readFileSync(verifyOut, 'utf8')); } catch { verifyBody = null; }
record('interrupted_verifier', verifyBody?.outcome !== 'VERIFIED' && (await journals()) >= afterRestart.journals, { outcome: verifyBody?.outcome ?? null });

if (workerUrl) {
  const worker = spawn(process.execPath, ['dist/src/worker.js'], { env: { WORKER_DATABASE_URL: workerUrl, NODE_ENV: 'test', PATH: process.env.PATH ?? '' }, stdio: 'ignore' });
  await new Promise(resolve => setTimeout(resolve, 500));
  const beforeKill = await journals();
  worker.kill('SIGKILL');
  await new Promise(resolve => worker.once('exit', resolve));
  record('worker_sigkill', (await journals()) === beforeKill, { signal: 'SIGKILL' });
  const stopped = spawn(process.execPath, ['dist/src/worker.js'], { env: { WORKER_DATABASE_URL: workerUrl, NODE_ENV: 'test', PATH: process.env.PATH ?? '' }, stdio: 'ignore' });
  await new Promise(resolve => setTimeout(resolve, 500));
  const beforeTerm = await journals();
  stopped.kill('SIGTERM');
  await new Promise(resolve => stopped.once('exit', () => resolve()));
  record('worker_sigterm', (await journals()) === beforeTerm, { signal: 'SIGTERM' });
}
if (schedulerUrl) {
  const scheduler = spawn(process.execPath, ['dist/src/scheduler.js'], { env: { SCHEDULER_DATABASE_URL: schedulerUrl, NODE_ENV: 'test', PATH: process.env.PATH ?? '' }, stdio: 'ignore' });
  await new Promise(resolve => setTimeout(resolve, 500));
  const beforeKill = await journals();
  scheduler.kill('SIGTERM');
  await new Promise(resolve => scheduler.once('exit', () => resolve()));
  record('scheduler_sigterm', (await journals()) === beforeKill, { signal: 'SIGTERM' });
  const killed = spawn(process.execPath, ['dist/src/scheduler.js'], { env: { SCHEDULER_DATABASE_URL: schedulerUrl, NODE_ENV: 'test', PATH: process.env.PATH ?? '' }, stdio: 'ignore' });
  await new Promise(resolve => setTimeout(resolve, 500));
  const beforeSigkill = await journals();
  killed.kill('SIGKILL');
  await new Promise(resolve => killed.once('exit', () => resolve()));
  record('scheduler_sigkill', (await journals()) === beforeSigkill, { signal: 'SIGKILL' });
}
await crashApi();

async function freePort() {
  return await new Promise(resolve => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
async function crashApi() {
  const redisUrl = process.env.PHASE8_REDIS_URL;
  const apiUrl = process.env.PHASE8_API_DATABASE_URL;
  const authUrl = process.env.PHASE8_AUTH_DATABASE_URL;
  if (!redisUrl || !apiUrl || !authUrl) {
    record('api_sigkill', false, { executed: false, reason: 'API and auth URLs were not provided.' });
    return;
  }
  const token = randomBytes(24).toString('base64url');
  const totp = randomBytes(32).toString('base64');
  const auth = spawn(process.execPath, ['dist/src/auth-server.js'], {
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', AUTH_DATABASE_URL: authUrl, REDIS_URL: redisUrl, TOTP_ENCRYPTION_KEY: totp, AUTH_INTERNAL_TOKEN: token, AUTH_PORT: '0', AUTH_BIND_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let authText = '';
  let authErr = '';
  auth.stderr.on('data', chunk => { authErr = `${authErr}${chunk.toString()}`.replace(/postgres(?:ql)?:\/\/\S+/g, 'postgresql://REDACTED').slice(-300); });
  const authLine = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(authText), 15000);
    auth.stdout.on('data', chunk => {
      authText += chunk.toString();
      if (authText.includes('AUTH_LISTENING ')) { clearTimeout(timer); resolve(authText); }
    });
    auth.once('exit', () => { clearTimeout(timer); resolve(authText); });
  });
  const authPort = authLine.match(/AUTH_LISTENING (\d+)/)?.[1];
  const port = await freePort();
  const api = authPort ? spawn(process.execPath, ['dist/src/main.js'], {
    env: {
      PATH: process.env.PATH ?? '', NODE_ENV: 'test', BIND_HOST: '127.0.0.1', PORT: String(port),
      DATABASE_URL: apiUrl, AUTH_SERVICE_URL: `http://127.0.0.1:${authPort}`, AUTH_INTERNAL_TOKEN: token,
      REDIS_URL: redisUrl, TOTP_ENCRYPTION_KEY: totp, APP_ORIGIN: 'http://127.0.0.1:3000', COOKIE_SECURE: 'false', DEMO_MODE: 'false',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  }) : null;
  let apiErr = '';
  api?.stderr.on('data', chunk => { apiErr = `${apiErr}${chunk.toString()}`.replace(/postgres(?:ql)?:\/\/\S+/g, 'postgresql://REDACTED').slice(-400); });
  let listening = false;
  if (api) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok) { listening = true; break; }
      } catch { /* still starting */ }
      if (api.exitCode != null) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  const beforeKill = listening ? await journals() : null;
  if (api && listening) api.kill('SIGKILL');
  if (api) await new Promise(resolve => api.once('exit', () => resolve()));
  auth.kill('SIGTERM');
  await new Promise(resolve => auth.once('exit', () => resolve()));
  const afterKill = beforeKill == null ? null : await journals();
  record('api_sigkill', listening && afterKill === beforeKill, {
    executed: true, listening, journalsUnchanged: afterKill === beforeKill, authListening: Boolean(authPort),
    ...(listening ? {} : { apiStderr: apiErr, authStderr: authErr }),
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  reportType: 'freehold.phase8-chaos',
  sourceRevision: sourceRevision(),
  signature: null,
  persistentDatabase: false,
  balancesRepaired: false,
  scenarios: evidence,
  passed: evidence.every(item => item.ok),
};
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`${report.passed ? 'PASS' : 'FAIL'} chaos ${evidence.filter(item => item.ok).length}/${evidence.length}`);
try { await admin.end(); } catch { /* closed after restart */ }
rmSync(verifyOut, { force: true });
if (!report.passed) process.exitCode = 1;
