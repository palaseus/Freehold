import 'reflect-metadata';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient } from 'redis';
import * as argon2 from 'argon2';
import { Secret, TOTP } from 'otpauth';
import type { LightMyRequestResponse } from 'fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { NestFactory } from '@nestjs/core';
import { createApplication } from '../src/bootstrap';
import { DatabaseService } from '../src/database/database.service';
import { RestrictedFunctions } from '../src/database/restricted-functions.service';
import type { Principal } from '../src/auth/auth.types';
import { WorkerModule } from '../src/worker/worker.module';
import { ReconciliationWorker } from '../src/worker/reconciliation.worker';
import { SessionService } from '../src/auth/session.service';
import { Pool } from 'pg';
import { assertRuntimePrivileges } from '../src/database/runtime-privileges';

const ids = { admin: randomUUID(), reviewer: randomUUID(), alice: randomUUID(), bob: randomUUID(), carol: randomUUID(), weakAdmin: randomUUID(),
  aliceAccount: randomUUID(), bobAccount: randomUUID(), carolAccount: randomUUID() };
const password = 'correct-horse-test-password';
const dbSecrets = { admin: randomBytes(32), reviewer: randomBytes(32), alice: randomBytes(32), bob: randomBytes(32) };
const adminSecret = new Secret({ size: 20 });
const reviewerSecret = new Secret({ size: 20 });
let app: NestFastifyApplication;
let adminDb: Client;
let runtime: Client;
let workerDb: Client;
let redis: ReturnType<typeof createClient>;
let alice: Login;
let bob: Login;
let admin: Login;
let reviewer: Login;
type Login = { cookie: string; csrf: string; token: string };
function envelope(secret: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(process.env.TOTP_ENCRYPTION_KEY!, 'base64'), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]);
}
async function login(email: string, totp?: string): Promise<Login> {
  const response = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password, ...(totp ? { totp } : {}) } });
  assert.equal(response.statusCode, 200, response.body);
  const header = response.headers['set-cookie'];
  const cookie = (Array.isArray(header) ? header[0]! : header!).split(';')[0]!;
  assert.match(cookie, /^freehold_session=/);
  assert.match(String(header), /HttpOnly/i);
  return { cookie, csrf: response.json().csrfToken, token: cookie.split('=')[1]! };
}
async function bindDbSession(userId: string, secret: Buffer, twoFactor: Date | null) {
  await adminDb.query('SELECT freehold.auth_bind_session($1::uuid,1,$2::bytea,$3::timestamptz,43200)', [userId, secret, twoFactor]);
}
function headers(session: Login, key: string = randomUUID()) {
  return { cookie: session.cookie, 'x-csrf-token': session.csrf, 'idempotency-key': key };
}
function transfer(source = ids.aliceAccount, amount: string | number = '25', destination = ids.bobAccount) {
  return { sourceAccountId: source, destinationAccountId: destination, currency: 'USD', amountMinor: amount };
}
async function sessionRecord(session: Login) {
  const key = `session:${createHash('sha256').update(session.token).digest('hex')}`;
  return { key, record: JSON.parse((await redis.get(key))!) };
}
async function governedAccountState(accountId: string, frozen: boolean, reason: string) {
  const requested = await app.inject({ method:'POST',url:`/v1/admin/accounts/${accountId}/${frozen?'freeze':'unfreeze'}`,
    headers:headers(admin),payload:{reason} });
  assert.equal(requested.statusCode,200,requested.body);
  const approved = await app.inject({ method:'POST',url:`/v1/admin/governance/requests/${requested.json().requestId}/approve`,headers:headers(reviewer),payload:{} });
  assert.equal(approved.statusCode,200,approved.body);
  const executed = await app.inject({ method:'POST',url:`/v1/admin/governance/requests/${requested.json().requestId}/execute`,headers:headers(admin,requested.json().requestId),payload:{} });
  assert.equal(executed.statusCode,200,executed.body);
  return {request:requested.json(),execution:executed.json()};
}

before(async () => {
  assert.ok(process.env.TEST_DATABASE_ADMIN_URL && process.env.WORKER_DATABASE_URL, 'Use npm test with disposable infrastructure');
  adminDb = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
  await adminDb.connect();
  await adminDb.query('UPDATE freehold.demo_settings SET enabled=true,bootstrap_hash=$1', [createHash('sha256').update(process.env.DEMO_BOOTSTRAP_TOKEN!).digest()]);
  const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
  for (const [id, email, role, secret] of [
    [ids.admin, 'admin@example.test', 'ADMIN', envelope(adminSecret.base32)],
    [ids.reviewer, 'reviewer@example.test', 'ADMIN', envelope(reviewerSecret.base32)],
    [ids.alice, 'alice@example.test', 'USER', null],
    [ids.bob, 'bob@example.test', 'USER', null],
    [ids.carol, 'carol@example.test', 'USER', null],
    [ids.weakAdmin, 'weak-admin@example.test', 'ADMIN', null],
  ]) await adminDb.query('INSERT INTO freehold.users(id,email_normalized,password_hash,role,totp_secret_encrypted) VALUES($1,$2,$3,$4,$5)', [id, email, hash, role, secret]);
  for (const [principal,capability] of [
    [ids.admin,'ACCOUNT_ADMIN'],[ids.admin,'SECURITY_ADMIN'],[ids.admin,'EMERGENCY_CONTROL'],
    [ids.reviewer,'FINANCIAL_REVIEWER'],[ids.reviewer,'INSTITUTION_ADMIN'],[ids.reviewer,'AUDITOR'],
  ]) await adminDb.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)',[principal,capability,'disposable integration fixture']);
  await adminDb.query("INSERT INTO freehold.currencies(code,name,minor_unit_exponent) VALUES('USD','US dollar',2),('EUR','Euro',2) ON CONFLICT DO NOTHING");
  // Account inserts must finish their automatically created deferred buckets.
  await adminDb.query('BEGIN');
  for (const [id, owner] of [[ids.aliceAccount, ids.alice], [ids.bobAccount, ids.bob], [ids.carolAccount, ids.carol]]) {
    await adminDb.query("INSERT INTO freehold.accounts(id,owner_user_id,currency_code) VALUES($1,$2,'USD')", [id, owner]);
  }
  await adminDb.query('COMMIT');
  await adminDb.query('UPDATE freehold.ledger_settings SET sandbox_enabled=true');
  await bindDbSession(ids.admin, dbSecrets.admin, new Date());
  await bindDbSession(ids.reviewer, dbSecrets.reviewer, new Date());
  await bindDbSession(ids.alice, dbSecrets.alice, null);
  await bindDbSession(ids.bob, dbSecrets.bob, null);
  runtime = new Client({ connectionString: process.env.DATABASE_URL });
  await runtime.connect();
  workerDb = new Client({ connectionString: process.env.WORKER_DATABASE_URL });
  await workerDb.connect();
  await runtime.query('BEGIN');
  await runtime.query(`SELECT set_config('freehold.session_secret',$1,true)`, [dbSecrets.admin.toString('hex')]);
  await runtime.query('SELECT freehold.sandbox_fund_account($1,$2,$3,$4,$5)', [ids.admin, ids.aliceAccount, '1000', 'fixture-fund', 'SANDBOX integration fixture']);
  await runtime.query('COMMIT');
  app = await createApplication();
  redis = createClient({ url: process.env.REDIS_URL });
  redis.on('error', () => undefined);
  await redis.connect();
  alice = await login('alice@example.test');
  bob = await login('bob@example.test');
  admin = await login('admin@example.test', new TOTP({ secret: adminSecret }).generate());
  reviewer = await login('reviewer@example.test', new TOTP({ secret: reviewerSecret }).generate());
}, { timeout: 30000 });
after(async () => {
  if (app) await app.close();
  if (redis?.isOpen) redis.destroy();
  if (runtime) await runtime.end();
  if (workerDb) await workerDb.end();
  if (adminDb) await adminDb.end();
});

