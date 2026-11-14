import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';

const admin = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
const api = new Client({ connectionString: process.env.DATABASE_URL });
const worker = new Client({ connectionString: process.env.WORKER_DATABASE_URL });
const verifier = new Client({ connectionString: process.env.VERIFY_DATABASE_URL });

const bind = async (userId) => {
  const secret = randomBytes(32);
  await admin.query('SELECT freehold.auth_bind_session($1::uuid,1,$2::bytea,NULL,3600)', [userId, secret]);
  return secret.toString('hex');
};
const call = async (secret, sql, args) => {
  await api.query('BEGIN');
  try {
    await api.query(`SELECT set_config('freehold.session_secret',$1,true)`, [secret]);
    const row = (await api.query(sql, args)).rows[0];
    await api.query('COMMIT');
    return row;
  } catch (error) {
    try { await api.query('ROLLBACK'); } catch { /* keep the original database error */ }
    throw error;
  }
};
const denied = (error) => error.code === '42501';

test('phase 7 keeps projection checks and confines customer reads to the bound owner', async () => {
  await Promise.all([admin.connect(), api.connect(), worker.connect(), verifier.connect()]);
  const owner = randomUUID();
  const peer = randomUUID();
  const funder = randomUUID();
  const source = randomUUID();
  const destination = randomUUID();
  const hash = 'phase7-unused-password-hash';
  try {
    for (const sql of [
      'SELECT id FROM freehold.accounts',
      'SELECT id FROM freehold.ledger_accounts',
      'SELECT id FROM freehold.ledger_journals',
      'SELECT id FROM freehold.ledger_entries',
      'SELECT id FROM freehold.transfers',
      'SELECT id FROM freehold.holds',
      'SELECT operation_id FROM freehold.idempotency_requests',
      'SELECT account_id FROM freehold.account_rollups',
    ]) await assert.rejects(api.query(sql), denied, sql);
    await assert.rejects(verifier.query('SELECT account_id FROM freehold.account_rollups'), denied);
    await assert.rejects(worker.query('SELECT freehold.customer_account_list($1::uuid)', [owner]), denied);
    const readable = await verifier.query('SELECT count(*)::int AS count FROM freehold.accounts');
    assert.equal(typeof readable.rows[0].count, 'number');
    const currency = await api.query(`SELECT code FROM freehold.currencies WHERE code='USD'`);
    assert.equal(currency.rows[0].code, 'USD');

    await admin.query('UPDATE freehold.ledger_settings SET sandbox_enabled=true WHERE singleton');
    await admin.query('UPDATE freehold.institutional_control SET writes_suspended=false WHERE singleton');
    await admin.query(`INSERT INTO freehold.users(id,email_normalized,password_hash,role) VALUES
      ($1,$2,$3,'ADMIN'),($4,$5,$3,'USER'),($6,$7,$3,'USER')`,
      [funder, `p7-fund-${funder}@example.test`, hash, owner, `p7-own-${owner}@example.test`, peer, `p7-peer-${peer}@example.test`]);
    await admin.query('BEGIN');
    await admin.query(`INSERT INTO freehold.accounts(id,owner_user_id,currency_code) VALUES ($1,$2,'USD'),($3,$4,'USD')`,
      [source, owner, destination, peer]);
    await admin.query('COMMIT');
    await admin.query('SELECT freehold.sandbox_fund_account($1,$2,500::bigint,$3,$4,$5)',
      [funder, source, `p7-fund-${randomUUID()}`, 'phase7 source', randomUUID()]);

    await assert.rejects(api.query('SELECT freehold.customer_account_list($1::uuid)', [owner]),
      (error) => denied(error) && error.message === 'SESSION_NOT_BOUND');
    const ownerSecret = await bind(owner);
    const peerSecret = await bind(peer);
    await assert.rejects(call(ownerSecret, 'SELECT freehold.customer_account_list($1::uuid)', [peer]), denied);

    const ownList = (await call(ownerSecret, 'SELECT freehold.customer_account_list($1::uuid) AS items', [owner])).items;
    assert.deepEqual(ownList.map(item => item.id), [source]);
    const peerList = (await call(peerSecret, 'SELECT freehold.customer_account_list($1::uuid) AS items', [peer])).items;
    assert.deepEqual(peerList.map(item => item.id), [destination]);
    const forged = (await call(ownerSecret, 'SELECT freehold.customer_account_get($1::uuid,$2::uuid) AS item', [owner, randomUUID()])).item;
    assert.equal(forged, null);
    const other = (await call(ownerSecret, 'SELECT freehold.customer_account_get($1::uuid,$2::uuid) AS item', [owner, destination])).item;
    assert.equal(other, null);
    assert.equal((await call(ownerSecret, 'SELECT freehold.customer_account_owns($1::uuid,$2::uuid) AS ok', [owner, source])).ok, true);
    assert.equal((await call(ownerSecret, 'SELECT freehold.customer_account_owns($1::uuid,$2::uuid) AS ok', [owner, destination])).ok, false);
    await assert.rejects(call(ownerSecret, 'SELECT freehold.customer_account_activity($1::uuid,$2::uuid,NULL,NULL,20)', [owner, destination]),
      (error) => denied(error) && error.message === 'ACCOUNT_NOT_AUTHORIZED');

    const before = (await admin.query(`SELECT a.available_minor::text AS available, r.entry_count::text AS entries
      FROM freehold.accounts a JOIN freehold.account_rollups r ON r.account_id=a.id WHERE a.id=$1`, [source])).rows[0];
    const posted = (await call(ownerSecret, 'SELECT freehold.execute_internal_transfer($1,$2,$3,$4,1::bigint,$5,$6) AS result',
      [owner, source, destination, 'USD', `p7-pay-${randomUUID()}`, randomUUID()])).result;
    assert.equal(posted.state, 'COMPLETED', JSON.stringify(posted));
    const after = (await admin.query(`SELECT a.available_minor::text AS available, r.available_minor::text AS rollup,
      r.reserved_minor::text AS reserved_rollup, a.reserved_minor::text AS reserved,
      r.entry_count::text AS entries,
      (SELECT count(*)::text FROM freehold.ledger_entries e JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id
        WHERE la.customer_account_id=a.id) AS actual
      FROM freehold.accounts a JOIN freehold.account_rollups r ON r.account_id=a.id WHERE a.id=$1`, [source])).rows[0];
    assert.equal(after.available, after.rollup);
    assert.equal(after.reserved, after.reserved_rollup);
    assert.equal(after.entries, after.actual);
    assert.equal(BigInt(after.available), BigInt(before.available) - 1n);
    assert.equal(BigInt(after.entries), BigInt(before.entries) + 1n);

    const key = `p7-idem-${randomUUID()}`;
    const again = (await call(ownerSecret, 'SELECT freehold.execute_internal_transfer($1,$2,$3,$4,2::bigint,$5,$6) AS result',
      [owner, source, destination, 'USD', key, randomUUID()])).result;
    assert.equal(again.state, 'COMPLETED');
    const seen = (await call(ownerSecret, 'SELECT freehold.customer_idempotency_get($1::uuid,$2::text,$3::text) AS item', [owner, 'TRANSFER', key])).item;
    assert.equal(seen.found, true);
    assert.equal(seen.result.state, 'COMPLETED');
    const hidden = (await call(peerSecret, 'SELECT freehold.customer_idempotency_get($1::uuid,$2::text,$3::text) AS item', [peer, 'TRANSFER', key])).item;
    assert.equal(hidden.found, false);
    const activity = (await call(ownerSecret, 'SELECT freehold.customer_account_activity($1::uuid,$2::uuid,NULL,NULL,101) AS items', [owner, source])).items;
    assert.ok(activity.length >= 2);
    assert.match(activity[0].cursorTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const page = (await call(ownerSecret, 'SELECT freehold.customer_account_activity($1::uuid,$2::uuid,$3::timestamptz,$4::uuid,1) AS items',
      [owner, source, activity[0].cursorTime, activity[0].id])).items;
    assert.equal(page.some(item => item.id === activity[0].id), false);
    await assert.rejects(call(ownerSecret, `SELECT freehold.account_statement($1::uuid,$2::uuid,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',20,NULL,NULL)`, [owner, destination]),
      (error) => denied(error) && error.message === 'ACCOUNT_NOT_AUTHORIZED');
    const scheduled = (await call(ownerSecret, `SELECT freehold.scheduled_transfer_create($1::uuid,$2::uuid,$3::uuid,'USD',1::bigint,'ONCE',clock_timestamp()+interval '2 minutes',$4::text) AS body`,
      [owner, source, destination, `p7-sched-${randomUUID()}`])).body;
    const ownSchedules = (await call(ownerSecret, 'SELECT freehold.scheduled_transfer_list($1::uuid,20) AS items', [owner])).items;
    assert.equal(ownSchedules.some(item => item.instructionId === scheduled.instructionId), true);
    await assert.rejects(call(ownerSecret, 'SELECT freehold.scheduled_transfer_list($1::uuid,20)', [peer]), denied);
    const peerSchedules = (await call(peerSecret, 'SELECT freehold.scheduled_transfer_list($1::uuid,20) AS items', [peer])).items;
    assert.equal(peerSchedules.some(item => item.instructionId === scheduled.instructionId), false);

    await admin.query('BEGIN');
    await admin.query('UPDATE freehold.accounts SET available_minor=available_minor+1 WHERE id=$1', [source]);
    await assert.rejects(admin.query('COMMIT'), (error) => error.code === '23514' && error.message.includes('BALANCE_PROJECTION_OR_HOLD_MISMATCH'));
    await admin.query('ROLLBACK');
    const restored = (await admin.query('SELECT available_minor::text AS available FROM freehold.accounts WHERE id=$1', [source])).rows[0].available;
    assert.equal(restored, (BigInt(after.available) - 2n).toString());
  } finally {
    await Promise.all([admin.end(), api.end(), worker.end(), verifier.end()]);
  }
});

test('phase 7 monitor records alerts without posting and incidents stay operational', async () => {
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
  const api = new Client({ connectionString: process.env.DATABASE_URL });
  const scheduler = new Client({ connectionString: process.env.SCHEDULER_DATABASE_URL });
  await admin.connect();
  await api.connect();
  await scheduler.connect();
  const operator = randomUUID();
  const auditor = randomUUID();
  const customer = randomUUID();
  const hash = 'phase7-monitor-unused-password-hash';
  const bind = async (userId) => {
    const secret = randomBytes(32);
    await admin.query('SELECT freehold.auth_bind_session($1::uuid,1,$2::bytea,NULL,3600)', [userId, secret]);
    return secret.toString('hex');
  };
  const call = async (secret, sql, args) => {
    await api.query('BEGIN');
    try {
      await api.query(`SELECT set_config('freehold.session_secret',$1,true)`, [secret]);
      const row = (await api.query(sql, args)).rows[0];
      await api.query('COMMIT');
      return row;
    } catch (error) {
      try { await api.query('ROLLBACK'); } catch { /* keep the original database error */ }
      throw error;
    }
  };
  try {
    await admin.query(`INSERT INTO freehold.users(id,email_normalized,password_hash,role) VALUES
      ($1,$2,$3,'ADMIN'),($4,$5,$3,'ADMIN'),($6,$7,$3,'USER')`,
      [operator, `p7-op-${operator}@example.test`, hash, auditor, `p7-aud-${auditor}@example.test`, customer, `p7-cus-${customer}@example.test`]);
    await admin.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)', [operator, 'SECURITY_ADMIN', 'phase7 monitor']);
    await admin.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)', [auditor, 'AUDITOR', 'phase7 alert reader']);
    const operatorSecret = await bind(operator);
    const auditorSecret = await bind(auditor);
    const customerSecret = await bind(customer);
    await assert.rejects(call(customerSecret, 'SELECT freehold.monitor_evaluate($1::uuid)', [customer]), denied);
    await assert.rejects(call(auditorSecret, 'SELECT freehold.monitor_evaluate($1::uuid)', [auditor]), denied);
    await assert.rejects(api.query('SELECT freehold.monitor_evaluate($1::uuid)', [operator]),
      (error) => denied(error) && error.message === 'SESSION_NOT_BOUND');
    await admin.query('DELETE FROM freehold.scheduler_heartbeats');
    const first = (await call(operatorSecret, 'SELECT freehold.monitor_evaluate($1::uuid) AS result', [operator])).result;
    assert.equal(first.financialRecordsChanged, false);
    assert.equal(typeof first.openAlerts, 'number');
    assert.ok(first.openAlerts >= 1);
    const second = (await call(operatorSecret, 'SELECT freehold.monitor_evaluate($1::uuid) AS result', [operator])).result;
    const backupRows = await admin.query(`SELECT count(*)::int AS count FROM freehold.operational_alerts WHERE alert_key='backup-telemetry'`);
    assert.equal(backupRows.rows[0].count, 1);
    assert.equal(second.openAlerts, first.openAlerts);
    const alerts = (await call(auditorSecret, 'SELECT freehold.alert_list($1::uuid,50) AS alerts', [auditor])).alerts;
    const backup = alerts.find(alert => alert.alertKey === 'backup-telemetry');
    const wal = alerts.find(alert => alert.alertKey === 'wal-archive');
    const verifierAlert = alerts.find(alert => alert.alertKey === 'verifier-telemetry');
    const schedulerAlert = alerts.find(alert => alert.alertKey === 'scheduler-heartbeat');
    assert.equal(schedulerAlert.state, 'OPEN');
    assert.equal(schedulerAlert.severity, 'WARNING');
    assert.equal(schedulerAlert.details.telemetry, 'UNAVAILABLE');
    await scheduler.query('SELECT freehold.scheduler_record_heartbeat($1::uuid)', [randomUUID()]);
    await call(operatorSecret, 'SELECT freehold.monitor_evaluate($1::uuid) AS result', [operator]);
    const afterBeat = (await call(auditorSecret, 'SELECT freehold.alert_list($1::uuid,50) AS alerts', [auditor])).alerts;
    const clearedScheduler = afterBeat.find(alert => alert.alertKey === 'scheduler-heartbeat');
    assert.equal(clearedScheduler.state, 'RESOLVED');
    assert.equal(backup.details.telemetry, 'UNAVAILABLE');
    assert.equal(backup.details.backupAgeSeconds, null);
    assert.equal(backup.severity, 'INFORMATIONAL');
    assert.equal(verifierAlert.details.telemetry, 'UNAVAILABLE');
    assert.equal(wal.details.telemetry, 'MEASURED');
    assert.equal(wal.details.archiveMode, 'off');
    const journals = (await admin.query('SELECT count(*)::int AS count FROM freehold.ledger_journals')).rows[0].count;
    const opened = (await call(operatorSecret, 'SELECT freehold.incident_open($1,$2,$3,$4) AS incident',
      [operator, 'HIGH', 'Rollup divergence drill', 'A reconciliation mismatch is operational, not a customer case.'])).incident;
    assert.equal(opened.classification, 'OPERATIONAL');
    assert.equal(opened.status, 'OPEN');
    const noted = (await call(operatorSecret, 'SELECT freehold.incident_update($1,$2,$3,$4::jsonb) AS incident',
      [operator, opened.incidentId, 'NOTE', JSON.stringify({ body: 'Compared projection to rollup.' })])).incident;
    assert.equal(noted.events.some(event => event.eventType === 'NOTE'), true);
    const linked = (await call(operatorSecret, 'SELECT freehold.incident_update($1,$2,$3,$4::jsonb) AS incident',
      [operator, opened.incidentId, 'LINK_OPERATION', JSON.stringify({ operationRef: randomUUID() })])).incident;
    assert.equal(linked.operations.length, 1);
    const contained = (await call(operatorSecret, 'SELECT freehold.incident_update($1,$2,$3,$4::jsonb) AS incident',
      [operator, opened.incidentId, 'CONTAIN', JSON.stringify({ body: 'Writes remain on the governance suspension control.' })])).incident;
    assert.equal(contained.status, 'CONTAINED');
    const resolved = (await call(operatorSecret, 'SELECT freehold.incident_update($1,$2,$3,$4::jsonb) AS incident',
      [operator, opened.incidentId, 'RESOLVE', JSON.stringify({ body: 'Projection matched the rollup after review.' })])).incident;
    assert.equal(resolved.status, 'RESOLVED');
    const closed = (await call(operatorSecret, 'SELECT freehold.incident_update($1,$2,$3,$4::jsonb) AS incident',
      [operator, opened.incidentId, 'CLOSE', JSON.stringify({ body: 'Closed after review.' })])).incident;
    assert.equal(closed.status, 'CLOSED');
    await assert.rejects(call(operatorSecret, 'SELECT freehold.incident_update($1,$2,$3,$4::jsonb)',
      [operator, opened.incidentId, 'NOTE', JSON.stringify({ body: 'too late' })]),
      (error) => error.code === '22023');
    await assert.rejects(admin.query('UPDATE freehold.operational_incident_events SET body=$2 WHERE incident_id=$1', [opened.incidentId, 'rewritten']),
      (error) => error.code === '55000' && error.message === 'INCIDENT_AUDIT_IMMUTABLE');
    const visible = (await call(auditorSecret, 'SELECT freehold.incident_get($1,$2) AS incident', [auditor, opened.incidentId])).incident;
    assert.equal(visible.classification, 'OPERATIONAL');
    await assert.rejects(call(customerSecret, 'SELECT freehold.incident_get($1,$2)', [customer, opened.incidentId]), denied);
    const afterJournals = (await admin.query('SELECT count(*)::int AS count FROM freehold.ledger_journals')).rows[0].count;
    assert.equal(afterJournals, journals);
    await assert.rejects(api.query('SELECT id FROM freehold.operational_alerts'), denied);
    await assert.rejects(api.query('SELECT id FROM freehold.operational_incidents'), denied);
  } finally {
    await admin.end();
    await api.end();
    await scheduler.end();
  }
});

