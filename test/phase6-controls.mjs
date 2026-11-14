import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';

const admin = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
const api = new Client({ connectionString: process.env.DATABASE_URL });
const worker = new Client({ connectionString: process.env.WORKER_DATABASE_URL });
const auth = new Client({ connectionString: process.env.AUTH_DATABASE_URL });
const scheduler = new Client({ connectionString: process.env.SCHEDULER_DATABASE_URL });
const scheduler2 = new Client({ connectionString: process.env.SCHEDULER_DATABASE_URL });
const verifier = new Client({ connectionString: process.env.VERIFY_DATABASE_URL });

const bind = async (userId) => {
  const secret = randomBytes(32);
  await admin.query('SELECT freehold.auth_bind_session($1::uuid,1,$2::bytea,NULL,3600)', [userId, secret]);
  return secret.toString('hex');
};
const call = async (client, secret, sql, args) => {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('freehold.session_secret',$1,true)`, [secret]);
    const row = (await client.query(sql, args)).rows[0];
    await client.query('COMMIT');
    return row;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* keep the original database error */ }
    throw error;
  }
};
const privilegeDenied = (error) => error.code === '42501';

test('phase 6 separates auth, posting, scheduling, and reporting authority', async () => {
  const holdingUrl = spawnSync(process.execPath, ['-e', `
    const { Config } = require('./dist/src/config/config.module.js');
    new Config();
  `], { env: { ...process.env, AUTH_DATABASE_URL: 'postgresql://invalid@127.0.0.1/invalid' }, encoding: 'utf8' });
  assert.notEqual(holdingUrl.status, 0);
  assert.match(holdingUrl.stderr, /Financial API must not hold AUTH_DATABASE_URL/);
  const withoutAuthUrl = { ...process.env };
  delete withoutAuthUrl.AUTH_DATABASE_URL;
  const cleanConfig = spawnSync(process.execPath, ['-e', `
    const { Config } = require('./dist/src/config/config.module.js');
    new Config();
    process.stdout.write('CONFIG_OK');
  `], { env: withoutAuthUrl, encoding: 'utf8' });
  assert.equal(cleanConfig.status, 0, cleanConfig.stderr);
  assert.match(cleanConfig.stdout, /CONFIG_OK/);
  const authHoldingFinancial = spawnSync(process.execPath, ['dist/src/auth-server.js'], {
    env: { ...process.env, DATABASE_URL: 'postgresql://invalid@127.0.0.1/invalid' },
    encoding: 'utf8', timeout: 5000,
  });
  assert.notEqual(authHoldingFinancial.status, 0);
  assert.match(authHoldingFinancial.stderr, /Auth process must not hold DATABASE_URL/);

  await Promise.all([admin.connect(), api.connect(), worker.connect(), auth.connect(), scheduler.connect(), scheduler2.connect(), verifier.connect()]);
  const institution = randomUUID();
  const reviewer = randomUUID();
  const customer = randomUUID();
  const peer = randomUUID();
  const poor = randomUUID();
  const poorPeer = randomUUID();
  const source = randomUUID();
  const destination = randomUUID();
  const poorSource = randomUUID();
  const poorDest = randomUUID();
  const hash = 'phase6-unused-password-hash';
  let suspended = false;
  let parkedIds = [];
  try {
    const apiBind = await admin.query(`SELECT has_function_privilege('freehold_api','freehold.auth_bind_session(uuid,bigint,bytea,timestamptz,integer)','EXECUTE') AS bind,
      has_function_privilege('freehold_api','freehold.auth_find_credentials(text)','EXECUTE') AS find,
      has_function_privilege('freehold_api','freehold.auth_revoke_session(bytea)','EXECUTE') AS revoke,
      has_function_privilege('freehold_api','freehold.register_user(text,text,bytea)','EXECUTE') AS register,
      has_function_privilege('freehold_worker','freehold.execute_internal_transfer(uuid,uuid,uuid,text,bigint,text,uuid)','EXECUTE') AS worker_post,
      has_function_privilege('freehold_worker','freehold.scheduler_run_due(integer)','EXECUTE') AS worker_schedule,
      has_function_privilege('freehold_scheduler','freehold.execute_internal_transfer(uuid,uuid,uuid,text,bigint,text,uuid)','EXECUTE') AS scheduler_post,
      has_function_privilege('freehold_scheduler','freehold.scheduler_run_due(integer)','EXECUTE') AS scheduler_due,
      has_function_privilege('freehold_scheduler','freehold.scheduler_record_heartbeat(uuid)','EXECUTE') AS scheduler_beat,
      has_function_privilege('freehold_api','freehold.scheduler_record_heartbeat(uuid)','EXECUTE') AS api_beat,
      has_function_privilege('freehold_worker','freehold.scheduler_record_heartbeat(uuid)','EXECUTE') AS worker_beat,
      has_function_privilege('freehold_verifier','freehold.scheduler_record_heartbeat(uuid)','EXECUTE') AS verifier_beat,
      has_function_privilege('freehold_auth','freehold.register_user(text,text,bytea)','EXECUTE') AS auth_register,
      has_function_privilege('freehold_verifier','freehold.gl_report(uuid,text,text)','EXECUTE') AS verifier_gl,
      (SELECT rolreplication FROM pg_roles WHERE rolname='freehold_backup') AS backup_replication,
      (SELECT rolreplication FROM pg_roles WHERE rolname='freehold_scheduler') AS scheduler_replication`);
    const rights = apiBind.rows[0];
    assert.equal(rights.bind, false);
    assert.equal(rights.find, false);
    assert.equal(rights.revoke, false);
    assert.equal(rights.register, false);
    assert.equal(rights.worker_post, false);
    assert.equal(rights.worker_schedule, false);
    assert.equal(rights.scheduler_post, false);
    assert.equal(rights.scheduler_due, true);
    assert.equal(rights.scheduler_beat, true);
    assert.equal(rights.api_beat, false);
    assert.equal(rights.worker_beat, false);
    assert.equal(rights.verifier_beat, false);
    assert.equal(rights.auth_register, true);
    assert.equal(rights.verifier_gl, false);
    assert.equal(rights.backup_replication, true);
    assert.equal(rights.scheduler_replication, false);
    await assert.rejects(api.query('SELECT freehold.auth_bind_session($1::uuid,1,$2::bytea,NULL,3600)', [customer, randomBytes(32)]), privilegeDenied);
    await assert.rejects(api.query('SELECT freehold.register_user($1,$2,NULL)', ['nobody@example.test', hash]), privilegeDenied);
    await assert.rejects(worker.query('SELECT freehold.scheduler_run_due(1)'), privilegeDenied);
    await assert.rejects(scheduler.query('SELECT freehold.execute_internal_transfer($1,$2,$3,$4,1,$5,$6)', [customer, source, destination, 'USD', randomUUID(), randomUUID()]), privilegeDenied);
    await assert.rejects(auth.query('SELECT freehold.execute_internal_transfer($1,$2,$3,$4,1,$5,$6)', [customer, source, destination, 'USD', randomUUID(), randomUUID()]), privilegeDenied);
    await assert.rejects(auth.query('SELECT id FROM freehold.accounts'), privilegeDenied);
    await assert.rejects(verifier.query('SELECT freehold.gl_report($1,$2,$3)', [customer, 'TRIAL_BALANCE', '']), privilegeDenied);
    await assert.rejects(admin.query('SELECT freehold.scheduler_run_due(1)'), error => error.code === '42501' && error.message === 'SCHEDULER_ROLE_REQUIRED');
    await assert.rejects(api.query('SELECT freehold.scheduler_record_heartbeat($1::uuid)', [randomUUID()]), privilegeDenied);
    await assert.rejects(admin.query('SELECT freehold.scheduler_record_heartbeat($1::uuid)', [randomUUID()]), error => error.code === '42501' && error.message === 'SCHEDULER_ROLE_REQUIRED');
    await scheduler.query('SELECT freehold.scheduler_record_heartbeat($1::uuid)', [randomUUID()]);
    await assert.rejects(admin.query('SELECT freehold.institutional_manual_journal()'), error => error.code === '55000' && error.message === 'MANUAL_JOURNAL_DISABLED');
    await admin.query('BEGIN');
    await admin.query('SET LOCAL ROLE freehold_backup');
    await assert.rejects(admin.query('SELECT count(*) FROM freehold.accounts'), privilegeDenied);
    await admin.query('ROLLBACK');

    await admin.query('UPDATE freehold.ledger_settings SET sandbox_enabled=true WHERE singleton');
    await admin.query(`INSERT INTO freehold.users(id,email_normalized,password_hash,role) VALUES
      ($1,$2,$3,'ADMIN'),($4,$5,$3,'ADMIN'),($6,$7,$3,'USER'),($8,$9,$3,'USER'),($10,$11,$3,'USER'),($12,$13,$3,'USER')`,
      [institution, `p6-inst-${institution}@example.test`, hash, reviewer, `p6-rev-${reviewer}@example.test`, customer, `p6-cus-${customer}@example.test`, peer, `p6-peer-${peer}@example.test`, poor, `p6-poor-${poor}@example.test`, poorPeer, `p6-poor-peer-${poorPeer}@example.test`]);
    await admin.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)', [institution, 'INSTITUTION_ADMIN', 'phase6 policy initiator']);
    await admin.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)', [institution, 'EMERGENCY_CONTROL', 'phase6 suspension']);
    await admin.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)', [reviewer, 'FINANCIAL_REVIEWER', 'phase6 policy approver']);
    await admin.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)', [reviewer, 'AUDITOR', 'phase6 report reader']);
    await admin.query('BEGIN');
    await admin.query(`INSERT INTO freehold.accounts(id,owner_user_id,currency_code) VALUES
      ($1,$2,'USD'),($3,$4,'USD'),($5,$6,'USD'),($7,$8,'USD')`,
      [source, customer, destination, peer, poorSource, poor, poorDest, poorPeer]);
    await admin.query('COMMIT');
    await admin.query('SELECT freehold.sandbox_fund_account($1,$2,2000::bigint,$3,$4,$5)', [institution, source, `p6-fund-${randomUUID()}`, 'phase6 source', randomUUID()]);
    const secret = await bind(customer);
    const poorSecret = await bind(poor);
    const reviewerSecret = await bind(reviewer);
    const ownEmail = (await call(api, secret, 'SELECT freehold.auth_user_email($1::uuid) AS email', [customer])).email;
    assert.equal(ownEmail, `p6-cus-${customer}@example.test`);
    await assert.rejects(api.query('SELECT freehold.auth_user_email($1::uuid)', [customer]), error => error.code === '42501' && error.message === 'SESSION_NOT_BOUND');
    await assert.rejects(call(api, secret, 'SELECT freehold.auth_user_email($1::uuid)', [peer]), error => error.code === '42501' && error.message === 'SESSION_NOT_BOUND');
    await assert.rejects(verifier.query('SELECT freehold.auth_user_email($1::uuid)', [customer]), privilegeDenied);
    const posture = (await api.query('SELECT freehold.runtime_posture() AS posture')).rows[0].posture;
    assert.equal(posture.sandboxEnabled, true);
    assert.equal(posture.demoEnabled, true);
    assert.deepEqual(Object.keys(posture).sort(), ['demoEnabled', 'sandboxEnabled']);
    await assert.rejects(verifier.query('SELECT freehold.runtime_posture()'), privilegeDenied);
    const deployment = (await call(api, reviewerSecret, 'SELECT freehold.deployment_posture($1::uuid) AS posture', [reviewer])).posture;
    assert.equal(deployment.activeMigration, '034_phase16_2_institution_usage_execute_privileges.sql');
    assert.equal(deployment.sandboxEnabled, true);
    assert.equal(deployment.demoEnabled, true);
    assert.equal(deployment.writesSuspended, false);
    assert.equal(deployment.openCriticalIncidents, 0);
    assert.equal(deployment.runtimeRolesConfined, true);
    assert.equal(deployment.archiveMode, 'off');
    assert.ok(deployment.workerHeartbeatAt === null || typeof deployment.workerHeartbeatAt === 'string');
    assert.equal(typeof deployment.schedulerHeartbeatAt, 'string');
    assert.equal(typeof deployment.dueInstructionCount, 'number');
    if (deployment.dueInstructionCount === 0) assert.equal(deployment.oldestDueAgeSeconds, null);
    assert.ok(deployment.latestReconciliation === null || typeof deployment.latestReconciliation.balanced === 'boolean');
    await assert.rejects(api.query('SELECT freehold.deployment_posture($1::uuid)', [reviewer]), error => error.code === '42501' && error.message === 'SESSION_NOT_BOUND');
    await assert.rejects(call(api, secret, 'SELECT freehold.deployment_posture($1::uuid)', [customer]), error => error.code === '42501' && error.message === 'GOVERNANCE_CAPABILITY_REQUIRED');
    await assert.rejects(verifier.query('SELECT freehold.deployment_posture($1::uuid)', [reviewer]), privilegeDenied);
    await assert.rejects(worker.query('SELECT freehold.deployment_posture($1::uuid)', [reviewer]), privilegeDenied);
    await assert.rejects(scheduler.query('SELECT freehold.deployment_posture($1::uuid)', [reviewer]), privilegeDenied);
    await assert.rejects(api.query(`SELECT freehold.governance_record_authorization_failure($1::uuid,'ADMIN_ROUTE',NULL,'ROLE_OR_RECENT_TOTP_REQUIRED')`, [customer]), error => error.code === '42501' && error.message === 'SESSION_NOT_BOUND');
    await call(api, secret, `SELECT freehold.governance_record_authorization_failure($1::uuid,'ADMIN_ROUTE',NULL,'ROLE_OR_RECENT_TOTP_REQUIRED')`, [customer]);
    const authz = await admin.query(`SELECT count(*)::int AS n FROM freehold.governance_audit WHERE requesting_principal=$1 AND event_type='AUTHORIZATION_FAILURE' AND metadata->>'failureCode'='ROLE_OR_RECENT_TOTP_REQUIRED'`, [customer]);
    assert.equal(authz.rows[0].n, 1);
    const auditActor = randomUUID();
    await admin.query(`INSERT INTO freehold.users(id,email_normalized,password_hash,role) VALUES ($1,$2,$3,'ADMIN')`, [auditActor, `p6-bind-${auditActor}@example.test`, hash]);
    await admin.query(`SELECT freehold.governance_provision_capability($1,'ACCOUNT_ADMIN','phase6 bound audit',true)`, [auditActor]);
    const auditRequest = (await admin.query(`SELECT freehold.governance_create_account_request($1,$2,true,$3,$4) AS request`, [auditActor, source, 'phase6 bound audit', `p6-audit-${randomUUID()}`])).rows[0].request;
    await assert.rejects(api.query(`SELECT freehold.governance_record_execution_failure($1::uuid,$2::uuid,'DATABASE_FAILURE')`, [auditActor, auditRequest.requestId]), error => error.code === '42501' && error.message === 'SESSION_NOT_BOUND');
    const auditSecret = await bind(auditActor);
    await call(api, auditSecret, `SELECT freehold.governance_record_execution_failure($1::uuid,$2::uuid,'DATABASE_FAILURE')`, [auditActor, auditRequest.requestId]);
    const executionAudit = await admin.query(`SELECT count(*)::int AS n FROM freehold.governance_audit WHERE request_id=$1 AND event_type='EXECUTION_FAILED' AND executing_principal=$2`, [auditRequest.requestId, auditActor]);
    assert.equal(executionAudit.rows[0].n, 1);
    const adopt = async (parameters, reason) => {
      const key = `p6-policy-${randomUUID()}`;
      const created = (await admin.query('SELECT freehold.governance_create_risk_policy_request($1,$2::jsonb,$3,$4) AS request',
        [institution, JSON.stringify(parameters), reason, key])).rows[0].request;
      await admin.query(`SELECT freehold.governance_decide($1,$2,'APPROVE')`, [reviewer, created.requestId]);
      const executed = (await admin.query('SELECT freehold.governance_execute($1,$2,$3,$4) AS result', [institution, created.requestId, key, randomUUID()])).rows[0].result;
      assert.equal(executed.status, 'EXECUTED');
    };

    const trial = (await call(api, reviewerSecret, 'SELECT freehold.gl_report($1,$2,$3) AS report', [reviewer, 'TRIAL_BALANCE', 'USD'])).report;
    assert.equal(trial.filingStatus, 'NOT_A_REGULATORY_FILING');
    assert.equal(trial.byCurrency[0].currency, 'USD');
    assert.equal(trial.byCurrency[0].unavailable.includes('INSTITUTIONAL_ASSET'), true);
    assert.equal(trial.byCurrency[0].recordedBalanced, true);
    const sheet = (await call(api, reviewerSecret, 'SELECT freehold.gl_report($1,$2,$3) AS report', [reviewer, 'BALANCE_SHEET', ''])).report;
    assert.equal(sheet.assets.status, 'NOT_AVAILABLE');
    assert.equal(sheet.equation, 'NOT_AVAILABLE');
    assert.equal(sheet.filingStatus, 'NOT_A_REGULATORY_FILING');
    const income = (await call(api, reviewerSecret, 'SELECT freehold.gl_report($1,$2,$3) AS report', [reviewer, 'INCOME_STATEMENT', ''])).report;
    assert.equal(income.revenue.status, 'NOT_AVAILABLE');
    assert.equal(income.expenses.status, 'NOT_AVAILABLE');
    assert.equal(income.netIncome.status, 'NOT_AVAILABLE');
    const suspense = (await call(api, reviewerSecret, 'SELECT freehold.gl_report($1,$2,$3) AS report', [reviewer, 'SUSPENSE', 'USD'])).report;
    assert.equal(suspense.lines[0].journalCount, 0);
    assert.equal(suspense.lines[0].balanceMinor, '0');
    const recon = (await call(api, reviewerSecret, 'SELECT freehold.gl_report($1,$2,$3) AS report', [reviewer, 'CUSTOMER_RECONCILIATION', ''])).report;
    assert.equal(recon.externalAssets.status, 'NOT_AVAILABLE');
    assert.equal(recon.lines.every(line => line.status === 'RECONCILED' && line.differenceMinor === '0'), true, JSON.stringify(recon.lines));
    await assert.rejects(call(api, secret, 'SELECT freehold.gl_report($1,$2,$3)', [customer, 'TRIAL_BALANCE', '']), privilegeDenied);
    await assert.rejects(call(api, reviewerSecret, 'SELECT freehold.gl_report($1,$2,$3)', [reviewer, 'NOT_A_KIND', '']), error => error.code === '22023' && error.message === 'INVALID_REQUEST');
    await scheduler.query('SELECT freehold.scheduler_record_heartbeat($1::uuid)', [randomUUID()]);
    const afterBeat = (await call(api, reviewerSecret, 'SELECT freehold.deployment_posture($1::uuid) AS posture', [reviewer])).posture;
    assert.equal(typeof afterBeat.schedulerHeartbeatAt, 'string');
    assert.equal(typeof afterBeat.schedulerHeartbeatAgeSeconds, 'number');
    const health = (await call(api, reviewerSecret, 'SELECT freehold.operations_health($1) AS health', [reviewer])).health;
    assert.equal(health.database, 'CONNECTED');
    assert.ok(['RUNNING', 'STALE', 'UNAVAILABLE'].includes(health.workerProcess));
    assert.equal(health.schedulerProcess, 'RUNNING');
    assert.equal(typeof health.schedulerLastSeenAt, 'string');
    assert.equal(health.backupHealth.status, 'UNAVAILABLE');
    assert.equal(health.latestVerifier.status, 'UNAVAILABLE');
    assert.equal(typeof health.outboxBacklogCount, 'number');
    const catalog = await admin.query(`SELECT count(DISTINCT classification)::int AS classes, bool_and(posting_enabled=false) AS disabled
      FROM freehold.gl_accounts WHERE currency_code='USD'`);
    assert.equal(catalog.rows[0].classes, 8);
    assert.equal(catalog.rows[0].disabled, true);
    const advanced = (await admin.query(`SELECT freehold._advance_schedule(timestamptz '2026-01-31 15:00:00+00','MONTHLY') AS nxt`)).rows[0].nxt;
    assert.equal(new Date(advanced).toISOString(), '2026-11-28T15:00:00.000Z');

    const disabled = (await call(api, secret, 'SELECT freehold.account_controls_set($1,$2,$3::jsonb) AS controls',
      [customer, source, JSON.stringify({ outgoingEnabled: false, perTransferLimitMinor: '10' })])).controls;
    assert.equal(disabled.outgoingEnabled, false);
    assert.equal(disabled.perTransferLimitMinor, '10');
    const kept = (await call(api, secret, 'SELECT freehold.account_controls_set($1,$2,$3::jsonb) AS controls',
      [customer, source, JSON.stringify({ dailyLimitMinor: '30' })])).controls;
    assert.equal(kept.outgoingEnabled, false);
    assert.equal(kept.perTransferLimitMinor, '10');
    assert.equal(kept.dailyLimitMinor, '30');
    const blocked = (await call(api, secret, 'SELECT freehold.execute_internal_transfer($1,$2,$3,$4,1::bigint,$5,$6) AS result',
      [customer, source, destination, 'USD', `p6-off-${randomUUID()}`, randomUUID()])).result;
    assert.equal(blocked.state, 'REJECTED');
    assert.equal(blocked.error, 'LIMIT_OUTGOING_DISABLED');
    await call(api, secret, 'SELECT freehold.account_controls_set($1,$2,$3::jsonb)', [customer, source, JSON.stringify({ outgoingEnabled: true, monthlyLimitMinor: '5' })]);
    const underMonth = (await call(api, secret, 'SELECT freehold.execute_internal_transfer($1,$2,$3,$4,4::bigint,$5,$6) AS result',
      [customer, source, destination, 'USD', `p6-month-ok-${randomUUID()}`, randomUUID()])).result;
    assert.equal(underMonth.state, 'COMPLETED', JSON.stringify(underMonth));
    const overMonth = (await call(api, secret, 'SELECT freehold.execute_internal_transfer($1,$2,$3,$4,2::bigint,$5,$6) AS result',
      [customer, source, destination, 'USD', `p6-month-no-${randomUUID()}`, randomUUID()])).result;
    assert.equal(overMonth.error, 'LIMIT_MONTHLY_OUTGOING');
    const overSingle = (await call(api, secret, 'SELECT freehold.execute_internal_transfer($1,$2,$3,$4,11::bigint,$5,$6) AS result',
      [customer, source, destination, 'USD', `p6-single-${randomUUID()}`, randomUUID()])).result;
    assert.equal(overSingle.error, 'LIMIT_SINGLE_TRANSFER');
    await call(api, secret, 'SELECT freehold.account_controls_set($1,$2,$3::jsonb)',
      [customer, source, JSON.stringify({ perTransferLimitMinor: null, monthlyLimitMinor: null, newDestinationReviewSeconds: 3600 })]);
    const untrusted = (await call(api, secret, 'SELECT freehold.execute_internal_transfer($1,$2,$3,$4,1::bigint,$5,$6) AS result',
      [customer, source, destination, 'USD', `p6-new-dest-${randomUUID()}`, randomUUID()])).result;
    assert.equal(untrusted.error, 'LIMIT_NEW_DESTINATION');
    await call(api, secret, 'SELECT freehold.trusted_destination_add($1,$2,$3)', [customer, source, destination]);
    await admin.query(`UPDATE freehold.trusted_destinations SET trusted_at=clock_timestamp()-interval '2 hours' WHERE account_id=$1`, [source]);
    const trusted = (await call(api, secret, 'SELECT freehold.execute_internal_transfer($1,$2,$3,$4,1::bigint,$5,$6) AS result',
      [customer, source, destination, 'USD', `p6-trusted-${randomUUID()}`, randomUUID()])).result;
    assert.equal(trusted.state, 'COMPLETED', JSON.stringify(trusted));

    await adopt({ scope: 'INSTITUTION', ruleCode: 'HIGH_VALUE_STEP_UP', enabled: true, thresholdMinor: '1000000', timezone: 'UTC' }, 'Institutional step-up above ordinary test amounts');
    await adopt({ scope: 'ACCOUNT', accountId: source, ruleCode: 'MAX_SINGLE_TRANSFER', enabled: true, thresholdMinor: '20', timezone: 'UTC' }, 'Account single-transfer cap');
    await assert.rejects(call(api, secret, 'SELECT freehold.account_controls_set($1,$2,$3::jsonb)',
      [customer, source, JSON.stringify({ perTransferLimitMinor: '21' })]), error => error.code === '22023' && error.message === 'INVALID_ACCOUNT_CONTROL');
    const tightened = (await call(api, secret, 'SELECT freehold.account_controls_set($1,$2,$3::jsonb) AS controls',
      [customer, source, JSON.stringify({ perTransferLimitMinor: '20', newDestinationReviewSeconds: null })])).controls;
    assert.equal(tightened.perTransferLimitMinor, '20');
    assert.equal(tightened.institutionalSingleTransferMinor, '20');
    const atCap = (await call(api, secret, 'SELECT freehold.execute_internal_transfer($1,$2,$3,$4,20::bigint,$5,$6) AS result',
      [customer, source, destination, 'USD', `p6-at-cap-${randomUUID()}`, randomUUID()])).result;
    assert.equal(atCap.state, 'COMPLETED', JSON.stringify(atCap));
    await call(api, secret, 'SELECT freehold.account_controls_set($1,$2,$3::jsonb)', [customer, source, JSON.stringify({ perTransferLimitMinor: null })]);
    const overInstitution = (await call(api, secret, 'SELECT freehold.execute_internal_transfer($1,$2,$3,$4,21::bigint,$5,$6) AS result',
      [customer, source, destination, 'USD', `p6-over-inst-${randomUUID()}`, randomUUID()])).result;
    assert.equal(overInstitution.error, 'LIMIT_SINGLE_TRANSFER');
    await adopt({ scope: 'ACCOUNT', accountId: source, ruleCode: 'ACCOUNT_TRANSFER_BLOCK', enabled: true, timezone: 'UTC' }, 'Block this account despite customer preference');
    await call(api, secret, 'SELECT freehold.account_controls_set($1,$2,$3::jsonb)', [customer, source, JSON.stringify({ outgoingEnabled: true })]);
    const stillBlocked = (await call(api, secret, 'SELECT freehold.execute_internal_transfer($1,$2,$3,$4,1::bigint,$5,$6) AS result',
      [customer, source, destination, 'USD', `p6-block-${randomUUID()}`, randomUUID()])).result;
    assert.equal(stillBlocked.error, 'LIMIT_ACCOUNT_RESTRICTED');
    await adopt({ scope: 'ACCOUNT', accountId: source, ruleCode: 'ACCOUNT_TRANSFER_BLOCK', enabled: false, timezone: 'UTC' }, 'Lift the disposable account block');
    await call(api, secret, 'SELECT freehold.account_controls_set($1,$2,$3::jsonb)', [customer, source, JSON.stringify({
      outgoingEnabled: true, perTransferLimitMinor: null, dailyLimitMinor: null, monthlyLimitMinor: null, newDestinationReviewSeconds: null, stepUpThresholdMinor: null,
    })]);

    const next = new Date(Date.now() + 120000).toISOString();
    const onceKey = `p6-once-${randomUUID()}`;
    const created = (await call(api, secret, `SELECT freehold.scheduled_transfer_create($1,$2,$3,$4,7::bigint,'ONCE',$5::timestamptz,$6) AS item`,
      [customer, source, destination, 'USD', next, onceKey])).item;
    const same = (await call(api, secret, `SELECT freehold.scheduled_transfer_create($1,$2,$3,$4,7::bigint,'ONCE',$5::timestamptz,$6) AS item`,
      [customer, source, destination, 'USD', next, onceKey])).item;
    assert.equal(same.instructionId, created.instructionId);
    await assert.rejects(call(api, secret, `SELECT freehold.scheduled_transfer_create($1,$2,$3,$4,8::bigint,'ONCE',$5::timestamptz,$6)`,
      [customer, source, destination, 'USD', next, onceKey]), error => error.code === '22023' && error.message === 'INVALID_SCHEDULE');
    const other = (await call(api, secret, `SELECT freehold.scheduled_transfer_create($1,$2,$3,$4,7::bigint,'ONCE',$5::timestamptz,$6) AS item`,
      [customer, source, destination, 'USD', next, `p6-other-${randomUUID()}`])).item;
    assert.notEqual(other.instructionId, created.instructionId);
    const before = (await admin.query('SELECT count(*)::int AS count FROM freehold.ledger_journals')).rows[0].count;
    await admin.query('UPDATE freehold.scheduled_transfers SET next_execution_at=clock_timestamp()-interval \'1 second\' WHERE id=$1', [created.instructionId]);
    const [firstRun, secondRun] = await Promise.all([
      scheduler.query('SELECT freehold.scheduler_run_due(5) AS result'),
      scheduler2.query('SELECT freehold.scheduler_run_due(5) AS result'),
    ]);
    const outcomes = [...firstRun.rows[0].result.results, ...secondRun.rows[0].result.results].filter(row => row.instructionId === created.instructionId);
    assert.equal(outcomes.length, 1, JSON.stringify([firstRun.rows[0].result, secondRun.rows[0].result]));
    assert.equal(outcomes[0].outcome, 'COMPLETED');
    const after = (await admin.query('SELECT count(*)::int AS count FROM freehold.ledger_journals')).rows[0].count;
    assert.equal(after, before + 1);
    const again = (await scheduler.query('SELECT freehold.scheduler_run_due(5) AS result')).rows[0].result;
    assert.equal(again.results.some(row => row.instructionId === created.instructionId), false);
    const posted = (await admin.query(`SELECT count(*)::int AS count FROM freehold.transfers WHERE source_account_id=$1 AND state='COMPLETED' AND amount_minor=7`, [source])).rows[0].count;
    assert.equal(posted, 1);
    const done = (await admin.query('SELECT status FROM freehold.scheduled_transfers WHERE id=$1', [created.instructionId])).rows[0].status;
    assert.equal(done, 'COMPLETED');

    const cancelNext = new Date(Date.now() + 180000).toISOString();
    const cancellable = (await call(api, secret, `SELECT freehold.scheduled_transfer_create($1,$2,$3,$4,3::bigint,'ONCE',$5::timestamptz,$6) AS item`,
      [customer, source, destination, 'USD', cancelNext, `p6-cancel-${randomUUID()}`])).item;
    const cancelled = (await call(api, secret, 'SELECT freehold.scheduled_transfer_cancel($1,$2) AS item', [customer, cancellable.instructionId])).item;
    assert.equal(cancelled.status, 'CANCELLED');
    await admin.query('UPDATE freehold.scheduled_transfers SET next_execution_at=clock_timestamp()-interval \'1 second\' WHERE id=$1', [cancellable.instructionId]);
    await scheduler.query('SELECT freehold.scheduler_run_due(5)');
    const cancelPosted = (await admin.query(`SELECT count(*)::int AS count FROM freehold.transfers WHERE source_account_id=$1 AND amount_minor=3`, [source])).rows[0].count;
    assert.equal(cancelPosted, 0);

    const poorNext = new Date(Date.now() + 180000).toISOString();
    const poorInstruction = (await call(api, poorSecret, `SELECT freehold.scheduled_transfer_create($1,$2,$3,$4,5::bigint,'ONCE',$5::timestamptz,$6) AS item`,
      [poor, poorSource, poorDest, 'USD', poorNext, `p6-poor-${randomUUID()}`])).item;
    await admin.query('UPDATE freehold.scheduled_transfers SET next_execution_at=clock_timestamp()-interval \'1 second\' WHERE id=$1', [poorInstruction.instructionId]);
    const poorRun = (await scheduler.query('SELECT freehold.scheduler_run_due(5) AS result')).rows[0].result;
    const poorOutcome = poorRun.results.find(row => row.instructionId === poorInstruction.instructionId);
    assert.equal(poorOutcome.outcome, 'REJECTED');
    assert.equal(poorOutcome.error, 'INSUFFICIENT_FUNDS');
    const poorRow = (await admin.query('SELECT s.status, s.attempt_count, a.available_minor::text AS available FROM freehold.scheduled_transfers s JOIN freehold.accounts a ON a.id=s.source_account_id WHERE s.id=$1', [poorInstruction.instructionId])).rows[0];
    assert.equal(poorRow.status, 'ACTIVE');
    assert.equal(poorRow.attempt_count, 1);
    assert.equal(poorRow.available, '0');

    await call(api, secret, 'SELECT freehold.account_controls_set($1,$2,$3::jsonb)', [customer, source, JSON.stringify({ stepUpThresholdMinor: '1' })]);
    const stepNext = new Date(Date.now() + 180000).toISOString();
    const stepped = (await call(api, secret, `SELECT freehold.scheduled_transfer_create($1,$2,$3,$4,5::bigint,'ONCE',$5::timestamptz,$6) AS item`,
      [customer, source, destination, 'USD', stepNext, `p6-step-${randomUUID()}`])).item;
    const directStep = (await call(api, secret, 'SELECT freehold.execute_internal_transfer($1,$2,$3,$4,5::bigint,$5,$6) AS result',
      [customer, source, destination, 'USD', `p6-step-direct-${randomUUID()}`, randomUUID()])).result;
    assert.equal(directStep.error, 'STEP_UP_UNAVAILABLE');
    const stepBalanceBefore = (await admin.query('SELECT available_minor::text AS available FROM freehold.accounts WHERE id=$1', [source])).rows[0].available;
    await admin.query('UPDATE freehold.scheduled_transfers SET next_execution_at=clock_timestamp()-interval \'1 second\' WHERE id=$1', [stepped.instructionId]);
    const stepRun = (await scheduler.query('SELECT freehold.scheduler_run_due(5) AS result')).rows[0].result;
    const stepOutcome = stepRun.results.find(row => row.instructionId === stepped.instructionId);
    assert.equal(stepOutcome.error, 'LIMIT_STEP_UP_REQUIRED', JSON.stringify(stepOutcome));
    const stepBalanceAfter = (await admin.query('SELECT available_minor::text AS available FROM freehold.accounts WHERE id=$1', [source])).rows[0].available;
    assert.equal(stepBalanceAfter, stepBalanceBefore);
    await call(api, secret, 'SELECT freehold.account_controls_set($1,$2,$3::jsonb)', [customer, source, JSON.stringify({ stepUpThresholdMinor: null })]);

    const suspendNext = new Date(Date.now() + 180000).toISOString();
    const suspendedInstruction = (await call(api, secret, `SELECT freehold.scheduled_transfer_create($1,$2,$3,$4,1::bigint,'DAILY',$5::timestamptz,$6) AS item`,
      [customer, source, destination, 'USD', suspendNext, `p6-suspend-${randomUUID()}`])).item;
    await admin.query('SELECT freehold.governance_suspend_writes($1,$2)', [institution, 'phase6 scheduler must not post during suspension']);
    suspended = true;
    await admin.query('UPDATE freehold.scheduled_transfers SET next_execution_at=clock_timestamp()-interval \'1 second\' WHERE id=$1', [suspendedInstruction.instructionId]);
    const suspendedRun = (await scheduler.query('SELECT freehold.scheduler_run_due(5) AS result')).rows[0].result;
    const suspendedOutcome = suspendedRun.results.find(row => row.instructionId === suspendedInstruction.instructionId);
    assert.equal(suspendedOutcome.outcome, 'FAILED');
    assert.match(suspendedOutcome.error, /FINANCIAL_WRITES_SUSPENDED/);
    const delayed = (await admin.query('SELECT next_execution_at>clock_timestamp() AS future, status FROM freehold.scheduled_transfers WHERE id=$1', [suspendedInstruction.instructionId])).rows[0];
    assert.equal(delayed.future, true);
    assert.equal(delayed.status, 'ACTIVE');
    await admin.query('UPDATE freehold.institutional_control SET writes_suspended=false, resumed_at=clock_timestamp(), suspension_reason=NULL, suspended_by=NULL, suspended_at=NULL WHERE singleton');
    suspended = false;

    const parked = await admin.query(`UPDATE freehold.outbox_events SET available_at=clock_timestamp()+interval '2 days'
      WHERE dispatched_at IS NULL AND quarantined_at IS NULL RETURNING id`);
    parkedIds = parked.rows.map(row => row.id);
    const poisonTransfer = (await call(api, secret, 'SELECT freehold.execute_internal_transfer($1,$2,$3,$4,1::bigint,$5,$6) AS result',
      [customer, source, destination, 'USD', `p6-poison-${randomUUID()}`, randomUUID()])).result;
    assert.equal(poisonTransfer.state, 'COMPLETED');
    const eventId = (await admin.query('SELECT id FROM freehold.outbox_events WHERE operation_id=$1', [poisonTransfer.operationId])).rows[0].id;
    const workerId = randomUUID();
    let claimed;
    for (let attempt = 0; attempt < 8; attempt++) {
      await admin.query('UPDATE freehold.outbox_events SET available_at=clock_timestamp() WHERE id=$1', [eventId]);
      await admin.query(`UPDATE freehold.worker_inbox SET lease_until=clock_timestamp()-interval '1 second' WHERE event_id=$1`, [eventId]);
      claimed = await worker.query('SELECT event_id, attempt_count FROM freehold.worker_claim_outbox($1::uuid,1,30)', [workerId]);
      assert.equal(claimed.rows[0].event_id, eventId);
      assert.equal(claimed.rows[0].attempt_count, attempt + 1);
    }
    const quarantined = (await worker.query('SELECT freehold.worker_defer_outbox($1::uuid,$2::uuid,$3::text) AS result', [workerId, eventId, 'poison-test'])).rows[0].result;
    assert.equal(quarantined.quarantined, true);
    assert.equal(quarantined.attemptCount, 8);
    const hidden = await worker.query('SELECT event_id FROM freehold.worker_claim_outbox($1::uuid,10,30)', [workerId]);
    assert.equal(hidden.rows.some(row => row.event_id === eventId), false);
    const journalsForPoison = (await admin.query('SELECT count(*)::int AS count FROM freehold.ledger_journals WHERE operation_id=$1', [poisonTransfer.operationId])).rows[0].count;
    assert.equal(journalsForPoison, 1);

    const duplicateTransfer = (await call(api, secret, 'SELECT freehold.execute_internal_transfer($1,$2,$3,$4,1::bigint,$5,$6) AS result',
      [customer, source, destination, 'USD', `p6-dup-${randomUUID()}`, randomUUID()])).result;
    const duplicateEvent = (await admin.query('SELECT id FROM freehold.outbox_events WHERE operation_id=$1', [duplicateTransfer.operationId])).rows[0].id;
    const firstClaim = await worker.query('SELECT event_id FROM freehold.worker_claim_outbox($1::uuid,1,30)', [workerId]);
    assert.equal(firstClaim.rows[0].event_id, duplicateEvent);
    await admin.query(`UPDATE freehold.worker_inbox SET lease_until=clock_timestamp()-interval '1 second' WHERE event_id=$1`, [duplicateEvent]);
    await admin.query('UPDATE freehold.outbox_events SET available_at=clock_timestamp() WHERE id=$1', [duplicateEvent]);
    const secondClaim = await worker.query('SELECT attempt_count FROM freehold.worker_claim_outbox($1::uuid,1,30)', [workerId]);
    assert.equal(secondClaim.rows[0].attempt_count, 2);
    const acked = (await worker.query('SELECT freehold.worker_complete_outbox($1::uuid,$2::uuid) AS completed', [workerId, duplicateEvent])).rows[0].completed;
    assert.equal(acked, true);
    const reack = (await worker.query('SELECT freehold.worker_complete_outbox($1::uuid,$2::uuid) AS completed', [workerId, duplicateEvent])).rows[0].completed;
    assert.equal(reack, false);
    const duplicateJournals = (await admin.query('SELECT count(*)::int AS count FROM freehold.ledger_journals WHERE operation_id=$1', [duplicateTransfer.operationId])).rows[0].count;
    assert.equal(duplicateJournals, 1);
  } finally {
    if (suspended) {
      await admin.query('UPDATE freehold.institutional_control SET writes_suspended=false, resumed_at=clock_timestamp(), suspension_reason=NULL, suspended_by=NULL, suspended_at=NULL WHERE singleton');
    }
    if (parkedIds.length) {
      await admin.query('UPDATE freehold.outbox_events SET available_at=created_at WHERE id = ANY($1::uuid[]) AND quarantined_at IS NULL', [parkedIds]);
    }
    await Promise.all([admin.end(), api.end(), worker.end(), auth.end(), scheduler.end(), scheduler2.end(), verifier.end()]);
  }
});
