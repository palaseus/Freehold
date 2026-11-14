#!/usr/bin/env node
// Phase 16.2 live HTTP financial and tenant-authorization evidence.
//
// This script intentionally uses the public HTTP surface only for financial
// operations. The administrator PostgreSQL connection is used solely to read
// back committed journals, entries, projections, and customer-ledger counts so
// the evidence can compare HTTP results with durable state. Secrets, cookies,
// CSRF tokens, passwords, and connection strings are never written to output.
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Secret, TOTP } from 'otpauth';
import { Client } from 'pg';

const API = (process.env.PHASE162_API_URL ?? 'http://127.0.0.1:34100').replace(/\/$/, '');
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;
const BOOTSTRAP_TOKEN = process.env.DEMO_BOOTSTRAP_TOKEN;
const OUT_DIR = process.env.PHASE162_EVIDENCE_DIR ?? 'docs/evidence/phase16-2';
if (!ADMIN_URL) throw new Error('TEST_DATABASE_ADMIN_URL is required for read-back verification');
if (!BOOTSTRAP_TOKEN || BOOTSTRAP_TOKEN.length < 32) throw new Error('DEMO_BOOTSTRAP_TOKEN is required');

const runId = randomUUID().slice(0, 8);
const password = randomBytes(18).toString('base64url');
const adminSecret = Secret.fromHex(randomBytes(20).toString('hex'));
const adminTotp = new TOTP({ secret: adminSecret });
const adminEmail = `p162-admin-${runId}@example.test`;
const tenantAEmail = `p162-tenant-a-${runId}@example.test`;
const tenantBEmail = `p162-tenant-b-${runId}@example.test`;
const developerEmail = `p162-developer-${runId}@example.test`;

const db = new Client({ connectionString: ADMIN_URL, application_name: 'freehold-phase16.2-http-evidence' });
const evidence = {
  reportType: 'freehold.phase16.2.http-financial-tests',
  generatedAt: new Date().toISOString(),
  gitRevision: process.env.PHASE162_GIT_REVISION ?? null,
  apiBaseUrl: API,
  methodology: 'Real fetch() requests against a live API process. Financial outcomes are read back from PostgreSQL after every scenario. The API process runs as freehold_api; this verifier connection uses the disposable cluster administrator only for read-back.',
  identities: {
    platformAdmin: { email: adminEmail, role: 'ADMIN', totp: true },
    tenantAAdmin: { email: tenantAEmail, role: 'USER' },
    tenantBAdmin: { email: tenantBEmail, role: 'USER' },
    tenantADeveloper: { email: developerEmail, role: 'USER' },
  },
  scenarios: [],
  databaseSnapshots: [],
  assertions: [],
  summary: { scenarios: 0, passed: 0, failed: 0, outcome: 'FAIL' },
};
const impersonation = {
  reportType: 'freehold.phase16.2.tenant-impersonation',
  generatedAt: new Date().toISOString(),
  gitRevision: process.env.PHASE162_GIT_REVISION ?? null,
  apiBaseUrl: API,
  methodology: 'Tenant A session and tenant A sandbox credential attempt to act on tenant B institution, customer, account, and credential resources over real HTTP.',
  attempts: [],
  outcome: 'FAIL',
};

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/secret|password|csrf|cookie|authorization|token|^totp$/i.test(key)) out[key] = '[redacted]';
      else out[key] = scrub(item);
    }
    return out;
  }
  if (typeof value === 'string' && /^(fh_sandbox_|Bearer )/.test(value)) return '[redacted]';
  return value;
}

function cookieFrom(response) {
  const lines = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const session = lines.map(line => line.split(';')[0]).find(line => line.startsWith('freehold_session='));
  if (!session) throw new Error('Login response did not set a freehold_session cookie');
  return session;
}

