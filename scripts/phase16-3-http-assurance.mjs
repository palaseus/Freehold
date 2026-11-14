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
const out = { timestamp: new Date().toISOString(), git: 'fca690e4dcffa757e6dde93956083bd83db17b54', tests: [], defects: [], notes: [] };
const rec = (name, ok, detail) => { out.tests.push({ name, ok, detail }); console.log(`${ok?'OK':'FAIL'} ${name}`); };

async function jfetch(path, opts = {}) {
  const res = await fetch(API + path, opts);
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  const set = res.headers.get('set-cookie') || '';
  return { status: res.status, body, text, headers: Object.fromEntries(res.headers.entries()), cookie: (set.match(/freehold_session=[^;]+/) || [])[0] };
}
async function login(email, password) {
  const r = await jfetch('/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (r.status !== 200) throw new Error(`login ${email} ${r.status} ${JSON.stringify(r.body)}`);
  return { cookie: r.cookie, csrf: r.body.csrfToken };
}
function sh(s, extra={}) { return { 'content-type': 'application/json', cookie: s.cookie, 'x-csrf-token': s.csrf, ...extra }; }
async function boundCall(actorId, sql, params) {
  const secret = (randomUUID()+randomUUID()).replace(/-/g,'');
  await admin.query("INSERT INTO freehold.api_sessions(id,principal_id,secret_hash,auth_version,two_factor_verified_at,expires_at) VALUES($1,$2,sha256(decode($3,'hex')),(SELECT auth_version FROM freehold.users WHERE id=$2),NULL,now()+interval '1 hour')", [randomUUID(), actorId, secret]);
  const c = new Client({ connectionString: env.DATABASE_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('freehold.session_secret',$1,true)", [secret]);
    const r = await c.query(sql, params);
    await c.query('COMMIT');
    return r.rows[0]?.item ?? r.rows[0] ?? null;
  } finally { await c.end().catch(()=>{}); }
}

await admin.query('UPDATE freehold.ledger_settings SET sandbox_enabled=true WHERE singleton');
await admin.query('UPDATE freehold.demo_settings SET enabled=true WHERE singleton');

const tag = Date.now().toString(36);
const pwd = 'Phase163HttpPassword!!';
const U = {};
for (const k of ['a','b']) {
  const email = `p163h2-${k}-${tag}@example.test`;
  const reg = await jfetch('/v1/auth/register', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({email,password:pwd}) });
  const sess = await login(email,pwd);
  U[k] = { email, id: reg.body?.userId, s: sess };
  rec(`setup_${k}`, reg.status===201 && !!U[k].id, {status:reg.status,id:U[k].id});
}
await admin.query("UPDATE freehold.users SET role='ADMIN' WHERE id=$1", [U.a.id]);

const ca = await jfetch('/v1/accounts', { method:'POST', headers: sh(U.a.s, {'idempotency-key':`h2-a-${tag}`}), body: JSON.stringify({currency:'USD'}) });
const cb = await jfetch('/v1/accounts', { method:'POST', headers: sh(U.b.s, {'idempotency-key':`h2-b-${tag}`}), body: JSON.stringify({currency:'USD'}) });
U.a.acct = ca.body?.accountId; U.b.acct = cb.body?.accountId;
rec('setup_accounts', ca.status===200 && cb.status===200 && U.a.acct && U.b.acct, {ca:ca.body, cb:cb.body});
const fund = await boundCall(U.a.id, "SELECT freehold.sandbox_fund_account($1::uuid,$2::uuid,$3::bigint,$4::text,$5::text,$6::uuid) AS item", [U.a.id, U.a.acct, 20000n, `hf-${tag}`, 'phase163', randomUUID()]).catch(e=>({error:e.message,code:e.code}));
rec('setup_fund', fund && !fund.error, fund);

async function idReqCount(actor,key) {
  const r = await admin.query("SELECT count(*)::int c, min(response_status) rs FROM freehold.idempotency_requests WHERE actor_id=$1 AND key=$2", [actor,key]);
  return r.rows[0];
}

// 1) Customer transfer HTTP idempotency
if (fund && !fund.error) {
  const key = `ctx-${tag}`;
  const body = { sourceAccountId: U.a.acct, destinationAccountId: U.b.acct, currency:'USD', amountMinor:'700' };
  const t1 = await jfetch('/v1/transfers', {method:'POST', headers: sh(U.a.s, {'idempotency-key':key}), body: JSON.stringify(body)});
  const t2 = await jfetch('/v1/transfers', {method:'POST', headers: sh(U.a.s, {'idempotency-key':key}), body: JSON.stringify(body)});
  rec('customer_transfer_http_same_payload_replay', t1.status===200 && t2.status===200 && JSON.stringify(t1.body)===JSON.stringify(t2.body), {t1, t2});
  const t3 = await jfetch('/v1/transfers', {method:'POST', headers: sh(U.a.s, {'idempotency-key':key}), body: JSON.stringify({...body, amountMinor:'701'})});
  rec('customer_transfer_http_conflict_payload', t3.status===409, {status:t3.status, body:t3.body});
  const cnt = await idReqCount(U.a.id, key);
  rec('customer_transfer_single_idempotency_record', cnt.c===1, cnt);
  // concurrent identical
  const ckey = `ctxc-${tag}`;
  const cbody = { sourceAccountId: U.a.acct, destinationAccountId: U.b.acct, currency:'USD', amountMinor:'100' };
  const conc = await Promise.all(Array.from({length:5},()=> jfetch('/v1/transfers', {method:'POST', headers: sh(U.a.s, {'idempotency-key':ckey}), body: JSON.stringify(cbody)})));
  const ops = [...new Set(conc.map(r=>r.body?.operationId).filter(Boolean))];
  rec('customer_transfer_concurrent_identical', conc.every(r=>r.status===200) && ops.length===1, {statuses: conc.map(r=>r.status), ops, bodies: conc.map(r=>r.body)});
  // commit-uncertainty / lost response simulation: DB committed (t1) and retry returns same authoritative result; verify journal/transfer count for operation
  if (t1.body?.operationId) {
    const x = await admin.query("SELECT (SELECT count(*)::int FROM freehold.transfers WHERE operation_id=$1) transfers, (SELECT count(*)::int FROM freehold.ledger_journals WHERE operation_id=$1) journals, (SELECT count(*)::int FROM freehold.ledger_entries e JOIN freehold.ledger_journals j ON j.id=e.journal_id WHERE j.operation_id=$1) entries", [t1.body.operationId]);
    rec('customer_transfer_lost_response_no_duplicate', x.rows[0].transfers===1 && x.rows[0].journals===1 && x.rows[0].entries===2, {operationId:t1.body.operationId, db:x.rows[0], replay:t2.body});
  }
}

// 2) Institution flows via HTTP session endpoints
// open institution (admin user A)
const instCode = `ih${tag.slice(-6)}`.toLowerCase().replace(/[^a-z0-9-]/g,'a').slice(0,12);
const inst = await jfetch('/v1/institution', {method:'POST', headers: sh(U.a.s, {'idempotency-key':`inst-${tag}`}), body: JSON.stringify({code: instCode, legalName: 'Phase163 Inst HTTP'})});
rec('http_institution_open', inst.status===200 || inst.status===201, {status:inst.status, body:inst.body});
const instId = inst.body?.institutionId || inst.body?.id;
let cust1, cust2;
if (instId) {
  const c1 = await jfetch(`/v1/institution/${instId}/customers`, {method:'POST', headers: sh(U.a.s, {'idempotency-key':`ic1-${tag}`}), body: JSON.stringify({externalRef:`ec1-${tag}`, displayName:'Cust1', currency:'USD'})});
  const c2 = await jfetch(`/v1/institution/${instId}/customers`, {method:'POST', headers: sh(U.a.s, {'idempotency-key':`ic2-${tag}`}), body: JSON.stringify({externalRef:`ec2-${tag}`, displayName:'Cust2', currency:'USD'})});
  rec('http_institution_customers', c1.status===200 && c2.status===200, {c1:{status:c1.status,body:c1.body}, c2:{status:c2.status,body:c2.body}});
  cust1 = c1.body?.accountId; cust2 = c2.body?.accountId;
  // simulated funding
  const fbody = {institutionId: instId, accountId: cust1, amountMinor:'5000', idempotencyKey:`if-${tag}`, correlationId: randomUUID()};
  const f1 = await jfetch('/v1/institution/funding', {method:'POST', headers: sh(U.a.s, {'idempotency-key':`ifh-${tag}`}), body: JSON.stringify(fbody)});
  const f2 = await jfetch('/v1/institution/funding', {method:'POST', headers: sh(U.a.s, {'idempotency-key':`ifh2-${tag}`}), body: JSON.stringify(fbody)}); // same business key in body
  rec('http_institution_fund_idempotent_by_body_key', f1.status===200 && f2.status===200 && (f1.body?.journalId===f2.body?.journalId || JSON.stringify(f1.body)===JSON.stringify(f2.body)), {f1:{status:f1.status,body:f1.body}, f2:{status:f2.status,body:f2.body}});
  // different payload same key
  const f3 = await jfetch('/v1/institution/funding', {method:'POST', headers: sh(U.a.s, {'idempotency-key':`ifh3-${tag}`}), body: JSON.stringify({...fbody, amountMinor:'5001'})});
  rec('http_institution_fund_conflict', f3.status===409 || f3.status===400, {status:f3.status, body:f3.body});

  // institution payment
  if (cust1) {
    const pkey = `ip-${tag}`;
    const pbody = {institutionId: instId, accountId: cust1, amountMinor:'100', rail:'ACH', externalRef:`ext-${tag}`, idempotencyKey:pkey, correlationId: randomUUID()};
    const p1 = await jfetch('/v1/institution/payments', {method:'POST', headers: sh(U.a.s, {'idempotency-key':`iph-${tag}`}), body: JSON.stringify(pbody)});
    const p2 = await jfetch('/v1/institution/payments', {method:'POST', headers: sh(U.a.s, {'idempotency-key':`iph2-${tag}`}), body: JSON.stringify(pbody)});
    rec('http_institution_payment_replay', p1.status===200 && p2.status===200 && p1.body?.paymentId===p2.body?.paymentId, {p1:{status:p1.status,body:p1.body}, p2:{status:p2.status,body:p2.body}});
    const p3 = await jfetch('/v1/institution/payments', {method:'POST', headers: sh(U.a.s, {'idempotency-key':`iph3-${tag}`}), body: JSON.stringify({...pbody, amountMinor:'101'})});
    rec('http_institution_payment_conflict', p3.status===409, {status:p3.status, body:p3.body});
    const pc = await admin.query("SELECT count(*)::int c FROM freehold.institution_payments WHERE institution_id=$1 AND idempotency_key=$2", [instId, pkey]);
    rec('http_institution_payment_single_row', pc.rows[0].c===1, pc.rows[0]);
  }

  // institution internal transfer
  if (cust1 && cust2) {
    const tkey = `it-${tag}`;
    const tbody = {institutionId: instId, fromAccountId: cust1, toAccountId: cust2, amountMinor:'200', idempotencyKey:tkey, correlationId: randomUUID()};
    const it1 = await jfetch('/v1/institution/transfers', {method:'POST', headers: sh(U.a.s, {'idempotency-key':`ith-${tag}`}), body: JSON.stringify(tbody)});
    const it2 = await jfetch('/v1/institution/transfers', {method:'POST', headers: sh(U.a.s, {'idempotency-key':`ith2-${tag}`}), body: JSON.stringify(tbody)});
    rec('http_institution_transfer_replay', it1.status===200 && it2.status===200 && it1.body?.journalId===it2.body?.journalId, {it1:{status:it1.status,body:it1.body}, it2:{status:it2.status,body:it2.body}});
    const it3 = await jfetch('/v1/institution/transfers', {method:'POST', headers: sh(U.a.s, {'idempotency-key':`ith3-${tag}`}), body: JSON.stringify({...tbody, amountMinor:'201'})});
    rec('http_institution_transfer_conflict', it3.status===409, {status:it3.status, body:it3.body});
  }

  // usage metering (keyed)
  const uk = `usage-${tag}`;
  const ubody = {institutionId: instId, periodDate:'2026-11-01', meter:'API_CALL', quantityMinor:'5', idempotencyKey: uk};
  const u1 = await jfetch('/v1/institution/billing/usage', {method:'POST', headers: sh(U.a.s, {'idempotency-key':`uh-${tag}`}), body: JSON.stringify(ubody)});
  const u2 = await jfetch('/v1/institution/billing/usage', {method:'POST', headers: sh(U.a.s, {'idempotency-key':`uh2-${tag}`}), body: JSON.stringify(ubody)});
  rec('http_usage_meter_replay', u1.status===200 && u2.status===200 && u1.body?.usageId===u2.body?.usageId, {u1:{status:u1.status,body:u1.body}, u2:{status:u2.status,body:u2.body}});
  const u3 = await jfetch('/v1/institution/billing/usage', {method:'POST', headers: sh(U.a.s, {'idempotency-key':`uh3-${tag}`}), body: JSON.stringify({...ubody, quantityMinor:'6'})});
  rec('http_usage_meter_conflict', u3.status===409, {status:u3.status, body:u3.body});
} else {
  rec('institution_http_flows_skipped', false, {inst});
}

writeFileSync('docs/evidence/phase16-3/http-assurance.json', JSON.stringify(out, null, 2));
await admin.end();
console.log('done');