test('user cannot debit someone else’s account through the guard or database', async () => {
  const response = await app.inject({ method: 'POST', url: '/v1/transfers', headers: headers(bob), payload: transfer() });
  assert.equal(response.statusCode, 403, response.body);
  await assert.rejects(runtime.query('SELECT freehold.execute_internal_transfer($1,$2,$3,$4,$5,$6)',
    [ids.bob, ids.aliceAccount, ids.bobAccount, 'USD', '1', randomUUID()]), { code: '42501' });
  const balance = await app.inject({ method: 'GET', url: `/v1/accounts/${ids.aliceAccount}/balances`, headers: { cookie: bob.cookie } });
  assert.equal(balance.statusCode, 403);
  const forged=await app.inject({method:'POST',url:`/v1/admin/accounts/${ids.aliceAccount}/freeze`,headers:headers(alice),payload:{reason:'Forged role claim',role:'ADMIN'}});
  assert.equal(forged.statusCode,403);
  const govRead=await app.inject({method:'GET',url:'/v1/admin/governance',headers:{cookie:alice.cookie}});
  assert.equal(govRead.statusCode,403);
});

test('freeze rejects transfers durably; unfreeze does not change a stored rejection', async () => {
  const frozen = await app.inject({ method: 'POST', url: `/v1/admin/accounts/${ids.aliceAccount}/freeze`, headers: headers(admin), payload: { reason: 'Integration freeze' } });
  assert.equal(frozen.statusCode, 200, frozen.body);
  assert.equal(frozen.json().status,'PENDING');
  const selfApproval = await app.inject({ method:'POST',url:`/v1/admin/governance/requests/${frozen.json().requestId}/approve`,headers:headers(admin),payload:{} });
  assert.equal(selfApproval.statusCode,403);
  const approval = await app.inject({ method:'POST',url:`/v1/admin/governance/requests/${frozen.json().requestId}/approve`,headers:headers(reviewer),payload:{} });
  assert.equal(approval.statusCode,200,approval.body);
  const execution = await app.inject({ method:'POST',url:`/v1/admin/governance/requests/${frozen.json().requestId}/execute`,headers:headers(admin,frozen.json().requestId),payload:{} });
  assert.equal(execution.statusCode,200,execution.body);
  assert.equal(execution.json().status,'EXECUTED');
  const key = randomUUID();
  const rejected = await app.inject({ method: 'POST', url: '/v1/transfers', headers: headers(alice, key), payload: transfer() });
  assert.equal(rejected.statusCode, 422, rejected.body);
  assert.equal(rejected.json().error, 'ACCOUNT_FROZEN');
  const result = await adminDb.query('SELECT count(*)::int AS count FROM freehold.ledger_journals WHERE operation_id=$1', [rejected.json().operationId]);
  assert.equal(result.rows[0].count, 0);
  const underlyingOperation = execution.json().result.operationId;
  const audit = await adminDb.query('SELECT count(*)::int AS count FROM freehold.admin_actions a JOIN freehold.audit_log l USING(operation_id) WHERE a.operation_id=$1', [underlyingOperation]);
  assert.equal(audit.rows[0].count, 1);
  const unfrozen = await app.inject({ method: 'POST', url: `/v1/admin/accounts/${ids.aliceAccount}/unfreeze`, headers: headers(admin), payload: { reason: 'Integration unfreeze' } });
  assert.equal(unfrozen.statusCode, 200, unfrozen.body);
  const unfreezeApproval=await app.inject({method:'POST',url:`/v1/admin/governance/requests/${unfrozen.json().requestId}/approve`,headers:headers(reviewer),payload:{}});
  assert.equal(unfreezeApproval.statusCode,200,unfreezeApproval.body);
  const unfreezeExecution=await app.inject({method:'POST',url:`/v1/admin/governance/requests/${unfrozen.json().requestId}/execute`,headers:headers(admin,unfrozen.json().requestId),payload:{}});
  assert.equal(unfreezeExecution.statusCode,200,unfreezeExecution.body);
  const replay = await app.inject({ method: 'POST', url: '/v1/transfers', headers: headers(alice, key), payload: transfer() });
  assert.equal(replay.statusCode, 422);
  assert.deepEqual(replay.json(), rejected.json());
});

test('governance rejects unscoped admins, request mutation, duplicate approvals, and runtime bypasses', async () => {
  const noScope=await app.inject({method:'POST',url:`/v1/admin/accounts/${ids.aliceAccount}/freeze`,headers:headers(reviewer),payload:{reason:'No account administration scope'}});
  assert.equal(noScope.statusCode,403);
  const first=await app.inject({method:'POST',url:`/v1/admin/accounts/${ids.aliceAccount}/freeze`,headers:headers(admin,'governance-payload-key'),payload:{reason:'Payload A'}});
  assert.equal(first.statusCode,200,first.body);
  const changed=await app.inject({method:'POST',url:`/v1/admin/accounts/${ids.bobAccount}/freeze`,headers:headers(admin,'governance-payload-key'),payload:{reason:'Payload A'}});
  assert.equal(changed.statusCode,409,changed.body);
  const approvals=await Promise.all([1,2].map(()=>app.inject({method:'POST',url:`/v1/admin/governance/requests/${first.json().requestId}/approve`,headers:headers(reviewer),payload:{}})));
  assert.equal(approvals.filter(x=>x.statusCode===200).length,1);
  assert.equal(approvals.filter(x=>x.statusCode===409).length,1);
  const double=await Promise.all([1,2].map(()=>app.inject({method:'POST',url:`/v1/admin/governance/requests/${first.json().requestId}/execute`,headers:headers(admin,first.json().requestId),payload:{}})));
  assert.deepEqual(double[0]!.json(),double[1]!.json());
  const requests=await adminDb.query('SELECT status,operation_id FROM freehold.governance_requests WHERE id=$1',[first.json().requestId]);
  assert.equal(requests.rows[0].status,'EXECUTED'); assert.ok(requests.rows[0].operation_id);
  const audit=await adminDb.query("SELECT count(*)::int AS count FROM freehold.governance_audit WHERE request_id=$1 AND event_type IN ('REQUESTED','APPROVED','EXECUTED')",[first.json().requestId]);
  assert.equal(audit.rows[0].count,3);
  await governedAccountState(ids.aliceAccount,false,'Restore test fixture account');
  await assert.rejects(workerDb.query('SELECT freehold.governance_decide($1,$2,$3)',[ids.reviewer,first.json().requestId,'APPROVE']),{code:'42501'});
  await assert.rejects(runtime.query('SELECT freehold.set_account_frozen($1,$2,true,$3,$4)',[ids.admin,ids.aliceAccount,randomUUID(),'bypass']),{code:'42501'});
  await assert.rejects(runtime.query('SELECT freehold.governance_create_account_request($1,$2,true,$3,$4)',[ids.weakAdmin,ids.aliceAccount,'No scope','no-scope-key']),{code:'42501'});
  await assert.rejects(runtime.query('SELECT freehold.governance_create_account_request($1,$2,true,$3,$4)',[ids.admin,ids.aliceAccount,'API identity trust boundary evidence','forged-actor-boundary']),{code:'42501'});
  await runtime.query('BEGIN');
  await runtime.query(`SELECT set_config('freehold.session_secret',$1,true)`, [dbSecrets.alice.toString('hex')]);
  await assert.rejects(runtime.query('SELECT freehold.governance_create_account_request($1,$2,true,$3,$4)',[ids.admin,ids.aliceAccount,'Cross-session actor','cross-session-actor']),{code:'42501'});
  await runtime.query('ROLLBACK');
  await runtime.query('BEGIN');
  await runtime.query(`SELECT set_config('freehold.session_secret',$1,true)`, [dbSecrets.admin.toString('hex')]);
  const forged = await runtime.query<{request: {requestId:string}}>('SELECT freehold.governance_create_account_request($1,$2,true,$3,$4) AS request',[ids.admin,ids.aliceAccount,'Bound admin session','bound-admin-boundary']);
  assert.ok(forged.rows[0]!.request.requestId);
  await runtime.query('SELECT freehold.governance_cancel($1,$2)',[ids.admin,forged.rows[0]!.request.requestId]);
  await runtime.query('COMMIT');
});