test('phase 8 lock timeout aborts a due schedule instead of delaying it', async () => {
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
  const scheduler = new Client({ connectionString: process.env.SCHEDULER_DATABASE_URL });
  await admin.connect();
  await scheduler.connect();
  const owner = randomUUID();
  const payee = randomUUID();
  const funder = randomUUID();
  const source = randomUUID();
  const destination = randomUUID();
  const hash = 'phase8-lock-unused-password-hash';
  try {
    await admin.query('UPDATE freehold.ledger_settings SET sandbox_enabled=true WHERE singleton');
    await admin.query('UPDATE freehold.institutional_control SET writes_suspended=false WHERE singleton');
    await admin.query(`INSERT INTO freehold.users(id,email_normalized,password_hash,role) VALUES
      ($1,$2,$3,'ADMIN'),($4,$5,$3,'USER'),($6,$7,$3,'USER')`,
      [funder, `p8-fund-${funder}@example.test`, hash, owner, `p8-own-${owner}@example.test`, payee, `p8-pay-${payee}@example.test`]);
    await admin.query('BEGIN');
    await admin.query(`INSERT INTO freehold.accounts(id,owner_user_id,currency_code) VALUES ($1,$2,'USD'),($3,$4,'USD')`,
      [source, owner, destination, payee]);
    await admin.query('COMMIT');
    await admin.query('SELECT freehold.sandbox_fund_account($1,$2,500::bigint,$3,$4,$5)',
      [funder, source, `p8-fund-${randomUUID()}`, 'phase8 source', randomUUID()]);
    const created = (await admin.query(
      `SELECT freehold.scheduled_transfer_create($1::uuid,$2::uuid,$3::uuid,'USD',1::bigint,'ONCE',clock_timestamp()+interval '2 minutes',$4::text) AS body`,
      [owner, source, destination, `p8-sched-${randomUUID()}`])).rows[0].body;
    await admin.query(`UPDATE freehold.scheduled_transfers SET next_execution_at=clock_timestamp()-interval '5 seconds' WHERE id=$1`, [created.instructionId]);
    const before = (await admin.query('SELECT next_execution_at::text AS at FROM freehold.scheduled_transfers WHERE id=$1', [created.instructionId])).rows[0].at;
    await admin.query('BEGIN');
    await admin.query('SELECT id FROM freehold.accounts WHERE id=$1 FOR UPDATE', [source]);
    await assert.rejects(scheduler.query('SELECT freehold.scheduler_run_due(5)'), error => error.code === '55P03');
    await admin.query('ROLLBACK');
    const after = (await admin.query('SELECT next_execution_at::text AS at, last_error FROM freehold.scheduled_transfers WHERE id=$1', [created.instructionId])).rows[0];
    assert.equal(after.at, before);
    assert.equal(after.last_error, null);
    const executions = (await admin.query('SELECT count(*)::int AS n FROM freehold.scheduled_transfer_executions WHERE instruction_id=$1', [created.instructionId])).rows[0].n;
    assert.equal(executions, 0);
    const journals = (await admin.query(`SELECT count(*)::int AS n FROM freehold.ledger_journals j
      JOIN freehold.scheduled_transfer_executions e ON e.operation_id=j.operation_id
      WHERE e.instruction_id=$1`, [created.instructionId])).rows[0].n;
    assert.equal(journals, 0);
  } finally {
    await admin.query('ROLLBACK').catch(() => undefined);
    await admin.end();
    await scheduler.end();
  }
});
