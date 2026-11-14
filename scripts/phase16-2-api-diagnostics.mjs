#!/usr/bin/env node
// Phase 16.2 API diagnostics: prove the live API accepts repeated and concurrent
// requests without connection resets, that error paths serialize cleanly, and
// that each runtime process holds only its own PostgreSQL role.
import { readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { Client } from 'pg';

const API = (process.env.PHASE162_API_URL ?? 'http://127.0.0.1:34100').replace(/\/$/, '');
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;
const AUTH_URL = process.env.AUTH_DATABASE_URL;
const LOG_DIR = process.env.PHASE162_LOG_DIR ?? '/tmp/opencode/freehold-p162/logs';
const OUT = process.env.PHASE162_API_DIAGNOSTICS_OUT ?? 'docs/evidence/phase16-2/api-diagnostics.json';
if (!ADMIN_URL) throw new Error('TEST_DATABASE_ADMIN_URL is required');

const evidence = {
  reportType: 'freehold.phase16.2.api-diagnostics',
  generatedAt: new Date().toISOString(),
  gitRevision: process.env.PHASE162_GIT_REVISION ?? null,
  apiBaseUrl: API,
  methodology: 'Real HTTP probes, concurrent readiness probes, sanitized error-path probes, runtime log inspection, and pg_stat_activity role inspection. No connection string or credential is written.',
  probes: {},
  errorPaths: [],
  runtimeProcesses: {},
  databaseSessions: null,
  connectionResets: null,
  checks: [],
  outcome: 'FAIL',
};

const check = (name, pass, detail) => {
  evidence.checks.push({ name, status: pass ? 'PASS' : 'FAIL', ...(detail === undefined ? {} : { detail }) });
  if (!pass) throw new Error(`${name}: ${JSON.stringify(detail)}`);
};

async function timedFetch(path, options = {}) {
  const started = Date.now();
  const response = await fetch(`${API}${path}`, { ...options, signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { nonJsonBody: text.slice(0, 200) }; }
  return {
    status: response.status,
    body,
    durationMs: Date.now() - started,
    contentType: response.headers.get('content-type'),
    connection: response.headers.get('connection'),
    cacheControl: response.headers.get('cache-control'),
    requestId: response.headers.get('x-request-id'),
    requestHeaders: options.headers ? Object.keys(options.headers).sort() : [],
  };
}

async function logText(name) {
  try { return await readFile(`${LOG_DIR}/${name}.log`, 'utf8'); } catch { return ''; }
}

try {
  const sequential = [];
  for (let index = 0; index < 30; index += 1) {
    sequential.push({ index, path: '/health', ...(await timedFetch('/health')) });
    sequential.push({ index, path: '/ready', ...(await timedFetch('/ready')) });
  }
  const concurrent = await Promise.all(Array.from({ length: 12 }, async (_, index) => ({
    index, ...(await timedFetch('/ready')),
  })));
  evidence.probes = {
    sequential: {
      requests: sequential.length,
      statuses: Object.fromEntries([...new Set(sequential.map(item => `${item.path} ${item.status}`))].map(key => [key, sequential.filter(item => `${item.path} ${item.status}` === key).length])),
      maxDurationMs: Math.max(...sequential.map(item => item.durationMs)),
      minDurationMs: Math.min(...sequential.map(item => item.durationMs)),
    },
    concurrent: {
      requests: concurrent.length,
      statuses: Object.fromEntries([...new Set(concurrent.map(item => item.status))].map(status => [status, concurrent.filter(item => item.status === status).length])),
      maxDurationMs: Math.max(...concurrent.map(item => item.durationMs)),
      minDurationMs: Math.min(...concurrent.map(item => item.durationMs)),
    },
    health: sequential.filter(item => item.path === '/health').at(-1),
    ready: sequential.filter(item => item.path === '/ready').at(-1),
  };
  check('60 sequential health/readiness probes succeeded', sequential.every(item => item.status === 200),
    evidence.probes.sequential);
  check('12 concurrent readiness probes succeeded', concurrent.every(item => item.status === 200), evidence.probes.concurrent);
  check('health payload is live', evidence.probes.health.body?.status === 'live', evidence.probes.health.body);
  check('readiness payload is accepting', evidence.probes.ready.body?.status === 'accepting', evidence.probes.ready.body);
  check('readiness responses are non-cacheable', evidence.probes.ready.cacheControl === 'no-store', evidence.probes.ready);

  const invalidJson = await fetch(`${API}/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{', signal: AbortSignal.timeout(10000),
  }).then(async response => ({ status: response.status, body: await response.text() })).catch(error => ({ status: 'FETCH_FAILED', body: error instanceof Error ? error.message : 'unknown' }));
  const missingRoute = await timedFetch('/v1/does-not-exist');
  const invalidBody = await timedFetch('/v1/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'not-an-email', password: 'x' }),
  });
  evidence.errorPaths = [
    { name: 'malformed JSON', status: invalidJson.status, body: invalidJson.body.slice(0, 120) },
    { name: 'missing route', status: missingRoute.status, body: missingRoute.body },
    { name: 'invalid login body', status: invalidBody.status, body: invalidBody.body },
  ];
  check('malformed JSON receives a serialized 400', invalidJson.status === 400, invalidJson);
  check('missing route receives a serialized 404', missingRoute.status === 404, missingRoute);
  check('invalid login body receives a serialized 400', invalidBody.status === 400, invalidBody);

  let authClient = null;
  if (AUTH_URL) {
    authClient = new Client({ connectionString: AUTH_URL, application_name: 'freehold-phase16.2-auth-identity-probe' });
    await authClient.connect();
    const identity = await authClient.query(
      `SELECT current_user, session_user,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls,
              has_function_privilege(current_user, 'freehold.auth_find_credentials(text)', 'EXECUTE') AS can_find_credentials,
              has_table_privilege(current_user, 'freehold.users', 'SELECT') AS can_read_users`);
    evidence.authRuntimeIdentity = identity.rows[0];
    check('auth diagnostic session uses freehold_auth', identity.rows[0].current_user === 'freehold_auth', identity.rows[0]);
    check('auth role cannot read users directly', identity.rows[0].can_read_users === false, identity.rows[0]);
  }

  const admin = new Client({ connectionString: ADMIN_URL, application_name: 'freehold-phase16.2-api-diagnostics' });
  await admin.connect();
  try {
    const sessions = await admin.query(
      `SELECT usename AS role, application_name, state, count(*)::int AS connections
         FROM pg_stat_activity
        WHERE datname = current_database() AND usename LIKE 'freehold_%'
        GROUP BY usename, application_name, state
        ORDER BY usename, application_name, state`);
    const roleSessions = await admin.query(
      `SELECT usename AS role, count(*)::int AS connections
         FROM pg_stat_activity
        WHERE datname = current_database() AND usename LIKE 'freehold_%'
        GROUP BY usename ORDER BY usename`);
    const db = await admin.query(
      `SELECT current_database() AS database, current_setting('server_version') AS server_version`);
    evidence.databaseSessions = {
      database: db.rows[0].database,
      serverVersion: db.rows[0].server_version,
      sessions: sessions.rows,
      roleTotals: Object.fromEntries(roleSessions.rows.map(row => [row.role, row.connections])),
    };
  } finally {
    await admin.end().catch(() => undefined);
    if (authClient) await authClient.end().catch(() => undefined);
  }
  check('API role has a live PostgreSQL session', (evidence.databaseSessions.roleTotals.freehold_api ?? 0) >= 1,
    evidence.databaseSessions.roleTotals);
  check('worker role has a live PostgreSQL session', (evidence.databaseSessions.roleTotals.freehold_worker ?? 0) >= 1,
    evidence.databaseSessions.roleTotals);
  check('scheduler role has a live PostgreSQL session', (evidence.databaseSessions.roleTotals.freehold_scheduler ?? 0) >= 1,
    evidence.databaseSessions.roleTotals);
  check('auth role has a live PostgreSQL session', (evidence.databaseSessions.roleTotals.freehold_auth ?? 0) >= 1,
    evidence.databaseSessions.roleTotals);
  check('no freehold_app login session exists', (evidence.databaseSessions.roleTotals.freehold_app ?? 0) === 0,
    evidence.databaseSessions.roleTotals);

  const apiLog = await logText('api');
  const authLog = await logText('auth');
  const workerLog = await logText('worker');
  const schedulerLog = await logText('scheduler');
  const resetPattern = /ECONNRESET|connection reset by peer|socket hang up|EPIPE/gi;
  const resetMatches = [apiLog, authLog, workerLog, schedulerLog].flatMap((text, index) => {
    const service = ['api', 'auth', 'worker', 'scheduler'][index];
    return [...text.matchAll(resetPattern)].map(match => ({ service, event: match[0] }));
  });
  evidence.connectionResets = {
    total: resetMatches.length,
    matches: resetMatches.slice(0, 20),
    logLineCounts: { api: apiLog.split('\n').length - 1, auth: authLog.split('\n').length - 1, worker: workerLog.split('\n').length - 1, scheduler: schedulerLog.split('\n').length - 1 },
  };
  check('no connection reset or broken pipe events in runtime logs', resetMatches.length === 0, evidence.connectionResets);
  check('API logged request completions', /"event":"http_request"/.test(apiLog), { apiLogBytes: apiLog.length });
  check('auth process reported listening', /AUTH_LISTENING \d+/.test(authLog), { authLogBytes: authLog.length, listening: /AUTH_LISTENING \d+/.exec(authLog)?.[0] ?? null });
  check('worker process reported started', /"event":"worker_started"/.test(workerLog), { workerLogBytes: workerLog.length });
  check('scheduler process reported started', /"event":"scheduler_started"/.test(schedulerLog), { schedulerLogBytes: schedulerLog.length });
  evidence.runtimeProcesses = {
    api: { started: /"event":"http_request"/.test(apiLog), logBytes: apiLog.length },
    auth: { started: /AUTH_LISTENING \d+/.test(authLog), logBytes: authLog.length },
    worker: { started: /"event":"worker_started"/.test(workerLog), logBytes: workerLog.length },
    scheduler: { started: /"event":"scheduler_started"/.test(schedulerLog), logBytes: schedulerLog.length },
  };

  evidence.outcome = evidence.checks.every(item => item.status === 'PASS') ? 'PASS' : 'FAIL';
} catch (error) {
  evidence.error = error instanceof Error ? error.message : 'unknown';
  evidence.outcome = 'FAIL';
  process.exitCode = 1;
} finally {
  await writeFile(OUT, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 }).catch(writeError => {
    process.stderr.write(`Failed to write API diagnostics: ${writeError instanceof Error ? writeError.message : 'unknown'}\n`);
    process.exitCode = 1;
  });
}
if (evidence.outcome === 'PASS') process.stdout.write('Phase 16.2 API diagnostics: PASS\n');
else process.stderr.write(`Phase 16.2 API diagnostics: ${evidence.outcome} ${evidence.error ?? ''}\n`);
