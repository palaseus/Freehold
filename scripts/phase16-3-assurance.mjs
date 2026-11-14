import { Client } from 'pg';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';

mkdirSync('docs/evidence/phase16-3', { recursive: true });
const env = {};
for (const line of readFileSync('/tmp/opencode/freehold-p162/env', 'utf8').split('\n')) {
  const m = line.replace(/^export\s+/, '').match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^'|'$/g, '');
}
const API = 'http://127.0.0.1:34110';
const admin = new Client({ connectionString: env.TEST_DATABASE_ADMIN_URL });
await admin.connect();
const apiRole = new Client({ connectionString: env.DATABASE_URL }); // freehold_api
await apiRole.connect();

const evidence = {
  timestamp: new Date().toISOString(),
  git: { head: 'fca690e4dcffa757e6dde93956083bd83db17b54' },
  environment: { db: 'freehold_p162', pgPort: 33526, api: 'http://127.0.0.1:34110', auth: 'http://127.0.0.1:34111', disposable: true },
  tests: [], defects: [], notes: []
};
const rec = (name, ok, detail) => { evidence.tests.push({ name, ok, detail }); console.log(`${ok ? 'OK' : 'FAIL'} ${name}`); };

async function jfetch(url, opts = {}) {
  const res = await fetch(API + url, opts);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  const set = res.headers.get('set-cookie') || '';
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body, text, cookie: (set.match(/freehold_session=[^;]+/) || [])[0] };
}
async function register(email, password) {
  return jfetch('/v1/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
}
async function login(email, password) {
  const r = await jfetch('/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (r.status !== 200) throw new Error(`login ${email} ${r.status} ${JSON.stringify(r.body)}`);
  return { cookie: r.cookie, csrf: r.body.csrfToken };
}
function sh(session, extra = {}) { return { 'content-type': 'application/json', cookie: session.cookie, 'x-csrf-token': session.csrf, ...extra }; }

const password = 'Phase163TestPassword!!';
const tag = Date.now().toString(36);
const emails = { a: `p163a2-${tag}@example.test`, b: `p163b2-${tag}@example.test`, c: `p163c2-${tag}@example.test` };

await admin.query('UPDATE freehold.ledger_settings SET sandbox_enabled=true WHERE singleton');
await admin.query('UPDATE freehold.demo_settings SET enabled=true WHERE singleton');

for (const [k,e] of Object.entries(emails)) {
  const r = await register(e, password);
  rec(`register_${k}`, [200,201].includes(r.status), { status: r.status, body: r.body });
  evidence[`${k}UserId`] = r.body?.userId;
}
const sa = await login(emails.a, password);
const sb = await login(emails.b, password);
const sc = await login(emails.c, password);
rec('login_sessions', !!sa.cookie && !!sb.cookie && !!sc.cookie, {});

// make user A admin for institution onboarding
await admin.query("UPDATE freehold.users SET role='ADMIN' WHERE email_normalized=$1", [emails.a]);

// create customer accounts via HTTP
const mkA1 = await jfetch('/v1/accounts', { method: 'POST', headers: sh(sa, { 'idempotency-key': `mk-a1-${tag}` }), body: JSON.stringify({ currency: 'USD' }) });
const mkA2 = await jfetch('/v1/accounts', { method: 'POST', headers: sh(sa, { 'idempotency-key': `mk-a2-${tag}` }), body: JSON.stringify({ currency: 'USD' }) });
const mkB1 = await jfetch('/v1/accounts', { method: 'POST', headers: sh(sb, { 'idempotency-key': `mk-b1-${tag}` }), body: JSON.stringify({ currency: 'USD' }) });
rec('create_customer_accounts', mkA1.status===200 && mkA2.status===200 && mkB1.status===200, { a1: mkA1.status, a2: mkA2.status, b1: mkB1.status });
const acctA1 = mkA1.body?.accountId, acctA2 = mkA2.body?.accountId, acctB1 = mkB1.body?.accountId;
evidence.customerAccounts = { acctA1, acctA2, acctB1 };

// fund via direct ledger mechanics is hard; instead use admin DB + session-bound call pattern by inserting api_session and calling function
// simpler: grant sandbox funds by temporarily calling as bound session in SQL transaction using auth_bind_session
async function bindAndCall(actorId, sql, params) {
  const client = await admin.connect ? admin : admin; // reuse
  // use a dedicated client
}
const fundClient = new Client({ connectionString: env.DATABASE_URL }); // freehold_api connection
await fundClient.connect();
async function sandboxFundViaBoundSession(actorId, accountId, amount, key, reason) {
  const secret = randomUUID().replace(/-/g,'') + randomUUID().replace(/-/g,''); // 64 hex
  const c = new Client({ connectionString: env.DATABASE_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('freehold.session_secret',$1,true)", [secret]);
    // bind session in DB (auth_bind_session requires caller context; it's SECURITY DEFINER owned by owner, but granted? check)
    // easier: insert api_sessions directly as admin then run as api role
    await c.query('ROLLBACK');
  } finally { await c.end(); }
  const a = new Client({ connectionString: env.TEST_DATABASE_ADMIN_URL });
  await a.connect();
  try {
    await a.query("INSERT INTO freehold.api_sessions(id,principal_id,secret_hash,auth_version,two_factor_verified_at,expires_at) VALUES($1,$2,sha256(decode($3,'hex')),(SELECT auth_version FROM freehold.users WHERE id=$2),NULL,now()+interval '1 hour') ON CONFLICT DO NOTHING", [randomUUID(), actorId, secret]);
  } finally { await a.end(); }
  const b = new Client({ connectionString: env.DATABASE_URL });
  await b.connect();
  try {
    await b.query('BEGIN');
    await b.query("SELECT set_config('freehold.session_secret',$1,true)", [secret]);
    const r = await b.query(sqlText, paramsText); // placeholder
  } finally { await b.end(); }
}

writeFileSync('docs/evidence/phase16-3/http-tests-partial.json', JSON.stringify(evidence, null, 2));
await admin.end(); await apiRole.end();
console.log('partial_written_v2');