async function request(method, path, options = {}) {
  const headers = { accept: 'application/json', ...(options.headers ?? {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.bootstrap) headers.authorization = `Bearer ${BOOTSTRAP_TOKEN}`;
  if (options.session) {
    headers.cookie = options.session.cookie;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['x-csrf-token'] = options.session.csrf;
  }
  if (options.credential) {
    headers.authorization = options.credential.authorization;
    headers['x-institution-nonce'] = options.nonce;
    if (options.institutionHeader) headers['x-institution-id'] = options.institutionHeader;
  }
  if (options.correlationId) headers['x-correlation-id'] = options.correlationId;
  const started = Date.now();
  let response;
  let text;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(20000),
    });
    text = await response.text();
  } catch (error) {
    throw new Error(`HTTP ${method} ${path} failed before a response: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { nonJsonBody: text.slice(0, 200) }; }
  return { status: response.status, payload, headers: response.headers, durationMs: Date.now() - started, requestId: response.headers.get('x-request-id') };
}

async function login(email, extra = {}) {
  const response = await request('POST', '/v1/auth/login', { body: { email, password, ...extra } });
  if (response.status !== 200 || typeof response.payload?.csrfToken !== 'string') {
    throw new Error(`Login for ${email} failed with HTTP ${response.status}`);
  }
  return { email, cookie: cookieFrom(response), csrf: response.payload.csrfToken };
}

function scenario(name, title) {
  const record = { name, title, startedAt: new Date().toISOString(), status: 'FAIL', steps: [], assertions: [] };
  evidence.scenarios.push(record);
  return record;
}

function assert(record, name, condition, detail) {
  if (!condition) {
    const error = new Error(`${name}: ${JSON.stringify(detail)}`);
    error.assertion = { name, detail };
    record.assertions.push({ name, status: 'FAIL', detail });
    throw error;
  }
  record.assertions.push({ name, status: 'PASS' });
  evidence.assertions.push({ name, status: 'PASS' });
}

async function http(record, name, method, path, options = {}, expectedStatuses = [200]) {
  const response = await request(method, path, options);
  const step = {
    name,
    request: { method, path, body: scrub(options.body ?? null) },
    response: { status: response.status, code: response.payload?.code ?? null, body: scrub(response.payload), requestId: response.requestId },
    durationMs: response.durationMs,
    status: expectedStatuses.includes(response.status) ? 'PASS' : 'FAIL',
  };
  record.steps.push(step);
  if (!expectedStatuses.includes(response.status)) {
    const error = new Error(`${name}: expected HTTP ${expectedStatuses.join('/')} but received ${response.status} ${response.payload?.code ?? ''}`);
    error.assertion = { name, detail: step };
    throw error;
  }
  return response;
}

const tracked = {};
let institutionA;
let institutionB;
let customerA1;
let customerA2;
let customerB1;
let credentialA;
let credentialB;
let developerCredential;
let transferA;
let duplicateReplay;
let concurrentTransfer;
let adminSession;
let tenantASession;
let tenantBSession;

async function snapshot(tag, expected = {}) {
  const accountIds = Object.values(tracked).filter(Boolean);
  const rows = await db.query(
    `SELECT id, institution_id, kind, currency_code, balance_minor::text AS balance_minor
       FROM freehold.institution_ledger_accounts
      WHERE id = ANY($1::uuid[])`, [accountIds]);
  const byId = new Map(rows.rows.map(row => [row.id, row]));
  const accounts = Object.fromEntries(Object.entries(tracked).filter(([, id]) => id).map(([label, id]) => {
    const row = byId.get(id);
    if (!row) throw new Error(`Tracked account ${label} not found`);
    return [label, { kind: row.kind, currency: row.currency_code, balanceMinor: row.balance_minor }];
  }));
  const journalCounts = await db.query(
    `SELECT institution_id, count(*)::int AS journals
       FROM freehold.institution_journals
      WHERE institution_id = ANY($1::uuid[])
      GROUP BY institution_id`, [[institutionA, institutionB].filter(Boolean)]);
  const projections = await db.query(
    `SELECT a.id, a.institution_id, a.kind, a.balance_minor::text AS stored_balance_minor,
            COALESCE(sum(freehold._institution_signed(a.kind, e.side, e.amount_minor)), 0)::text AS projected_balance_minor
       FROM freehold.institution_ledger_accounts a
       LEFT JOIN freehold.institution_entries e ON e.account_id = a.id
      WHERE a.institution_id = ANY($1::uuid[])
      GROUP BY a.id, a.institution_id, a.kind, a.balance_minor
      ORDER BY a.id`, [[institutionA, institutionB].filter(Boolean)]);
  const unbalanced = await db.query(
    `SELECT j.id, count(e.*)::int AS lines,
            COALESCE(sum(CASE WHEN e.side = 'DEBIT' THEN e.amount_minor ELSE -e.amount_minor END), 0)::text AS delta
       FROM freehold.institution_journals j
       LEFT JOIN freehold.institution_entries e ON e.journal_id = j.id
      WHERE j.institution_id = ANY($1::uuid[])
      GROUP BY j.id
     HAVING count(e.*) <> 2
         OR COALESCE(sum(CASE WHEN e.side = 'DEBIT' THEN e.amount_minor ELSE -e.amount_minor END), 0) <> 0`, [[institutionA, institutionB].filter(Boolean)]);
  const missingHashes = await db.query(
    `SELECT count(*)::int AS missing
       FROM freehold.institution_journals
      WHERE institution_id = ANY($1::uuid[]) AND request_hash IS NULL`, [[institutionA, institutionB].filter(Boolean)]);
  const customerLedgerResult = await db.query(
    `SELECT (SELECT count(*)::int FROM freehold.ledger_journals) AS journals,
            (SELECT count(*)::int FROM freehold.ledger_entries) AS entries,
            (SELECT count(*)::int FROM freehold.idempotency_requests) AS idempotency_requests`);
  const customerLedger = customerLedgerResult.rows[0];
  const audit = await db.query(
    `SELECT action, count(*)::int AS count
       FROM freehold.institution_audit
      WHERE institution_id = ANY($1::uuid[])
      GROUP BY action ORDER BY action`, [[institutionA, institutionB].filter(Boolean)]);
  const credentials = await db.query(
    `SELECT institution_id, count(*)::int AS count, count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > clock_timestamp())::int AS active
       FROM freehold.institution_credentials
      WHERE institution_id = ANY($1::uuid[])
      GROUP BY institution_id`, [[institutionA, institutionB].filter(Boolean)]);
  const projectionMismatches = projections.rows
    .filter(row => BigInt(row.stored_balance_minor) !== BigInt(row.projected_balance_minor))
    .map(row => ({ accountId: row.id, kind: row.kind, stored: row.stored_balance_minor, projected: row.projected_balance_minor }));
  const record = {
    tag,
    capturedAt: new Date().toISOString(),
    accounts,
    journalCounts: Object.fromEntries(journalCounts.rows.map(row => [row.institution_id, row.journals])),
    institutions: { tenantA: institutionA ?? null, tenantB: institutionB ?? null },
    entries: {
      total: projections.rows.length ? await db.query(
        `SELECT count(*)::int AS n FROM freehold.institution_entries e
          JOIN freehold.institution_journals j ON j.id = e.journal_id
         WHERE j.institution_id = ANY($1::uuid[])`, [[institutionA, institutionB].filter(Boolean)]).then(r => r.rows[0].n) : 0,
      unbalancedJournals: unbalanced.rows,
    },
    requestHashes: { journalsMissingHash: missingHashes.rows[0].missing },
    projections: { mismatches: projectionMismatches },
    customerLedger,
    auditActions: Object.fromEntries(audit.rows.map(row => [row.action, row.count])),
    credentials: credentials.rows.map(row => ({ institutionId: row.institution_id, count: row.count, active: row.active })),
  };
  evidence.databaseSnapshots.push(record);
  for (const [label, balance] of Object.entries(expected)) {
    assert(currentScenario, `postcondition ${tag}: ${label} balance`, accounts[label]?.balanceMinor === balance,
      { expected: balance, actual: accounts[label]?.balanceMinor ?? null });
  }
  assert(currentScenario, `postcondition ${tag}: journal request hashes present`, missingHashes.rows[0].missing === 0, missingHashes.rows[0]);
  assert(currentScenario, `postcondition ${tag}: projections match`, projectionMismatches.length === 0, projectionMismatches);
  assert(currentScenario, `postcondition ${tag}: journals balanced with two lines`, unbalanced.rows.length === 0, unbalanced.rows);
  assert(currentScenario, `postcondition ${tag}: customer ledger untouched`, customerLedger.journals === 0 && customerLedger.entries === 0,
    customerLedger);
  return record;
}

let currentScenario;
async function runScenario(name, title, fn) {
  const record = scenario(name, title);
  currentScenario = record;
  try {
    await fn(record);
    record.status = 'PASS';
    record.completedAt = new Date().toISOString();
    evidence.summary.passed += 1;
  } catch (error) {
    record.status = 'FAIL';
    record.completedAt = new Date().toISOString();
    record.error = error instanceof Error ? error.message : 'unknown';
    if (error?.assertion) record.assertions.push({ ...error.assertion, status: 'FAIL' });
    evidence.summary.failed += 1;
    throw error;
  } finally {
    evidence.summary.scenarios += 1;
    currentScenario = undefined;
  }
}

function credentialFrom(payload) {
  if (!payload?.keyId || !payload?.secret) throw new Error('Credential response did not include keyId and secret');
  return {
    keyId: payload.keyId,
    authorization: `Bearer ${payload.keyId}.${payload.secret}`,
    secretShownOnce: payload.secretShownOnce,
  };
}

function nonce(label) {
  return `p162-${runId}-${label}-${randomUUID()}`.slice(0, 78);
}

async function main() {
  await db.connect();
  const revision = (await db.query('SELECT version() AS version')).rows[0].version;
  evidence.postgresqlVersion = revision;
  const before = await db.query(
    `SELECT (SELECT count(*)::int FROM freehold.ledger_journals) AS customer_journals,
            (SELECT count(*)::int FROM freehold.ledger_entries) AS customer_entries,
            (SELECT count(*)::int FROM freehold.institution_journals) AS institution_journals`);
  evidence.baseline = before.rows[0];

  await runScenario('authentication', 'Bootstrap the platform administrator, register tenant operators, and prove real cookie/CSRF logins', async record => {
    await http(record, 'demo bootstrap platform admin', 'POST', '/v1/demo/bootstrap', {
      bootstrap: true,
      body: { email: adminEmail, password, totpSecret: adminSecret.base32, totp: adminTotp.generate() },
    }, [201]);
    adminSession = await login(adminEmail, { totp: adminTotp.generate() });
    assert(record, 'admin session login', typeof adminSession.csrf === 'string' && adminSession.cookie.startsWith('freehold_session='), { csrf: !!adminSession.csrf });
    const session = await http(record, 'read admin session', 'GET', '/v1/auth/session', { session: adminSession });
    assert(record, 'admin role is ADMIN', session.payload?.user?.role === 'ADMIN', session.payload?.user);
    assert(record, 'admin TOTP is enrolled', session.payload?.user?.twoFactorEnabled === true, session.payload?.user);
    for (const [label, email] of [['tenant A admin', tenantAEmail], ['tenant B admin', tenantBEmail], ['tenant A developer', developerEmail]]) {
      await http(record, `register ${label}`, 'POST', '/v1/auth/register', { body: { email, password } }, [201]);
    }
    tenantASession = await login(tenantAEmail);
    tenantBSession = await login(tenantBEmail);
    assert(record, 'tenant A session login', !!tenantASession.csrf, { csrf: !!tenantASession.csrf });
    assert(record, 'tenant B session login', !!tenantBSession.csrf, { csrf: !!tenantBSession.csrf });
    record.sessions = { platformAdmin: !!adminSession.csrf, tenantA: !!tenantASession.csrf, tenantB: !!tenantBSession.csrf };
    evidence.sessions = { platformAdmin: true, tenantA: true, tenantB: true };
    await snapshot('after-authentication', {});
  });

  await runScenario('tenant-provisioning', 'Create two institutions, grant independent tenant operators, open customers, and fund simulated balances', async record => {
    const openA = await http(record, 'open institution A', 'POST', '/v1/institution/institutions', {
      session: adminSession, body: { code: `p162-a-${runId}`, legalName: 'Phase 16.2 Tenant A' },
    });
    institutionA = openA.payload.institutionId;
    const openB = await http(record, 'open institution B', 'POST', '/v1/institution/institutions', {
      session: adminSession, body: { code: `p162-b-${runId}`, legalName: 'Phase 16.2 Tenant B' },
    });
    institutionB = openB.payload.institutionId;
    assert(record, 'institutions are distinct', institutionA && institutionB && institutionA !== institutionB, { institutionA, institutionB });

    const members = await db.query('SELECT id, email_normalized FROM freehold.users WHERE email_normalized = ANY($1::text[])',
      [[tenantAEmail, tenantBEmail, developerEmail]]);
    const membersByEmail = Object.fromEntries(members.rows.map(row => [row.email_normalized, row.id]));
    await http(record, 'grant tenant A TENANT_ADMIN', 'POST', '/v1/institution/members', {
      session: adminSession, body: { institutionId: institutionA, memberId: membersByEmail[tenantAEmail], capability: 'TENANT_ADMIN' },
    });
    await http(record, 'grant tenant B TENANT_ADMIN', 'POST', '/v1/institution/members', {
      session: adminSession, body: { institutionId: institutionB, memberId: membersByEmail[tenantBEmail], capability: 'TENANT_ADMIN' },
    });
    await http(record, 'grant tenant A developer DEVELOPER', 'POST', '/v1/institution/members', {
      session: adminSession, body: { institutionId: institutionA, memberId: membersByEmail[developerEmail], capability: 'DEVELOPER' },
    });

    const customerA1Response = await http(record, 'open customer A1', 'POST', '/v1/institution/customers', {
      session: tenantASession, body: { institutionId: institutionA, externalRef: `a1-${runId}`, displayName: 'Tenant A Customer 1', currency: 'USD' },
    });
    const customerA2Response = await http(record, 'open customer A2', 'POST', '/v1/institution/customers', {
      session: tenantASession, body: { institutionId: institutionA, externalRef: `a2-${runId}`, displayName: 'Tenant A Customer 2', currency: 'USD' },
    });
    const customerB1Response = await http(record, 'open customer B1', 'POST', '/v1/institution/customers', {
      session: tenantBSession, body: { institutionId: institutionB, externalRef: `b1-${runId}`, displayName: 'Tenant B Customer 1', currency: 'USD' },
    });
    customerA1 = customerA1Response.payload.accountId;
    customerA2 = customerA2Response.payload.accountId;
    customerB1 = customerB1Response.payload.accountId;
    tracked.A1 = customerA1; tracked.A2 = customerA2; tracked.B1 = customerB1;

    await http(record, 'fund customer A1 simulated', 'POST', '/v1/institution/funding', {
      session: tenantASession, body: { institutionId: institutionA, accountId: customerA1, amountMinor: '500000', idempotencyKey: `fund-a1-${runId}` },
    });
    await http(record, 'fund customer B1 simulated', 'POST', '/v1/institution/funding', {
      session: tenantBSession, body: { institutionId: institutionB, accountId: customerB1, amountMinor: '50000', idempotencyKey: `fund-b1-${runId}` },
    });
    await snapshot('after-tenant-provisioning', { A1: '500000', A2: '0', B1: '50000' });
  });

  await runScenario('authorized-transfer', 'Tenant A issues a scoped sandbox credential and transfers between its own customer accounts over HTTP', async record => {
    const issued = await http(record, 'tenant A issues transfer credential', 'POST', '/v1/institution/credentials', {
      session: tenantASession, body: { institutionId: institutionA, scopes: ['transfers:write', 'accounts:read'], ttlSeconds: 3600 },
    });
    credentialA = credentialFrom(issued.payload);
    assert(record, 'credential secret is shown once', issued.payload.secretShownOnce === true, issued.payload.secretShownOnce);
    const issuedB = await http(record, 'tenant B issues read credential', 'POST', '/v1/institution/credentials', {
      session: tenantBSession, body: { institutionId: institutionB, scopes: ['accounts:read'], ttlSeconds: 3600 },
    });
    credentialB = credentialFrom(issuedB.payload);

    const moved = await http(record, 'sandbox transfer A1 -> A2', 'POST', '/v1/institution/sandbox/transfers', {
      credential: credentialA, nonce: nonce('auth-transfer'),
      body: { institutionId: institutionA, fromAccountId: customerA1, toAccountId: customerA2, amountMinor: '10000', idempotencyKey: `transfer-a-${runId}` },
    });
    transferA = moved.payload;
    assert(record, 'authorized transfer posted a new journal', moved.payload?.duplicate === false && typeof moved.payload?.journalId === 'string',
      moved.payload);
    const readA1 = await http(record, 'credential reads A1', 'GET', `/v1/institution/sandbox/accounts/${customerA1}`, {
      credential: credentialA, nonce: nonce('auth-read-a1'), institutionHeader: institutionA,
    });
    assert(record, 'A1 projection is 490000', readA1.payload?.balanceMinor === '490000', readA1.payload);
    const readA2 = await http(record, 'credential reads A2', 'GET', `/v1/institution/sandbox/accounts/${customerA2}`, {
      credential: credentialA, nonce: nonce('auth-read-a2'), institutionHeader: institutionA,
    });
    assert(record, 'A2 projection is 10000', readA2.payload?.balanceMinor === '10000', readA2.payload);
    const readB1 = await http(record, 'tenant B credential reads B1', 'GET', `/v1/institution/sandbox/accounts/${customerB1}`, {
      credential: credentialB, nonce: nonce('tenant-b-read-b1'), institutionHeader: institutionB,
    });
    assert(record, 'B1 projection is 50000', readB1.payload?.balanceMinor === '50000', readB1.payload);
    await snapshot('after-authorized-transfer', { A1: '490000', A2: '10000', B1: '50000' });
  });

  await runScenario('duplicate-key', 'Replay an identical transfer key and prove exactly-once journal reuse', async record => {
    const replay = await http(record, 'replay identical transfer', 'POST', '/v1/institution/sandbox/transfers', {
      credential: credentialA, nonce: nonce('duplicate-replay'),
      body: { institutionId: institutionA, fromAccountId: customerA1, toAccountId: customerA2, amountMinor: '10000', idempotencyKey: `transfer-a-${runId}` },
    });
    duplicateReplay = replay.payload;
    assert(record, 'duplicate replay returns the original journal', replay.payload?.duplicate === true && replay.payload?.journalId === transferA.journalId,
      { original: transferA.journalId, replay: replay.payload });
    const after = await snapshot('after-duplicate-key', { A1: '490000', A2: '10000', B1: '50000' });
    assert(record, 'duplicate replay did not add a journal', after.journalCounts[institutionA] === 2, after.journalCounts);
    assert(record, 'duplicate replay was audited', (after.auditActions.DUPLICATE_TRANSFER ?? 0) >= 1, after.auditActions);
  });

  await runScenario('conflicting-key', 'Reuse the same transfer key with a different amount and require an idempotency conflict', async record => {
    const before = await snapshot('before-conflicting-key', { A1: '490000', A2: '10000', B1: '50000' });
    const conflict = await http(record, 'conflicting amount on same key', 'POST', '/v1/institution/sandbox/transfers', {
      credential: credentialA, nonce: nonce('conflicting-key'),
      body: { institutionId: institutionA, fromAccountId: customerA1, toAccountId: customerA2, amountMinor: '10001', idempotencyKey: `transfer-a-${runId}` },
    }, [409]);
    assert(record, 'conflict code is INSTITUTION_IDEMPOTENCY_CONFLICT', conflict.payload?.code === 'INSTITUTION_IDEMPOTENCY_CONFLICT', conflict.payload);
    const after = await snapshot('after-conflicting-key', { A1: '490000', A2: '10000', B1: '50000' });
    assert(record, 'conflict did not add a journal', after.journalCounts[institutionA] === before.journalCounts[institutionA],
      { before: before.journalCounts, after: after.journalCounts });
  });

  await runScenario('concurrent-duplicate', 'Fire two identical transfers concurrently and require one journal and one replay', async record => {
    const payload = {
      institutionId: institutionA, fromAccountId: customerA1, toAccountId: customerA2,
      amountMinor: '5000', idempotencyKey: `transfer-concurrent-${runId}`,
    };
    const [first, second] = await Promise.all([
      http(record, 'concurrent transfer request 1', 'POST', '/v1/institution/sandbox/transfers', {
        credential: credentialA, nonce: nonce('concurrent-1'), body: payload,
      }),
      http(record, 'concurrent transfer request 2', 'POST', '/v1/institution/sandbox/transfers', {
        credential: credentialA, nonce: nonce('concurrent-2'), body: payload,
      }),
    ]);
    const responses = [first.payload, second.payload];
    concurrentTransfer = responses;
    assert(record, 'both concurrent requests returned a journal', responses.every(item => typeof item?.journalId === 'string'), responses);
    assert(record, 'concurrent requests share one journal', new Set(responses.map(item => item.journalId)).size === 1, responses);
    assert(record, 'exactly one concurrent request posted', responses.filter(item => item.duplicate === false).length === 1, responses);
    assert(record, 'exactly one concurrent request replayed', responses.filter(item => item.duplicate === true).length === 1, responses);
    const after = await snapshot('after-concurrent-duplicate', { A1: '485000', A2: '15000', B1: '50000' });
    assert(record, 'concurrent duplicate added exactly one journal', after.journalCounts[institutionA] === 3, after.journalCounts);
  });

  await runScenario('unauthorized-cross-tenant', 'Tenant A credential and session must not read or debit tenant B resources', async record => {
    const before = await snapshot('before-unauthorized-cross-tenant', { A1: '485000', A2: '15000', B1: '50000' });

    const readBWithBHeader = await http(record, 'tenant A credential reads B1 as institution B', 'GET', `/v1/institution/sandbox/accounts/${customerB1}`, {
      credential: credentialA, nonce: nonce('cross-read-b'), institutionHeader: institutionB,
    }, [403]);
    assert(record, 'read with B header is forbidden', readBWithBHeader.payload?.code === 'INSTITUTION_FORBIDDEN', readBWithBHeader.payload);
    impressionRecord('tenant-a-credential-reads-tenant-b-account', 'GET', `/v1/institution/sandbox/accounts/${customerB1}`,
      { institutionHeader: institutionB, accountId: customerB1 }, readBWithBHeader);

    const readBWithAHeader = await http(record, 'tenant A credential reads B1 under institution A', 'GET', `/v1/institution/sandbox/accounts/${customerB1}`, {
      credential: credentialA, nonce: nonce('cross-read-b-a-header'), institutionHeader: institutionA,
    }, [403]);
    assert(record, 'read under A header is forbidden', readBWithAHeader.payload?.code === 'INSTITUTION_FORBIDDEN', readBWithAHeader.payload);
    impressionRecord('tenant-a-credential-reads-tenant-b-account-under-a-header', 'GET', `/v1/institution/sandbox/accounts/${customerB1}`,
      { institutionHeader: institutionA, accountId: customerB1 }, readBWithAHeader);

    const debitBAsB = await http(record, 'tenant A credential debits B1 as institution B', 'POST', '/v1/institution/sandbox/transfers', {
      credential: credentialA, nonce: nonce('cross-debit-b'),
      body: { institutionId: institutionB, fromAccountId: customerB1, toAccountId: customerA1, amountMinor: '100', idempotencyKey: `cross-tenant-b-${runId}` },
    }, [403]);
    assert(record, 'cross-tenant debit as B is forbidden', debitBAsB.payload?.code === 'INSTITUTION_FORBIDDEN', debitBAsB.payload);
    impressionRecord('tenant-a-credential-debits-tenant-b-account', 'POST', '/v1/institution/sandbox/transfers',
      { institutionId: institutionB, fromAccountId: customerB1, toAccountId: customerA1, amountMinor: '100' }, debitBAsB);

    const debitBAsA = await http(record, 'tenant A credential debits B1 under institution A', 'POST', '/v1/institution/sandbox/transfers', {
      credential: credentialA, nonce: nonce('cross-debit-b-a'),
      body: { institutionId: institutionA, fromAccountId: customerB1, toAccountId: customerA1, amountMinor: '100', idempotencyKey: `cross-tenant-a-${runId}` },
    }, [403]);
    assert(record, 'cross-tenant debit under A is forbidden', debitBAsA.payload?.code === 'INSTITUTION_FORBIDDEN', debitBAsA.payload);
    impressionRecord('tenant-a-credential-debits-tenant-b-account-under-a-header', 'POST', '/v1/institution/sandbox/transfers',
      { institutionId: institutionA, fromAccountId: customerB1, toAccountId: customerA1, amountMinor: '100' }, debitBAsA);

    const sessionReadB = await http(record, 'tenant A session reads B1 through institution B', 'GET', `/v1/institution/accounts/${institutionB}/${customerB1}`, {
      session: tenantASession,
    }, [403]);
    assert(record, 'tenant A session cannot read B', sessionReadB.payload?.code === 'INSTITUTION_FORBIDDEN', sessionReadB.payload);
    impressionRecord('tenant-a-session-reads-tenant-b-account', 'GET', `/v1/institution/accounts/${institutionB}/${customerB1}`,
      { institutionId: institutionB, accountId: customerB1 }, sessionReadB);

    const after = await snapshot('after-unauthorized-cross-tenant', { A1: '485000', A2: '15000', B1: '50000' });
    assert(record, 'unauthorized attempts did not add a journal', after.journalCounts[institutionA] === before.journalCounts[institutionA]
      && after.journalCounts[institutionB] === before.journalCounts[institutionB], { before: before.journalCounts, after: after.journalCounts });
  });

  await runScenario('tenant-impersonation', 'Tenant A attempts to provision, read, or mint credentials for tenant B and is refused at the function boundary', async record => {
    const issueForB = await http(record, 'tenant A session issues credential for tenant B', 'POST', '/v1/institution/credentials', {
      session: tenantASession, body: { institutionId: institutionB, scopes: ['accounts:read'], ttlSeconds: 600 },
    }, [403]);
    assert(record, 'cross-tenant credential issue is forbidden', issueForB.payload?.code === 'INSTITUTION_FORBIDDEN', issueForB.payload);
    impressionRecord('tenant-a-session-issues-tenant-b-credential', 'POST', '/v1/institution/credentials',
      { institutionId: institutionB, scopes: ['accounts:read'] }, issueForB);

    const customerForB = await http(record, 'tenant A session opens customer at tenant B', 'POST', '/v1/institution/customers', {
      session: tenantASession, body: { institutionId: institutionB, externalRef: `imp-${runId}`, displayName: 'Impersonation Attempt', currency: 'USD' },
    }, [403]);
    assert(record, 'cross-tenant customer open is forbidden', customerForB.payload?.code === 'INSTITUTION_FORBIDDEN', customerForB.payload);
    impressionRecord('tenant-a-session-opens-tenant-b-customer', 'POST', '/v1/institution/customers',
      { institutionId: institutionB, externalRef: `imp-${runId}` }, customerForB);

    const memberForB = await http(record, 'tenant A session grants a member at tenant B', 'POST', '/v1/institution/members', {
      session: tenantASession, body: { institutionId: institutionB, memberId: randomUUID(), capability: 'AUDITOR' },
    }, [403]);
    assert(record, 'cross-tenant member grant is forbidden', memberForB.payload?.code === 'INSTITUTION_FORBIDDEN', memberForB.payload);
    impressionRecord('tenant-a-session-grants-tenant-b-member', 'POST', '/v1/institution/members',
      { institutionId: institutionB, capability: 'AUDITOR' }, memberForB);

    const bCredentialReadsA = await http(record, 'tenant B credential reads A1 as institution A', 'GET', `/v1/institution/sandbox/accounts/${customerA1}`, {
      credential: credentialB, nonce: nonce('b-read-a'), institutionHeader: institutionA,
    }, [403]);
    assert(record, 'tenant B credential cannot read A', bCredentialReadsA.payload?.code === 'INSTITUTION_FORBIDDEN', bCredentialReadsA.payload);
    impressionRecord('tenant-b-credential-reads-tenant-a-account', 'GET', `/v1/institution/sandbox/accounts/${customerA1}`,
      { institutionHeader: institutionA, accountId: customerA1 }, bCredentialReadsA);

    await snapshot('after-tenant-impersonation', { A1: '485000', A2: '15000', B1: '50000' });
    impersonation.outcome = 'PASS';
  });

  await runScenario('credential-scope-confinement', 'A developer cannot mint or use transfer authority outside its capability', async record => {
    const developer = await login(developerEmail);
    const denied = await http(record, 'developer requests transfers:write scope', 'POST', '/v1/institution/credentials', {
      session: developer, body: { institutionId: institutionA, scopes: ['transfers:write'], ttlSeconds: 600 },
    }, [403]);
    assert(record, 'scope escalation is refused', denied.payload?.code === 'INSTITUTION_SCOPE', denied.payload);

    const issued = await http(record, 'developer issues accounts:read scope', 'POST', '/v1/institution/credentials', {
      session: developer, body: { institutionId: institutionA, scopes: ['accounts:read'], ttlSeconds: 600 },
    });
    developerCredential = credentialFrom(issued.payload);
    const read = await http(record, 'developer credential reads A1', 'GET', `/v1/institution/sandbox/accounts/${customerA1}`, {
      credential: developerCredential, nonce: nonce('dev-read'), institutionHeader: institutionA,
    });
    assert(record, 'developer credential read is allowed', read.payload?.balanceMinor === '485000', read.payload);
    const transfer = await http(record, 'developer credential attempts transfer', 'POST', '/v1/institution/sandbox/transfers', {
      credential: developerCredential, nonce: nonce('dev-transfer'),
      body: { institutionId: institutionA, fromAccountId: customerA1, toAccountId: customerA2, amountMinor: '1', idempotencyKey: `dev-transfer-${runId}` },
    }, [403]);
    assert(record, 'developer credential transfer is forbidden by scope', transfer.payload?.code === 'INSTITUTION_SCOPE', transfer.payload);
    await snapshot('after-credential-scope-confinement', { A1: '485000', A2: '15000', B1: '50000' });
  });

  await runScenario('final-ledger-verification', 'Read back every tracked projection and prove the institutional plane remained isolated from the customer ledger', async record => {
    const final = await snapshot('final', { A1: '485000', A2: '15000', B1: '50000' });
    assert(record, 'tenant A has three journals', final.journalCounts[institutionA] === 3, final.journalCounts);
    assert(record, 'tenant B has one journal', final.journalCounts[institutionB] === 1, final.journalCounts);
    assert(record, 'all tracked account projections agree', final.projections.mismatches.length === 0, final.projections.mismatches);
    assert(record, 'all journals have request hashes', final.requestHashes.journalsMissingHash === 0, final.requestHashes);
    assert(record, 'customer ledger remains empty', final.customerLedger.journals === 0 && final.customerLedger.entries === 0, final.customerLedger);
    record.journalIds = [transferA.journalId, ...(concurrentTransfer ?? []).map(item => item.journalId)];
    evidence.final = {
      journalIds: record.journalIds,
      duplicateJournalId: duplicateReplay?.journalId ?? null,
      concurrentJournalIds: (concurrentTransfer ?? []).map(item => item.journalId),
      tenantAJournalCount: final.journalCounts[institutionA],
      tenantBJournalCount: final.journalCounts[institutionB],
      customerLedger: final.customerLedger,
    };
  });

  evidence.summary.outcome = evidence.summary.failed === 0 ? 'PASS' : 'FAIL';
  impersonation.generatedAt = new Date().toISOString();
}

const impression = [];
function impressionRecord(name, method, path, requestDetail, response) {
  const record = {
    name, method, path, request: scrub(requestDetail),
    response: { status: response.status, code: response.payload?.code ?? null },
    expected: 'HTTP 403 INSTITUTION_FORBIDDEN',
    pass: response.status === 403 && response.payload?.code === 'INSTITUTION_FORBIDDEN',
  };
  impression.push(record);
  impersonation.attempts.push(record);
}

async function writeEvidence() {
  evidence.generatedAt = new Date().toISOString();
  impersonation.generatedAt = new Date().toISOString();
  impersonation.outcome = impersonation.attempts.length && impersonation.attempts.every(item => item.pass) ? 'PASS' : 'FAIL';
  await writeFile(`${OUT_DIR}/http-financial-tests.json`, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await writeFile(`${OUT_DIR}/tenant-impersonation.json`, `${JSON.stringify(impersonation, null, 2)}\n`, { mode: 0o600 });
}

try {
  await main();
} catch (error) {
  evidence.summary.outcome = 'FAIL';
  evidence.error = error instanceof Error ? error.message : 'unknown';
  process.exitCode = 1;
} finally {
  await writeEvidence().catch(writeError => {
    process.stderr.write(`Failed to write evidence: ${writeError instanceof Error ? writeError.message : 'unknown'}\n`);
    process.exitCode = 1;
  });
  await db.end().catch(() => undefined);
}
if (evidence.summary.outcome !== 'PASS') {
  process.stderr.write(`Phase 16.2 HTTP evidence outcome: ${evidence.summary.outcome}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Phase 16.2 HTTP evidence: PASS (${evidence.summary.passed}/${evidence.summary.scenarios} scenarios)\n`);
}
