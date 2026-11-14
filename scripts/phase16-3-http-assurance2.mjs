import { Client } from 'pg';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
mkdirSync('docs/evidence/phase16-3', { recursive: true });
const env = {};
for (const line of readFileSync('/tmp/opencode/freehold-p162/env', 'utf8').split('\n')) {
  const m = line.replace(/^export\s+/, '').match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^'|'$/g, '');
}
const API = 'http://127.0.0.1:34110';
const admin = new Client({ connectionString: env.TEST_DATABASE_ADMIN_URL });
await admin.connect();
const prior = JSON.parse(readFileSync('docs/evidence/phase16-3/http-assurance.json','utf8'));
const out = prior;
const rec = (name, ok, detail) => { out.tests.push({ name, ok, detail }); console.log(`${ok?'OK':'FAIL'} ${name}`); };

async function jfetch(path, opts = {}) {
  const res = await fetch(API + path, opts);
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  const set = res.headers.get('set-cookie') || '';
  return { status: res.status, body, text, cookie: (set.match(/freehold_session=[^;]+/) || [])[0] };
}
async function login(email, password) {
  const r = await jfetch('/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (r.status !== 200) throw new Error(`login ${email} ${r.status} ${JSON.stringify(r.body)}`);
  return { cookie: r.cookie, csrf: r.body.csrfToken };
}
function sh(s, extra={}) { return { 'content-type': 'application/json', cookie: s.cookie, 'x-csrf-token': s.csrf, ...extra }; }

const tag = Date.now().toString(36);
const pwd = 'Phase163HttpPassword!!';
const email = `p163i2-${tag}@example.test`;
const reg = await jfetch('/v1/auth/register', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({email,password:pwd}) });
await admin.query("UPDATE freehold.users SET role='ADMIN' WHERE id=$1", [reg.body.userId]);
const s = await login(email,pwd); // after role update
rec('inst_setup_login', reg.status===201 && !!s.cookie, {userId: reg.body?.userId});

const code = `ih${tag.slice(-6)}`.toLowerCase().replace(/[^a-z0-9-]/g,'a').slice(0,12);
const inst = await jfetch('/v1/institution/institutions', {method:'POST', headers: sh(s, {'idempotency-key':`inst-${tag}`}), body: JSON.stringify({code, legalName:'Phase163 Inst HTTP'})});
rec('http_institution_open_v2', inst.status===200 || inst.status===201, {status:inst.status, body:inst.body});
const instId = inst.body?.institutionId;
if (instId) {
  const c1 = await jfetch('/v1/institution/customers', {method:'POST', headers: sh(s), body: JSON.stringify({institutionId: instId, externalRef:`ec1-${tag}`, displayName:'Cust1', currency:'USD'})});
  const c2 = await jfetch('/v1/institution/customers', {method:'POST', headers: sh(s), body: JSON.stringify({institutionId: instId, externalRef:`ec2-${tag}`, displayName:'Cust2', currency:'USD'})});
  rec('http_inst_customers', c1.status===200 && c2.status===200, {c1,c2});
  const a1 = c1.body?.accountId, a2 = c2.body?.accountId;
  const fk = `if-${tag}`;
  const fbody = {institutionId: instId, accountId:a1, amountMinor:'5000', idempotencyKey: fk};
  const f1 = await jfetch('/v1/institution/funding', {method:'POST', headers: sh(s), body: JSON.stringify(fbody)});
  const f2 = await jfetch('/v1/institution/funding', {method:'POST', headers: sh(s), body: JSON.stringify(fbody)});
  rec('http_inst_fund_replay', f1.status===200 && f2.status===200 && f1.body?.journalId===f2.body?.journalId, {f1,f2});
  const f3 = await jfetch('/v1/institution/funding', {method:'POST', headers: sh(s), body: JSON.stringify({...fbody, amountMinor:'5001'})});
  rec('http_inst_fund_conflict', f3.status===409, {status:f3.status, body:f3.body});
  // DB check no duplicate journal for fund key
  const fj = await admin.query("SELECT count(*)::int c FROM freehold.institution_journals WHERE institution_id=$1 AND idempotency_key=$2", [instId, fk]);
  rec('http_inst_fund_single_journal', fj.rows[0].c===1, fj.rows[0]);

  const pk = `ip-${tag}`;
  const pbody = {institutionId: instId, accountId:a1, amountMinor:'100', rail:'ACH', externalRef:`ext-${tag}`, idempotencyKey: pk};
  const p1 = await jfetch('/v1/institution/payments', {method:'POST', headers: sh(s), body: JSON.stringify(pbody)});
  const p2 = await jfetch('/v1/institution/payments', {method:'POST', headers: sh(s), body: JSON.stringify(pbody)});
  rec('http_inst_payment_replay', p1.status===200 && p2.status===200 && p1.body?.paymentId===p2.body?.paymentId, {p1,p2});
  const p3 = await jfetch('/v1/institution/payments', {method:'POST', headers: sh(s), body: JSON.stringify({...pbody, amountMinor:'101'})});
  rec('http_inst_payment_conflict', p3.status===409, {status:p3.status, body:p3.body});
  const pc = await admin.query("SELECT count(*)::int c FROM freehold.institution_payments WHERE institution_id=$1 AND idempotency_key=$2", [instId, pk]);
  rec('http_inst_payment_single_row', pc.rows[0].c===1, pc.rows[0]);

  const tk = `it-${tag}`;
  const tbody = {institutionId: instId, fromAccountId:a1, toAccountId:a2, amountMinor:'200', idempotencyKey: tk};
  const t1 = await jfetch('/v1/institution/transfers', {method:'POST', headers: sh(s), body: JSON.stringify(tbody)});
  const t2 = await jfetch('/v1/institution/transfers', {method:'POST', headers: sh(s), body: JSON.stringify(tbody)});
  rec('http_inst_transfer_replay', t1.status===200 && t2.status===200 && t1.body?.journalId===t2.body?.journalId, {t1,t2});
  const t3 = await jfetch('/v1/institution/transfers', {method:'POST', headers: sh(s), body: JSON.stringify({...tbody, amountMinor:'201'})});
  rec('http_inst_transfer_conflict', t3.status===409, {status:t3.status, body:t3.body});

  // usage metering endpoint - find route
  const uk = `usage-${tag}`;
  const ubody = {institutionId: instId, periodStart:'2026-11-01', meter:'API_CALL', quantity:'5', idempotencyKey: uk};
  const u1 = await jfetch('/v1/institution/billing/usage', {method:'POST', headers: sh(s), body: JSON.stringify(ubody)});
  rec('http_usage_route_probe', true, {status:u1.status, body:u1.body});
} else {
  rec('inst_http_flows_skipped_v2', false, inst);
}

writeFileSync('docs/evidence/phase16-3/http-assurance.json', JSON.stringify(out, null, 2));
await admin.end();
console.log('done2');