test('revoked approvals and expired requests cannot authorize execution', async () => {
  const revoked=await app.inject({method:'POST',url:`/v1/admin/accounts/${ids.aliceAccount}/freeze`,headers:headers(admin),payload:{reason:'Revocation test'}});
  await adminDb.query('SELECT freehold.governance_provision_capability($1,$2,$3,false)',[ids.reviewer,'FINANCIAL_REVIEWER','revocation test']);
  const denied=await app.inject({method:'POST',url:`/v1/admin/governance/requests/${revoked.json().requestId}/approve`,headers:headers(reviewer),payload:{}});
  assert.equal(denied.statusCode,403);
  await adminDb.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)',[ids.reviewer,'FINANCIAL_REVIEWER','revocation test restored']);
  const expired=await app.inject({method:'POST',url:`/v1/admin/accounts/${ids.aliceAccount}/freeze`,headers:headers(admin),payload:{reason:'Expiry test'}});
  await adminDb.query('BEGIN');
  await adminDb.query('ALTER TABLE freehold.governance_requests DISABLE TRIGGER governance_requests_immutable');
  await adminDb.query("UPDATE freehold.governance_requests SET expires_at=created_at+interval '1 millisecond' WHERE id=$1",[expired.json().requestId]);
  await adminDb.query('ALTER TABLE freehold.governance_requests ENABLE TRIGGER governance_requests_immutable');
  await adminDb.query('COMMIT');
  await new Promise(resolve=>setTimeout(resolve,10));
  const expiration=await app.inject({method:'POST',url:`/v1/admin/governance/requests/${expired.json().requestId}/approve`,headers:headers(reviewer),payload:{}});
  assert.equal(expiration.statusCode,200,expiration.body); assert.equal(expiration.json().status,'EXPIRED');
  const execute=await app.inject({method:'POST',url:`/v1/admin/governance/requests/${expired.json().requestId}/execute`,headers:headers(admin,expired.json().requestId),payload:{}});
  assert.equal(execute.statusCode,409);
  const rejected=await app.inject({method:'POST',url:`/v1/admin/accounts/${ids.aliceAccount}/freeze`,headers:headers(admin),payload:{reason:'Reject test'}});
  const reject=await app.inject({method:'POST',url:`/v1/admin/governance/requests/${rejected.json().requestId}/reject`,headers:headers(reviewer),payload:{}});
  assert.equal(reject.statusCode,200);
  const noExecute=await app.inject({method:'POST',url:`/v1/admin/governance/requests/${rejected.json().requestId}/execute`,headers:headers(admin,rejected.json().requestId),payload:{}});
  assert.equal(noExecute.statusCode,409);
  const approvalRevocation=await app.inject({method:'POST',url:`/v1/admin/accounts/${ids.aliceAccount}/freeze`,headers:headers(admin),payload:{reason:'Execution-time revocation test'}});
  const approved=await app.inject({method:'POST',url:`/v1/admin/governance/requests/${approvalRevocation.json().requestId}/approve`,headers:headers(reviewer),payload:{}});
  assert.equal(approved.statusCode,200);
  await adminDb.query('SELECT freehold.governance_provision_capability($1,$2,$3,false)',[ids.reviewer,'FINANCIAL_REVIEWER','execution revocation test']);
  const blockedExecute=await app.inject({method:'POST',url:`/v1/admin/governance/requests/${approvalRevocation.json().requestId}/execute`,headers:headers(admin,approvalRevocation.json().requestId),payload:{}});
  assert.equal(blockedExecute.statusCode,403);
  await adminDb.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)',[ids.reviewer,'FINANCIAL_REVIEWER','execution revocation test restored']);
  const allowedExecute=await app.inject({method:'POST',url:`/v1/admin/governance/requests/${approvalRevocation.json().requestId}/execute`,headers:headers(admin,approvalRevocation.json().requestId),payload:{}});
  assert.equal(allowedExecute.statusCode,200,allowedExecute.body);
  await governedAccountState(ids.aliceAccount,false,'Restore fixture after revocation test');
});

test('one principal holding two scopes still cannot satisfy two approval requirements', async () => {
  const request=await app.inject({method:'POST',url:`/v1/admin/accounts/${ids.carolAccount}/freeze`,headers:headers(admin),payload:{reason:'Multi-scope separation test'}});
  assert.equal(request.statusCode,200,request.body);
  await adminDb.query('INSERT INTO freehold.governance_approval_requirements(request_id,capability,required_count) VALUES($1,$2,1)',[request.json().requestId,'INSTITUTION_ADMIN']);
  const first=await app.inject({method:'POST',url:`/v1/admin/governance/requests/${request.json().requestId}/approve`,headers:headers(reviewer),payload:{}});
  assert.equal(first.statusCode,200,first.body); assert.equal(first.json().status,'PENDING');
  const second=await app.inject({method:'POST',url:`/v1/admin/governance/requests/${request.json().requestId}/approve`,headers:headers(reviewer),payload:{}});
  assert.equal(second.statusCode,409,second.body);
  const recorded=await adminDb.query('SELECT count(DISTINCT principal_id)::int AS principals,count(*)::int AS decisions FROM freehold.governance_decisions WHERE request_id=$1',[request.json().requestId]);
  assert.equal(recorded.rows[0].principals,1); assert.equal(recorded.rows[0].decisions,1);
  await app.inject({method:'POST',url:`/v1/admin/governance/requests/${request.json().requestId}/cancel`,headers:headers(admin),payload:{}});
});

test('concurrent duplicate keys return the identical original response; changed payload is 409', async () => {
  const key = randomUUID();
  const [first, duplicate] = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/v1/transfers', headers: headers(alice, key), payload: transfer() })));
  assert.ok(first && duplicate);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.deepEqual(duplicate.json(), first.json());
  const rows = await adminDb.query('SELECT count(*)::int AS count FROM freehold.ledger_journals WHERE operation_id=$1', [first.json().operationId]);
  assert.equal(rows.rows[0].count, 1);
  const conflict = await app.inject({ method: 'POST', url: '/v1/transfers', headers: headers(alice, key), payload: transfer(ids.aliceAccount, '26') });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json().code, 'IDEMPOTENCY_CONFLICT');
});

test('concurrent conflicting payloads for one key commit at most one request', async () => {
  const key = randomUUID();
  const responses = await Promise.all(['2', '3'].map(amount => app.inject({ method: 'POST', url: '/v1/transfers',
    headers: headers(alice, key), payload: transfer(ids.aliceAccount, amount) })));
  const committed = responses.filter(response => response.statusCode === 200);
  const conflict = responses.filter(response => response.statusCode === 409);
  assert.equal(committed.length, 1);
  assert.equal(conflict.length, 1);
  assert.equal(conflict[0]!.json().code, 'IDEMPOTENCY_CONFLICT');
  const rows = await adminDb.query('SELECT count(*)::int AS count FROM freehold.ledger_journals WHERE operation_id=$1', [committed[0]!.json().operationId]);
  assert.equal(rows.rows[0].count, 1);
});

test('identical-key replay recovers a committed result after simulated lost acknowledgment', async () => {
  const key = randomUUID(); const correlation = randomUUID();
  await runtime.query('BEGIN');
  await runtime.query(`SELECT set_config('freehold.session_secret',$1,true)`, [dbSecrets.alice.toString('hex')]);
  const original = await runtime.query<{ body: unknown }>(
    'SELECT freehold.execute_internal_transfer($1,$2,$3,$4,$5,$6,$7) AS body',
    [ids.alice, ids.aliceAccount, ids.bobAccount, 'USD', '1', key, correlation]);
  await runtime.query('COMMIT');
  // Deliberately discard the first result as if the TCP acknowledgment was lost.
  const replay = await app.inject({ method: 'POST', url: '/v1/transfers', headers: headers(alice, key), payload: transfer(ids.aliceAccount, '1') });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json(), original.rows[0]!.body);
  const count = await adminDb.query('SELECT count(*)::int AS count FROM freehold.ledger_journals WHERE operation_id=$1', [replay.json().operationId]);
  assert.equal(count.rows[0].count, 1);
});

test('application login has no direct write privileges and no private helper access', async () => {
  const grants = await runtime.query(`SELECT bool_and(NOT has_table_privilege(current_user,c.oid,'INSERT')
    AND NOT has_table_privilege(current_user,c.oid,'UPDATE') AND NOT has_table_privilege(current_user,c.oid,'DELETE')
    AND NOT has_table_privilege(current_user,c.oid,'TRUNCATE')) AS restricted
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='freehold' AND c.relkind='r'`);
  assert.equal(grants.rows[0].restricted, true);
  await assert.rejects(runtime.query('UPDATE freehold.accounts SET available_minor=0 WHERE id=$1', [ids.aliceAccount]), { code: '42501' });
  await assert.rejects(runtime.query("DELETE FROM freehold.ledger_entries"), { code: '42501' });
  await assert.rejects(runtime.query("INSERT INTO freehold.ledger_journals DEFAULT VALUES"), { code: '42501' });
  await assert.rejects(runtime.query('SELECT id FROM freehold.accounts'), { code: '42501' });
  await assert.rejects(runtime.query('SELECT id FROM freehold.ledger_journals'), { code: '42501' });
  await assert.rejects(runtime.query('SELECT operation_id FROM freehold.idempotency_requests'), { code: '42501' });
  await assert.rejects(runtime.query('SELECT * FROM freehold.users'), { code: '42501' });
  await assert.rejects(runtime.query("SELECT freehold._actor($1)", [ids.alice]), { code: '42501' });
});

test('API and worker database identities have disjoint explicit privileges', async () => {
  const legacy = await adminDb.query("SELECT r.rolcanlogin,pg_has_role('freehold_runtime','freehold_app','MEMBER') AS app_member FROM pg_roles r WHERE r.rolname='freehold_runtime'");
  assert.equal(legacy.rows[0].rolcanlogin, false);
  assert.equal(legacy.rows[0].app_member, false);
  const apiMembership = await runtime.query("SELECT pg_has_role(current_user,'freehold_app','MEMBER') AS member");
  const workerMembership = await workerDb.query("SELECT pg_has_role(current_user,'freehold_app','MEMBER') AS member");
  assert.equal(apiMembership.rows[0].member, false);
  assert.equal(workerMembership.rows[0].member, false);
  await assert.rejects(workerDb.query('SELECT freehold.execute_internal_transfer($1,$2,$3,$4,$5,$6)',
    [ids.alice, ids.aliceAccount, ids.bobAccount, 'USD', '1', randomUUID()]), { code: '42501' });
  await assert.rejects(workerDb.query('SELECT freehold.sandbox_fund_account($1,$2,$3,$4,$5)',
    [ids.admin, ids.aliceAccount, '1', randomUUID(), 'forbidden worker funding']), { code: '42501' });
  await assert.rejects(workerDb.query('SELECT * FROM freehold.accounts'), { code: '42501' });
  await assert.rejects(runtime.query('SELECT freehold.worker_claim_outbox($1,$2,$3)', [randomUUID(), 1, 5]), { code: '42501' });
  await assert.rejects(runtime.query('SELECT freehold.worker_reconcile_and_record()'), { code: '42501' });
  await assert.rejects(runtime.query('INSERT INTO freehold.reconciliation_runs(reconciliation_id,balanced,report) VALUES($1,true,$2)',
    [randomUUID(), { balanced: true }]), { code: '42501' });
  await assert.rejects(workerDb.query("SELECT freehold.worker_record_reconciliation('{}'::jsonb)"), { code: '42883' });
});

test('runtime startup assertions reject extra direct and inherited privileges', async () => {
  const apiPool = new Pool({ connectionString: process.env.DATABASE_URL });
  const workerPool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL });
  const schedulerPool = new Pool({ connectionString: process.env.SCHEDULER_DATABASE_URL });
  const apiClient = await apiPool.connect();
  const workerClient = await workerPool.connect();
  const schedulerClient = await schedulerPool.connect();
  try {
    await adminDb.query('GRANT UPDATE ON freehold.users TO freehold_api');
    await assert.rejects(assertRuntimePrivileges(apiClient, 'api'), /least-privilege/);
    await adminDb.query('REVOKE UPDATE ON freehold.users FROM freehold_api');
    await assertRuntimePrivileges(apiClient, 'api');
    await adminDb.query('GRANT EXECUTE ON FUNCTION freehold.execute_internal_transfer(uuid,uuid,uuid,text,bigint,text,uuid) TO freehold_worker');
    await assert.rejects(assertRuntimePrivileges(workerClient, 'worker'), /least-privilege/);
    await adminDb.query('REVOKE EXECUTE ON FUNCTION freehold.execute_internal_transfer(uuid,uuid,uuid,text,bigint,text,uuid) FROM freehold_worker');
    await assertRuntimePrivileges(workerClient, 'worker');
    await assertRuntimePrivileges(schedulerClient, 'scheduler');
  } finally {
    apiClient.release(); workerClient.release(); schedulerClient.release();
    await apiPool.end(); await workerPool.end(); await schedulerPool.end();
  }
});

test('rate limits are isolated by account across the shared web proxy', async () => {
  const sessions = app.get(SessionService);
  const exhausted = 'proxy-shared-limit@example.test';
  for (let attempt = 0; attempt < 10; attempt++) await sessions.throttleLogin(exhausted);
  let limited = false;
  try { await sessions.throttleLogin(exhausted); }
  catch (error) { limited = typeof error === 'object' && error !== null && 'getStatus' in error && (error as { getStatus: () => number }).getStatus() === 429; }
  assert.equal(limited, true);
  await sessions.throttleLogin('independent-proxy-client@example.test');
});

test('monetary values stay strings, numeric and noncanonical amounts are rejected', async () => {
  for (const amount of [25, '0', '-1', '1.5', '01', '1e3', '10000000000000000000']) {
    const response = await app.inject({ method: 'POST', url: '/v1/transfers', headers: headers(alice), payload: transfer(ids.aliceAccount, amount) });
    assert.equal(response.statusCode, 400, response.body);
  }
  const balances = await app.inject({ method: 'GET', url: `/v1/accounts/${ids.aliceAccount}/balances`, headers: { cookie: alice.cookie } });
  assert.equal(balances.statusCode, 200, balances.body);
  assert.equal(typeof balances.json().availableMinor, 'string');
  assert.equal(typeof balances.json().reservedMinor, 'string');
  const created = await app.inject({ method: 'POST', url: '/v1/accounts', headers: headers(alice), payload: { currency: 'EUR' } });
  assert.equal(created.statusCode, 200, created.body);
  const buckets = await adminDb.query('SELECT count(*)::int AS count FROM freehold.ledger_accounts WHERE customer_account_id=$1', [created.json().accountId]);
  assert.equal(buckets.rows[0].count, 2);
  const list = await app.inject({ method: 'GET', url: '/v1/accounts', headers: { cookie: alice.cookie } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 2);
});

test('destination validation is uniform while restricted audit metadata keeps the reason', async () => {
  const eur = await app.inject({ method: 'POST', url: '/v1/accounts', headers: headers(bob), payload: { currency: 'EUR' } });
  assert.equal(eur.statusCode, 200, eur.body);
  const missing = await app.inject({ method: 'POST', url: '/v1/transfers', headers: headers(alice),
    payload: transfer(ids.aliceAccount, '1', randomUUID()) });
  const wrongCurrency = await app.inject({ method: 'POST', url: '/v1/transfers', headers: headers(alice),
    payload: transfer(ids.aliceAccount, '1', eur.json().accountId) });
  assert.equal(missing.statusCode, 422);
  assert.equal(wrongCurrency.statusCode, 422);
  assert.equal(missing.json().error, 'DESTINATION_UNAVAILABLE');
  assert.equal(wrongCurrency.json().error, 'DESTINATION_UNAVAILABLE');
  const missingDiagnostic = await adminDb.query('SELECT metadata->>\'internalFailureCode\' AS reason FROM freehold.audit_log WHERE operation_id=$1', [missing.json().operationId]);
  const currencyDiagnostic = await adminDb.query('SELECT metadata->>\'internalFailureCode\' AS reason FROM freehold.audit_log WHERE operation_id=$1', [wrongCurrency.json().operationId]);
  assert.equal(missingDiagnostic.rows[0].reason, 'DESTINATION_NOT_FOUND');
  assert.equal(currencyDiagnostic.rows[0].reason, 'DESTINATION_CURRENCY_MISMATCH');

  const freeze = await governedAccountState(ids.bobAccount,true,'Destination privacy test');
  const frozenDestination = await app.inject({ method: 'POST', url: '/v1/transfers', headers: headers(alice),
    payload: transfer(ids.aliceAccount, '1', ids.bobAccount) });
  assert.equal(frozenDestination.statusCode, 422);
  assert.equal(frozenDestination.json().error, 'DESTINATION_UNAVAILABLE');
  const frozenDiagnostic = await adminDb.query('SELECT metadata->>\'internalFailureCode\' AS reason FROM freehold.audit_log WHERE operation_id=$1', [frozenDestination.json().operationId]);
  assert.equal(frozenDiagnostic.rows[0].reason, 'DESTINATION_FROZEN');
  await governedAccountState(ids.bobAccount,false,'Destination privacy test complete');
});

test('admin requires recent enrolled 2FA and a reason; TOTP cannot be replayed', async () => {
  const noTotp = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@example.test', password } });
  assert.equal(noTotp.statusCode, 401);
  const weakAdmin = await login('weak-admin@example.test');
  const forbidden = await app.inject({ method: 'POST', url: `/v1/admin/accounts/${ids.bobAccount}/freeze`, headers: headers(weakAdmin), payload: { reason: 'test' } });
  assert.equal(forbidden.statusCode, 403);
  const noReason = await app.inject({ method: 'POST', url: `/v1/admin/accounts/${ids.bobAccount}/freeze`, headers: headers(admin), payload: { reason: '  ' } });
  assert.equal(noReason.statusCode, 400);
  const data = await sessionRecord(admin);
  await redis.set(data.key, JSON.stringify({ ...data.record, twoFactorAt: Date.now() - 6 * 60 * 1000 }), { EX: 3600 });
  const stale = await app.inject({ method: 'POST', url: `/v1/admin/accounts/${ids.bobAccount}/freeze`, headers: headers(admin), payload: { reason: 'test' } });
  assert.equal(stale.statusCode, 403);
  await redis.set(data.key, JSON.stringify(data.record), { EX: 3600 });
  // A fixed future-window code is consumed once; repeating it is rejected.
  const token = new TOTP({ secret: adminSecret }).generate({ timestamp: Date.now() + 30000 });
  const accepted = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@example.test', password, totp: token } });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const replay = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@example.test', password, totp: token } });
  assert.equal(replay.statusCode, 401, replay.body);
});

test('session revocation is checked against PostgreSQL and repeated inside the transaction', async () => {
  const carol = await login('carol@example.test');
  const session = (await sessionRecord(carol)).record;
  const principal: Principal = { user: { id: ids.carol, role: 'USER', status: 'ACTIVE', auth_version: session.authVersion, two_factor_enabled: false }, session };
  await adminDb.query('UPDATE freehold.users SET auth_version=auth_version+1 WHERE id=$1', [ids.carol]);
  const rejected = await app.inject({ method: 'GET', url: '/v1/accounts', headers: { cookie: carol.cookie } });
  assert.equal(rejected.statusCode, 401);
  await assert.rejects(app.get(DatabaseService).transaction(principal, c => app.get(RestrictedFunctions).createAccount(c, ids.carol, 'EUR', randomUUID(), randomUUID())), { status: 401 });
});

test('CSRF is enforced and logout invalidates the Redis session', async () => {
  const response = await app.inject({ method: 'POST', url: '/v1/transfers', headers: { cookie: alice.cookie, 'idempotency-key': randomUUID() }, payload: transfer() });
  assert.equal(response.statusCode, 403);
  const csrfUnicode = await app.inject({ method: 'POST', url: '/v1/transfers', headers: { ...headers(alice), 'x-csrf-token': 'é'.repeat(43) }, payload: transfer() });
  assert.equal(csrfUnicode.statusCode, 403);
  const crossOrigin = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { origin: 'https://attacker.test' }, payload: { email: 'alice@example.test', password } });
  assert.equal(crossOrigin.statusCode, 403);
  const logout = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: headers(bob) });
  assert.equal(logout.statusCode, 204);
  const afterLogout = await app.inject({ method: 'GET', url: '/v1/accounts', headers: { cookie: bob.cookie } });
  assert.equal(afterLogout.statusCode, 401);
});

test('liveness and readiness are process probes, not a deployment certificate', async () => {
  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.statusCode, 200, health.body);
  assert.equal(health.json().status, 'live');
  const ready = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(ready.statusCode, 200, ready.body);
  assert.equal(ready.json().status, 'accepting');
  assert.equal(String(ready.headers['cache-control']), 'no-store');
});

test('OpenAPI documents the required operations and idempotency header', async () => {
  const response = await app.inject({ method: 'GET', url: '/openapi.json' });
  assert.equal(response.statusCode, 200, response.body);
  const paths = response.json().paths;
  for (const path of ['/v1/accounts', '/v1/accounts/{id}/balances', '/v1/transfers', '/v1/admin/accounts/{id}/freeze', '/v1/admin/accounts/{id}/unfreeze']) assert.ok(paths[path], path);
  assert.ok(paths['/v1/transfers'].post.parameters.some((p: { name: string }) => p.name === 'Idempotency-Key'));
  assert.ok(paths['/v1/transfers'].post.responses['422']);
});


test('public registration creates USER only, supports TOTP, and exposes safe session/currency metadata', async () => {
  const secret = new Secret({ size: 20 });
  const email = 'new-user@example.test';
  const created = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password, totpSecret: secret.base32, totp: new TOTP({ secret }).generate() } });
  assert.equal(created.statusCode, 201, created.body);
  const duplicate = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password } });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().code, 'EMAIL_UNAVAILABLE');
  const privilegeAttempt = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'hacker@example.test', password, role: 'ADMIN' } });
  assert.equal(privilegeAttempt.statusCode, 400);
  const noTotp = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
  assert.equal(noTotp.statusCode, 401);
  const registered = await login(email, new TOTP({ secret }).generate());
  const session = await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: registered.cookie } });
  assert.equal(session.statusCode, 200, session.body);
  assert.equal(session.json().user.role, 'USER');
  assert.equal(session.json().user.email, email);
  assert.equal(session.json().user.twoFactorEnabled, true);
  assert.equal(session.json().csrfToken, registered.csrf);
  assert.ok(!session.body.includes('password_hash'));
  const currencies = await app.inject({ method: 'GET', url: '/v1/currencies', headers: { cookie: registered.cookie } });
  assert.equal(currencies.statusCode, 200);
  assert.equal(currencies.json().find((c: { code: string }) => c.code === 'USD').minorUnitExponent, 2);
});

test('owned history uses microsecond-safe cursor pagination without duplicate or missing entries', async () => {
  for (let index=0; index<3; index++) {
    const response = await app.inject({ method: 'POST', url: '/v1/transfers', headers: headers(alice), payload: transfer(ids.aliceAccount, '1') });
    assert.equal(response.statusCode, 200, response.body);
  }
  const seen = new Set<string>();
  let cursor: string|null = null;
  do {
    const response: LightMyRequestResponse = await app.inject({ method: 'GET', url: `/v1/accounts/${ids.aliceAccount}/transactions?limit=1${cursor ? '&cursor='+encodeURIComponent(cursor) : ''}`, headers: { cookie: alice.cookie } });
    assert.equal(response.statusCode, 200, response.body);
    const page: {items: {id: string; amountMinor: string}[]; nextCursor: string|null} = response.json();
    for (const item of page.items) { assert.ok(!seen.has(item.id)); seen.add(item.id); assert.equal(typeof item.amountMinor, 'string'); }
    cursor = page.nextCursor;
    if (cursor) assert.match(JSON.parse(Buffer.from(cursor, 'base64url').toString()).time, /\.\d{6}Z$/);
  } while (cursor);
  const count = await adminDb.query('SELECT count(*)::int AS count FROM freehold.ledger_entries e JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id WHERE la.customer_account_id=$1', [ids.aliceAccount]);
  assert.equal(seen.size, count.rows[0].count);
  const other = await app.inject({ method: 'GET', url: `/v1/accounts/${ids.bobAccount}/transactions`, headers: { cookie: alice.cookie } });
  assert.equal(other.statusCode, 403);
  const invalid = await app.inject({ method: 'GET', url: `/v1/accounts/${ids.aliceAccount}/transactions?cursor=invalid`, headers: { cookie: alice.cookie } });
  assert.equal(invalid.statusCode, 400);
  const badDate = Buffer.from(JSON.stringify({account: ids.aliceAccount, time: '2026-02-30T00:00:00.000000Z', id: randomUUID()})).toString('base64url');
  const invalidDate = await app.inject({ method: 'GET', url: `/v1/accounts/${ids.aliceAccount}/transactions?cursor=${badDate}`, headers: { cookie: alice.cookie } });
  assert.equal(invalidDate.statusCode, 400);
});

test('demo bootstrap is token-gated and sandbox funding remains admin/2FA/idempotency controlled', async () => {
  const noToken = await app.inject({ method: 'POST', url: '/v1/demo/bootstrap', payload: { email: 'demo-op@example.test', password } });
  assert.equal(noToken.statusCode, 401);
  const notAdmin = await app.inject({ method: 'POST', url: `/v1/demo/accounts/${ids.aliceAccount}/fund`, headers: headers(alice), payload: { amountMinor: '1', reason: 'test' } });
  assert.equal(notAdmin.statusCode, 403);
  await adminDb.query('UPDATE freehold.ledger_settings SET sandbox_enabled=false WHERE singleton');
  await runtime.query('BEGIN');
  await runtime.query(`SELECT set_config('freehold.session_secret',$1,true)`, [dbSecrets.admin.toString('hex')]);
  const outsideDemo=await runtime.query<{result: {state:string;error:string}}>('SELECT freehold.sandbox_fund_account($1,$2,1,$3,$4,$5) AS result',
    [ids.admin,ids.aliceAccount,'sandbox-disabled-test','Should remain inactive',randomUUID()]);
  await runtime.query('COMMIT');
  assert.equal(outsideDemo.rows[0]!.result.state,'REJECTED'); assert.equal(outsideDemo.rows[0]!.result.error,'SANDBOX_DISABLED');
  await adminDb.query('UPDATE freehold.ledger_settings SET sandbox_enabled=true WHERE singleton');
  const funded = await app.inject({ method: 'POST', url: `/v1/demo/accounts/${ids.aliceAccount}/fund`, headers: headers(admin, 'demo-test-fund'), payload: { amountMinor: '1', reason: 'SANDBOX fixture' } });
  assert.equal(funded.statusCode, 200, funded.body);
  assert.equal(funded.json().sandbox, true);
  const replay = await app.inject({ method: 'POST', url: `/v1/demo/accounts/${ids.aliceAccount}/fund`, headers: headers(admin, 'demo-test-fund'), payload: { amountMinor: '1', reason: 'SANDBOX fixture' } });
  assert.deepEqual(replay.json(), funded.json());
  const accounts = await app.inject({ method: 'GET', url: '/v1/admin/accounts', headers: { cookie: admin.cookie } });
  assert.equal(accounts.statusCode, 200, accounts.body);
  assert.ok(accounts.json().some((a: {ownerEmail:string}) => a.ownerEmail === 'alice@example.test'));
  const userList = await app.inject({ method: 'GET', url: '/v1/admin/accounts', headers: { cookie: alice.cookie } });
  assert.equal(userList.statusCode, 403);
});

test('worker claims are exclusive, expired leases redeliver, and abandoned work recovers after restart', async () => {
  const a = randomUUID(); const b = randomUUID(); const c = randomUUID();
  const workerA = new Client({ connectionString: process.env.WORKER_DATABASE_URL });
  const workerB = new Client({ connectionString: process.env.WORKER_DATABASE_URL });
  const workerC = new Client({ connectionString: process.env.WORKER_DATABASE_URL });
  await Promise.all([workerA.connect(), workerB.connect(), workerC.connect()]);
  try {
    await workerA.query('BEGIN');
    const first = await workerA.query<{ event_id: string; attempt_count: number }>(
      'SELECT event_id,attempt_count FROM freehold.worker_claim_outbox($1,1,30)', [a]);
    assert.equal(first.rowCount, 1, 'fixture operations leave durable outbox work');
    const lockedEvent = first.rows[0]!.event_id;
    const competing = await workerB.query<{ event_id: string; attempt_count: number }>(
      'SELECT event_id,attempt_count FROM freehold.worker_claim_outbox($1,100,30)', [b]);
    assert.ok(!competing.rows.some(row => row.event_id === lockedEvent), 'SKIP LOCKED keeps the same event exclusive');
    await workerA.query('COMMIT');
    const foreignBatch = await workerB.query<{ completed: string[] }>('SELECT freehold.worker_complete_outbox_batch($1,$2::uuid[]) AS completed', [b, [lockedEvent]]);
    assert.deepEqual(foreignBatch.rows[0]!.completed ?? [], [], 'a batch acknowledgement cannot complete another worker lease');

    await adminDb.query("UPDATE freehold.worker_inbox SET lease_until=clock_timestamp()-interval '1 second' WHERE event_id=$1 AND worker_id=$2", [lockedEvent, a]);
    const reclaimed = await workerB.query<{ event_id: string; attempt_count: number }>(
      'SELECT event_id,attempt_count FROM freehold.worker_claim_outbox($1,100,30)', [b]);
    const redelivery = reclaimed.rows.find(row => row.event_id === lockedEvent);
    assert.ok(redelivery, 'an expired claim is delivered again');
    assert.equal(redelivery.attempt_count, first.rows[0]!.attempt_count + 1);
    const staleAck = await workerA.query<{ completed: boolean }>('SELECT freehold.worker_complete_outbox($1,$2) AS completed', [a, lockedEvent]);
    assert.equal(staleAck.rows[0]!.completed, false, 'the former lease owner cannot acknowledge after reclaim');
    const ack = await workerB.query<{ completed: boolean }>('SELECT freehold.worker_complete_outbox($1,$2) AS completed', [b, lockedEvent]);
    assert.equal(ack.rows[0]!.completed, true);

    // Simulate a process restart after claim/commit but before acknowledgment.
    await adminDb.query("UPDATE freehold.worker_inbox SET lease_until=clock_timestamp()-interval '1 second' WHERE worker_id=$1 AND status='PROCESSING'", [b]);
    const recovered = await workerC.query<{ event_id: string; attempt_count: number }>(
      'SELECT event_id,attempt_count FROM freehold.worker_claim_outbox($1,100,30)', [c]);
    assert.ok(recovered.rows.length > 0, 'a replacement worker recovers abandoned leases');
    for (const event of recovered.rows) {
      const oldAck = await workerB.query<{ completed: boolean }>('SELECT freehold.worker_complete_outbox($1,$2) AS completed', [b, event.event_id]);
      assert.equal(oldAck.rows[0]!.completed, false);
      const newAck = await workerC.query<{ completed: boolean }>('SELECT freehold.worker_complete_outbox($1,$2) AS completed', [c, event.event_id]);
      assert.equal(newAck.rows[0]!.completed, true);
    }
  } finally {
    await workerA.query('ROLLBACK').catch(() => undefined);
    await Promise.all([workerA.end(), workerB.end(), workerC.end()]);
  }
});

test('worker consumes a transfer outbox event and reconciles balanced ledger totals', async () => {
  const workerApp = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  try {
    const worker = workerApp.get(ReconciliationWorker);
    const transferResponse = await app.inject({ method: 'POST', url: '/v1/transfers', headers: headers(alice), payload: transfer(ids.aliceAccount, '1') });
    assert.equal(transferResponse.statusCode, 200, transferResponse.body);
    const operationId = transferResponse.json().operationId as string;

    let processed = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const inbox = await adminDb.query(`SELECT 1 FROM freehold.outbox_events o
        JOIN freehold.worker_inbox i ON i.event_id=o.id
        WHERE o.operation_id=$1 AND i.status='PROCESSED' AND o.dispatched_at IS NOT NULL`, [operationId]);
      if (inbox.rowCount) { processed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(processed, 'worker should durably consume and acknowledge the transfer outbox event');

    const report = await worker.runReconciliation();
    assert.equal(report.balanced, true, JSON.stringify(report));
    assert.equal(report.debitsEqualCredits, true);
    const usd = report.totalsByCurrency.find(total => total.currency === 'USD');
    assert.ok(usd);
    assert.equal(usd.debits, usd.credits);

    const latest = await app.inject({ method: 'GET', url: '/v1/admin/reconciliation/latest', headers: { cookie: admin.cookie } });
    assert.equal(latest.statusCode, 200, latest.body);
    assert.equal(latest.json().balanced, true);
    assert.ok(latest.json().checkedAt);
    const audit = await app.inject({ method: 'GET', url: '/v1/admin/audit-events?limit=20', headers: { cookie: admin.cookie } });
    assert.equal(audit.statusCode, 200, audit.body);
    assert.ok(Array.isArray(audit.json()));
  } finally {
    await workerApp.close();
  }
});

test('reconciliation detects disposable projection corruption and keeps durable mismatch evidence', async () => {
  // TEST ONLY: intentional projection fault injection inside this throwaway DB.
  await adminDb.query('BEGIN');
  await adminDb.query('ALTER TABLE freehold.accounts DISABLE TRIGGER account_projection');
  await adminDb.query('UPDATE freehold.accounts SET available_minor=available_minor+1 WHERE id=$1', [ids.aliceAccount]);
  await adminDb.query('ALTER TABLE freehold.accounts ENABLE TRIGGER account_projection');
  await adminDb.query('COMMIT');

  await workerDb.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const mismatch = await workerDb.query<{ report: { balanced: boolean; projectionMismatchCount: number; reconciliationId: string; checkedAt: string } }>(
    'SELECT freehold.worker_reconcile_and_record() AS report');
  await workerDb.query('COMMIT');
  assert.equal(mismatch.rows[0]!.report.balanced, false);
  assert.ok(mismatch.rows[0]!.report.projectionMismatchCount > 0);
  assert.ok(mismatch.rows[0]!.report.reconciliationId);
  assert.ok(mismatch.rows[0]!.report.checkedAt);
  const latest = await app.inject({ method: 'GET', url: '/v1/admin/reconciliation/latest', headers: { cookie: admin.cookie } });
  assert.equal(latest.statusCode, 200, latest.body);
  assert.equal(latest.json().reconciliationId, mismatch.rows[0]!.report.reconciliationId);
  assert.equal(latest.json().balanced, false);
  const audit = await adminDb.query("SELECT count(*)::int AS count FROM freehold.audit_log WHERE event_type='LEDGER_RECONCILIATION_MISMATCH' AND resource_id=$1", [mismatch.rows[0]!.report.reconciliationId]);
  assert.equal(audit.rows[0].count, 1);

  // Restore the disposable fixture projection; a later real run may report
  // balanced, but it cannot erase the immutable mismatch audit entry.
  await adminDb.query('BEGIN');
  await adminDb.query('ALTER TABLE freehold.accounts DISABLE TRIGGER account_projection');
  await adminDb.query('UPDATE freehold.accounts SET available_minor=available_minor-1 WHERE id=$1', [ids.aliceAccount]);
  await adminDb.query('ALTER TABLE freehold.accounts ENABLE TRIGGER account_projection');
  await adminDb.query('COMMIT');
  await workerDb.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const repaired = await workerDb.query<{ report: { balanced: boolean } }>('SELECT freehold.worker_reconcile_and_record() AS report');
  await workerDb.query('COMMIT');
  assert.equal(repaired.rows[0]!.report.balanced, true);
  const retained = await adminDb.query("SELECT count(*)::int AS count FROM freehold.audit_log WHERE event_type='LEDGER_RECONCILIATION_MISMATCH' AND resource_id=$1", [mismatch.rows[0]!.report.reconciliationId]);
  assert.equal(retained.rows[0].count, 1);
});

test('emergency suspension linearizes against an in-flight transfer and resume requires independent approval', async () => {
  const committedKey=randomUUID();
  const committed=await app.inject({method:'POST',url:'/v1/transfers',headers:headers(alice,committedKey),payload:transfer(ids.aliceAccount,'1')});
  assert.equal(committed.statusCode,200,committed.body);

  // Hold a transfer transaction after it passed the shared financial-control gate.
  const inFlightKey=randomUUID();
  await runtime.query('BEGIN');
  await runtime.query(`SELECT set_config('freehold.session_secret',$1,true)`, [dbSecrets.alice.toString('hex')]);
  const inFlight=await runtime.query<{body: unknown}>('SELECT freehold.execute_internal_transfer($1,$2,$3,$4,$5,$6,$7) AS body',
    [ids.alice,ids.aliceAccount,ids.bobAccount,'USD','1',inFlightKey,randomUUID()]);
  const suspendPromise=app.inject({method:'POST',url:'/v1/admin/governance/suspend-writes',headers:headers(admin),payload:{reason:'Concurrent transfer containment test'}})
    .then(response=>response);
  await new Promise(resolve=>setTimeout(resolve,100));
  await runtime.query('COMMIT');
  const suspended=await suspendPromise;
  assert.equal(suspended.statusCode,200,suspended.body);
  assert.equal(suspended.json().writesSuspended,true);

  const denied=await app.inject({method:'POST',url:'/v1/transfers',headers:headers(alice),payload:transfer(ids.aliceAccount,'1')});
  assert.equal(denied.statusCode,503,denied.body); assert.equal(denied.json().code,'FINANCIAL_WRITES_SUSPENDED');
  const replay=await app.inject({method:'POST',url:'/v1/transfers',headers:headers(alice,committedKey),payload:transfer(ids.aliceAccount,'1')});
  assert.equal(replay.statusCode,200,replay.body); assert.deepEqual(replay.json(),committed.json());
  const committedByGate=await app.inject({method:'POST',url:'/v1/transfers',headers:headers(alice,inFlightKey),payload:transfer(ids.aliceAccount,'1')});
  assert.equal(committedByGate.statusCode,200,committedByGate.body); assert.deepEqual(committedByGate.json(),inFlight.rows[0]!.body);

  const resume=await app.inject({method:'POST',url:'/v1/admin/governance/resume-requests',headers:headers(admin,randomUUID()),payload:{reason:'Verifier and incident review completed'}});
  assert.equal(resume.statusCode,200,resume.body);
  const approve=await app.inject({method:'POST',url:`/v1/admin/governance/requests/${resume.json().requestId}/approve`,headers:headers(reviewer),payload:{}});
  assert.equal(approve.statusCode,200,approve.body);
  const execute=await app.inject({method:'POST',url:`/v1/admin/governance/requests/${resume.json().requestId}/execute`,headers:headers(reviewer,resume.json().requestId),payload:{}});
  assert.equal(execute.statusCode,200,execute.body); assert.equal(execute.json().status,'EXECUTED');
  const status=await app.inject({method:'GET',url:'/v1/admin/governance',headers:{cookie:admin.cookie}});
  assert.equal(status.statusCode,200,status.body); assert.equal(status.json().status.writesSuspended,false);
  const evidence=await adminDb.query("SELECT count(*)::int AS count FROM freehold.governance_audit WHERE event_type IN ('EMERGENCY_SUSPEND','EXECUTED') AND outcome IN ('SUSPENDED','EXECUTED')");
  assert.ok(evidence.rows[0].count>=2);
});

test('account statements reconcile from the journal and do not post', async () => {
  const journals = await adminDb.query('SELECT count(*)::int AS count FROM freehold.ledger_journals');
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const statement = await app.inject({ method: 'GET', url: `/v1/accounts/${ids.aliceAccount}/statement?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=5`, headers: { cookie: alice.cookie } });
  assert.equal(statement.statusCode, 200, statement.body);
  const body = statement.json();
  assert.equal(body.currency, 'USD');
  assert.equal(body.accountId, ids.aliceAccount);
  assert.equal(body.ownerUserId, ids.alice);
  assert.equal(typeof body.openingAvailableMinor, 'string');
  assert.equal(typeof body.closingAvailableMinor, 'string');
  assert.equal(BigInt(body.closingAvailableMinor) - BigInt(body.openingAvailableMinor), BigInt(body.creditAvailableMinor) - BigInt(body.debitAvailableMinor));
  assert.ok(body.lines.length >= 1);
  assert.equal(body.lines[0].amountMinor, String(BigInt(body.lines[0].amountMinor)));
  const csv = await app.inject({ method: 'GET', url: `/v1/accounts/${ids.aliceAccount}/statement.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, headers: { cookie: alice.cookie } });
  assert.equal(csv.statusCode, 200, csv.body);
  assert.match(csv.headers['content-type'] ?? '', /text\/csv/);
  assert.match(csv.body, new RegExp(body.closingAvailableMinor));
  const pdf = await app.inject({ method: 'GET', url: `/v1/accounts/${ids.aliceAccount}/statement.pdf?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, headers: { cookie: alice.cookie } });
  assert.equal(pdf.statusCode, 200);
  assert.match(pdf.body, /^%PDF-1\.4/);
  const other = await app.inject({ method: 'GET', url: `/v1/accounts/${ids.bobAccount}/statement?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, headers: { cookie: alice.cookie } });
  assert.equal(other.statusCode, 403);
  const wide = await app.inject({ method: 'GET', url: `/v1/accounts/${ids.aliceAccount}/statement?from=2020-01-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z`, headers: { cookie: alice.cookie } });
  assert.equal(wide.statusCode, 400);
  assert.equal(wide.json().code, 'INVALID_STATEMENT_RANGE');
  const after = await adminDb.query('SELECT count(*)::int AS count FROM freehold.ledger_journals');
  assert.equal(after.rows[0].count, journals.rows[0].count);
  const limits = await app.inject({ method: 'GET', url: `/v1/accounts/${ids.aliceAccount}/limits`, headers: { cookie: alice.cookie } });
  assert.equal(limits.statusCode, 200, limits.body);
  assert.ok(Array.isArray(limits.json()));
});

test('institutional report and compliance cases stay behind capabilities', async () => {
  await adminDb.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)', [ids.reviewer, 'COMPLIANCE_OFFICER', 'phase5 compliance reader']);
  const customer = await app.inject({ method: 'GET', url: '/v1/admin/operations', headers: { cookie: alice.cookie } });
  assert.equal(customer.statusCode, 403);
  const report = await app.inject({ method: 'GET', url: '/v1/admin/reports/institutional', headers: { cookie: reviewer.cookie } });
  assert.equal(report.statusCode, 200, report.body);
  const body = report.json();
  assert.equal(body.externalAssets.status, 'UNAVAILABLE');
  assert.equal(body.financialIntegrity.independentVerification.status, 'UNAVAILABLE');
  assert.equal(body.systemHealth.workerProcess, 'UNAVAILABLE');
  assert.equal(body.issuanceEnabled, false);
  assert.ok(Array.isArray(body.liabilities));
  assert.equal(body.fundingRatio, undefined);
  const csv = await app.inject({ method: 'GET', url: '/v1/admin/reports/institutional.csv', headers: { cookie: reviewer.cookie } });
  assert.equal(csv.statusCode, 200, csv.body);
  assert.doesNotMatch(csv.body, /funding ratio/i);
  const opened = await app.inject({ method: 'POST', url: '/v1/admin/compliance/cases', headers: headers(reviewer), payload: { summary: 'Review repeated limit rejections', severity: 'LOW', subjectUserId: ids.alice, subjectAccountId: ids.aliceAccount } });
  assert.equal(opened.statusCode, 200, opened.body);
  const caseId = opened.json().caseId;
  const noted = await app.inject({ method: 'POST', url: `/v1/admin/compliance/cases/${caseId}/notes`, headers: headers(reviewer), payload: { note: 'No sanctions determination is made by this case.' } });
  assert.equal(noted.statusCode, 200, noted.body);
  const leaked = await app.inject({ method: 'GET', url: `/v1/admin/compliance/cases/${caseId}`, headers: { cookie: alice.cookie } });
  assert.equal(leaked.statusCode, 403);
  const detail = await app.inject({ method: 'GET', url: `/v1/admin/compliance/cases/${caseId}`, headers: { cookie: reviewer.cookie } });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().events.some((event: { eventType: string }) => event.eventType === 'NOTE'), true);
  const moved = await app.inject({ method: 'POST', url: `/v1/admin/compliance/cases/${caseId}/transition`, headers: headers(reviewer), payload: { status: 'UNDER_REVIEW', reviewerId: ids.reviewer } });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().status, 'UNDER_REVIEW');
});

test('flushing Redis removes sessions without changing the ledger', async () => {
  const before = await adminDb.query('SELECT count(*)::int AS count FROM freehold.ledger_journals');
  await redis.flushDb();
  const denied = await app.inject({ method: 'GET', url: '/v1/accounts', headers: { cookie: alice.cookie } });
  assert.equal(denied.statusCode, 401);
  const after = await adminDb.query('SELECT count(*)::int AS count FROM freehold.ledger_journals');
  assert.equal(after.rows[0].count, before.rows[0].count);
  const again = await login('alice@example.test');
  const accounts = await app.inject({ method: 'GET', url: '/v1/accounts', headers: { cookie: again.cookie } });
  assert.equal(accounts.statusCode, 200, accounts.body);
});
