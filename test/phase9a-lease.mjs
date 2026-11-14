import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { assessDeployment, assembleDeployment, heartbeatState } from '../dist/src/admin/deployment-status.js';

const admin = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL, application_name: 'phase9a-admin' });
const verifier = new Client({ connectionString: process.env.VERIFY_DATABASE_URL, application_name: 'phase9a-verifier' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('phase 9A keeps a live lease and still redelivers an expired one', async () => {
  await admin.connect();
  await verifier.connect();
  const actor = randomUUID();
  const parked = [];
  const gatedClients = [];
  const probes = { worker: null, scheduler: null };
  try {
    await admin.query('INSERT INTO freehold.users(id, email_normalized, password_hash) VALUES ($1,$2,$3)', [actor, `phase9a-${actor}@example.test`, 'not-a-login']);
    const journalsBefore = (await admin.query('SELECT count(*)::int AS n FROM freehold.ledger_journals')).rows[0].n;
    const definition = (await admin.query(`SELECT pg_get_functiondef('freehold.worker_claim_outbox(uuid,integer,integer)'::regprocedure) AS def`)).rows[0].def;
    assert.match(definition, /live\.lease_until\s*>\s*clock_timestamp\(\)/);
    assert.match(definition, /inbox_row\.lease_until\s*<=\s*clock_timestamp\(\)/);
    assert.match(definition, /lease_until\s*=\s*clock_timestamp\(\)\s*\+\s*make_interval\(\s*secs\s*=>\s*p_lease_seconds\s*\)/);
    await assert.rejects(verifier.query('SELECT * FROM freehold.worker_claim_outbox($1::uuid,1,30)', [randomUUID()]), error => error.code === '42501');

    probes.worker = randomUUID();
    probes.scheduler = randomUUID();
    const missingWorker = (await admin.query(`SELECT (SELECT CASE WHEN max(seen_at) IS NULL THEN NULL ELSE floor(extract(epoch FROM clock_timestamp() - max(seen_at)))::int END FROM freehold.worker_heartbeats WHERE worker_id=$1) AS age`, [probes.worker])).rows[0].age;
    const missingScheduler = (await admin.query(`SELECT (SELECT CASE WHEN max(seen_at) IS NULL THEN NULL ELSE floor(extract(epoch FROM clock_timestamp() - max(seen_at)))::int END FROM freehold.scheduler_heartbeats WHERE scheduler_id=$1) AS age`, [probes.scheduler])).rows[0].age;
    assert.equal(missingWorker, null);
    assert.equal(missingScheduler, null);
    assert.equal(heartbeatState({ workerHeartbeatAgeSeconds: missingWorker }, 'workerHeartbeatAgeSeconds'), 'MISSING');
    assert.equal(heartbeatState({ schedulerHeartbeatAgeSeconds: missingScheduler }, 'schedulerHeartbeatAgeSeconds'), 'MISSING');
    await admin.query(`INSERT INTO freehold.worker_heartbeats(worker_id, seen_at) VALUES ($1, clock_timestamp() - interval '121 seconds')`, [probes.worker]);
    await admin.query(`INSERT INTO freehold.scheduler_heartbeats(scheduler_id, seen_at) VALUES ($1, clock_timestamp() - interval '121 seconds')`, [probes.scheduler]);
    const staleWorker = (await admin.query(`SELECT floor(extract(epoch FROM clock_timestamp() - seen_at))::int AS age FROM freehold.worker_heartbeats WHERE worker_id=$1`, [probes.worker])).rows[0].age;
    const staleScheduler = (await admin.query(`SELECT floor(extract(epoch FROM clock_timestamp() - seen_at))::int AS age FROM freehold.scheduler_heartbeats WHERE scheduler_id=$1`, [probes.scheduler])).rows[0].age;
    assert.ok(staleWorker > 120 && staleScheduler > 120);
    assert.equal(heartbeatState({ workerHeartbeatAgeSeconds: staleWorker }, 'workerHeartbeatAgeSeconds'), 'STALE');
    assert.equal(heartbeatState({ schedulerHeartbeatAgeSeconds: staleScheduler }, 'schedulerHeartbeatAgeSeconds'), 'STALE');
    await admin.query(`UPDATE freehold.worker_heartbeats SET seen_at=clock_timestamp() WHERE worker_id=$1`, [probes.worker]);
    await admin.query(`UPDATE freehold.scheduler_heartbeats SET seen_at=clock_timestamp() WHERE scheduler_id=$1`, [probes.scheduler]);
    const freshWorker = (await admin.query(`SELECT floor(extract(epoch FROM clock_timestamp() - seen_at))::int AS age FROM freehold.worker_heartbeats WHERE worker_id=$1`, [probes.worker])).rows[0].age;
    const freshScheduler = (await admin.query(`SELECT floor(extract(epoch FROM clock_timestamp() - seen_at))::int AS age FROM freehold.scheduler_heartbeats WHERE scheduler_id=$1`, [probes.scheduler])).rows[0].age;
    assert.ok(freshWorker <= 2 && freshScheduler <= 2);
    assert.equal(heartbeatState({ workerHeartbeatAgeSeconds: freshWorker }, 'workerHeartbeatAgeSeconds'), 'FRESH');
    assert.equal(heartbeatState({ schedulerHeartbeatAgeSeconds: freshScheduler }, 'schedulerHeartbeatAgeSeconds'), 'FRESH');
    await admin.query('DELETE FROM freehold.worker_heartbeats WHERE worker_id=$1', [probes.worker]);
    await admin.query('DELETE FROM freehold.scheduler_heartbeats WHERE scheduler_id=$1', [probes.scheduler]);

    const { rows: earlier } = await admin.query(`SELECT id FROM freehold.outbox_events WHERE dispatched_at IS NULL AND quarantined_at IS NULL`);
    parked.push(...earlier.map(row => row.id));
    if (earlier.length) {
      await admin.query(`UPDATE freehold.outbox_events SET available_at = clock_timestamp() + interval '1 day' WHERE id = ANY($1::uuid[])`, [earlier.map(row => row.id)]);
    }

    const control = await insertEvents(admin, actor, 1);
    const first = await claim(admin, randomUUID(), 5, control);
    assert.equal(first.maxAttempt, 1);
    assert.equal((await claim(admin, randomUUID(), 5, control)).rows, 0);
    const controlState = await inboxState(admin, control);
    assert.equal(controlState.maxAttempt, 1);
    assert.ok(controlState.minRemainingSeconds > 0);
    await retire(admin, control);

    const stalled = await insertEvents(admin, actor, 1);
    await admin.query(`
      CREATE FUNCTION freehold.phase9a_stall() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
      BEGIN
        IF current_setting('freehold.stall_claim', true) = 'on' AND NEW.attempt_count = 1 THEN PERFORM pg_sleep(6); END IF;
        RETURN NULL;
      END $$;
      GRANT EXECUTE ON FUNCTION freehold.phase9a_stall() TO freehold_owner;
      CREATE TRIGGER phase9a_stall AFTER INSERT ON freehold.worker_inbox
      FOR EACH ROW EXECUTE FUNCTION freehold.phase9a_stall()`);
    const stallClient = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL, application_name: 'phase9a-stall' });
    gatedClients.push(stallClient);
    await stallClient.connect();
    await stallClient.query(`SELECT set_config('freehold.stall_claim', 'on', false)`);
    const stalledClaim = await claim(stallClient, randomUUID(), 5, stalled);
    assert.equal(stalledClaim.maxAttempt, 1);
    assert.ok(stalledClaim.ms > 5000);
    const afterStall = await inboxState(admin, stalled);
    assert.equal(afterStall.maxAttempt, 1);
    assert.ok(afterStall.minRemainingSeconds > 0, `lease remaining ${afterStall.minRemainingSeconds}`);
    assert.equal((await claim(admin, randomUUID(), 5, stalled)).rows, 0);
    await admin.query('DROP TRIGGER phase9a_stall ON freehold.worker_inbox; DROP FUNCTION freehold.phase9a_stall()');
    await retire(admin, stalled);

    const expired = await insertEvents(admin, actor, 1);
    assert.equal((await claim(admin, randomUUID(), 5, expired)).maxAttempt, 1);
    await sleep(6000);
    const redelivered = await claim(admin, randomUUID(), 5, expired);
    assert.equal(redelivered.rows, 1);
    assert.equal(redelivered.maxAttempt, 2);
    assert.equal((await inboxState(admin, expired)).unprocessed, 1);
    await retire(admin, expired);

    const { rows: pending } = await admin.query(`SELECT id FROM freehold.outbox_events WHERE dispatched_at IS NULL AND quarantined_at IS NULL`);
    parked.push(...pending.map(row => row.id));
    if (parked.length) {
      await admin.query(`UPDATE freehold.outbox_events SET available_at = clock_timestamp() + interval '1 day' WHERE id = ANY($1::uuid[])`, [parked]);
    }
    await admin.query(`
      CREATE TABLE freehold.phase9a_race_ids(id uuid PRIMARY KEY);
      CREATE FUNCTION freehold.phase9a_claim_gate() RETURNS boolean
      LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
      BEGIN PERFORM pg_advisory_lock(924001); PERFORM pg_advisory_unlock(924001); RETURN true; END $$`);
    let gatedDef = definition.replaceAll('freehold.worker_claim_outbox', 'freehold.worker_claim_outbox_gated');
    const injected = gatedDef.replace(
      /FOR\s+candidate\s+IN\s+SELECT/i,
      'FOR candidate IN WITH gate AS MATERIALIZED (SELECT freehold.phase9a_claim_gate() AS ok) SELECT');
    assert.notEqual(injected, gatedDef);
    gatedDef = injected.replace(
      /FROM\s+freehold\.outbox_events\s+o/i,
      'FROM gate JOIN freehold.outbox_events o ON gate.ok');
    const narrowed = gatedDef.replace(
      /WHERE\s+o\.dispatched_at\s+IS\s+NULL/,
      'WHERE o.id IN (SELECT id FROM freehold.phase9a_race_ids) AND o.dispatched_at IS NULL');
    assert.notEqual(narrowed, gatedDef);
    await admin.query(narrowed);
    const race = await insertEvents(admin, actor, 2);
    await admin.query('INSERT INTO freehold.phase9a_race_ids(id) SELECT unnest($1::uuid[])', [race]);
    const holder = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL, application_name: 'phase9a-holder' });
    const gated = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL, application_name: 'phase9a-gated' });
    gatedClients.push(holder, gated);
    await holder.connect();
    await gated.connect();
    await holder.query('SELECT pg_advisory_lock(924001)');
    const gatedPromise = gated.query('SELECT attempt_count FROM freehold.worker_claim_outbox_gated($1::uuid,10,30)', [randomUUID()]);
    gatedPromise.catch(() => undefined);
    let waiting = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { rows } = await admin.query(`SELECT coalesce(wait_event, 'none') AS wait_event FROM pg_stat_activity WHERE application_name = 'phase9a-gated'`);
      waiting = rows[0]?.wait_event ?? null;
      if (waiting === 'advisory') break;
      await sleep(50);
    }
    assert.equal(waiting, 'advisory');
    const peer = await claim(admin, randomUUID(), 30, race);
    assert.equal(peer.rows, 2);
    assert.equal(peer.maxAttempt, 1);
    const before = await inboxState(admin, race);
    assert.ok(before.minRemainingSeconds > 20);
    await holder.query('SELECT pg_advisory_unlock(924001)');
    const gatedRows = (await gatedPromise).rows;
    const after = await inboxState(admin, race);
    assert.equal(gatedRows.length, 0);
    assert.equal(after.maxAttempt, 1);
    assert.equal(after.workers, 1);
    await retire(admin, race);

    const journalsAfter = (await admin.query('SELECT count(*)::int AS n FROM freehold.ledger_journals')).rows[0].n;
    assert.equal(journalsAfter, journalsBefore);
  } finally {
    if (probes.worker) await admin.query('DELETE FROM freehold.worker_heartbeats WHERE worker_id=$1', [probes.worker]).catch(() => undefined);
    if (probes.scheduler) await admin.query('DELETE FROM freehold.scheduler_heartbeats WHERE scheduler_id=$1', [probes.scheduler]).catch(() => undefined);
    await admin.query('DROP TRIGGER IF EXISTS phase9a_stall ON freehold.worker_inbox');
    await admin.query('DROP FUNCTION IF EXISTS freehold.phase9a_stall()');
    await admin.query('DROP FUNCTION IF EXISTS freehold.worker_claim_outbox_gated(uuid,integer,integer)');
    await admin.query('DROP FUNCTION IF EXISTS freehold.phase9a_claim_gate()');
    await admin.query('DROP TABLE IF EXISTS freehold.phase9a_race_ids');
    if (parked.length) {
      await admin.query(`UPDATE freehold.outbox_events SET available_at = clock_timestamp() WHERE id = ANY($1::uuid[]) AND dispatched_at IS NULL`, [parked]);
    }
    await Promise.all(gatedClients.map(client => client.end().catch(() => undefined)));
    await verifier.end();
    await admin.end();
  }
});

test('heartbeat telemetry is distinct from a measured missing or stale heartbeat', () => {
  const ready = {
    databaseRead: true,
    activeMigration: '021_phase9a_claim_lease.sql',
    expectedMigration: '021_phase9a_claim_lease.sql',
    archiveMode: 'on',
    sandboxEnabled: false,
    demoEnabled: false,
    writesSuspended: false,
    workerHeartbeatAgeSeconds: 1,
    schedulerHeartbeatAgeSeconds: 1,
    openCriticalIncidents: 0,
    runtimeRolesConfined: true,
    sourceRevision: 'abc123',
    lastVerificationOutcome: 'VERIFIED',
    lastBackupOffsite: true,
    lastRecoveryOutcome: 'VERIFIED',
  };
  assert.equal(heartbeatState(null, 'workerHeartbeatAgeSeconds'), 'UNAVAILABLE');
  assert.equal(heartbeatState({}, 'workerHeartbeatAgeSeconds'), 'UNAVAILABLE');
  assert.equal(heartbeatState({ workerHeartbeatAgeSeconds: null }, 'workerHeartbeatAgeSeconds'), 'MISSING');
  assert.equal(heartbeatState({ workerHeartbeatAgeSeconds: 121 }, 'workerHeartbeatAgeSeconds'), 'STALE');
  assert.equal(heartbeatState({ workerHeartbeatAgeSeconds: 0 }, 'workerHeartbeatAgeSeconds'), 'FRESH');
  const unavailable = assessDeployment({ ...ready, workerHeartbeatState: 'UNAVAILABLE', schedulerHeartbeatState: 'UNAVAILABLE', workerHeartbeatAgeSeconds: null, schedulerHeartbeatAgeSeconds: null });
  assert.equal(unavailable.status, 'INCOMPLETE');
  assert.match(unavailable.blockers.join(' '), /telemetry is unavailable/);
  const missing = assessDeployment({ ...ready, workerHeartbeatState: 'MISSING', schedulerHeartbeatState: 'FRESH', workerHeartbeatAgeSeconds: null });
  assert.equal(missing.status, 'NOT_READY');
  assert.match(missing.blockers.join(' '), /Worker heartbeat is missing/);
  const stale = assessDeployment({ ...ready, workerHeartbeatState: 'STALE', schedulerHeartbeatState: 'FRESH', workerHeartbeatAgeSeconds: 121 });
  assert.equal(stale.status, 'NOT_READY');
  assert.match(stale.blockers.join(' '), /stale/);
  const recovered = assessDeployment({ ...ready, workerHeartbeatState: 'FRESH', schedulerHeartbeatState: 'FRESH', workerHeartbeatAgeSeconds: 1 });
  assert.equal(recovered.status, 'READY');
  const fromDatabase = assembleDeployment({
    activeMigration: '034_phase16_2_institution_usage_execute_privileges.sql',
    archiveMode: 'on',
    sandboxEnabled: false,
    demoEnabled: false,
    writesSuspended: false,
    workerHeartbeatAgeSeconds: null,
    schedulerHeartbeatAgeSeconds: 4,
    openCriticalIncidents: 0,
    runtimeRolesConfined: true,
  }, { FREEHOLD_SOURCE_REVISION: 'abc123' });
  assert.equal(fromDatabase.runtime.workerHeartbeatState, 'MISSING');
  assert.equal(fromDatabase.runtime.schedulerHeartbeatState, 'FRESH');
  assert.equal(fromDatabase.status, 'NOT_READY');
  const noKey = assembleDeployment({
    activeMigration: '034_phase16_2_institution_usage_execute_privileges.sql',
    archiveMode: 'on',
    sandboxEnabled: false,
    demoEnabled: false,
    writesSuspended: false,
    openCriticalIncidents: 0,
    runtimeRolesConfined: true,
  }, { FREEHOLD_SOURCE_REVISION: 'abc123' });
  assert.equal(noKey.runtime.workerHeartbeatState, 'UNAVAILABLE');
  assert.equal(noKey.runtime.schedulerHeartbeatState, 'UNAVAILABLE');
  assert.equal(noKey.status, 'INCOMPLETE');
});

async function insertEvents(client, actor, count) {
  const { rows } = await client.query(`
    WITH ids AS (
      SELECT gen_random_uuid() AS operation_id, gen_random_uuid() AS event_id FROM generate_series(1, $2)
    ), req AS (
      INSERT INTO freehold.idempotency_requests(actor_id, operation, key, operation_id, request_payload, request_hash, response_status, response_body, completed_at)
      SELECT $1, 'TRANSFER', 'phase9a-' || operation_id::text, operation_id, '{}'::jsonb, decode(repeat('cd', 32), 'hex'),
             200, jsonb_build_object('operationId', operation_id::text, 'state', 'COMPLETED'), clock_timestamp()
      FROM ids RETURNING operation_id
    ), ev AS (
      INSERT INTO freehold.outbox_events(id, aggregate_id, operation_id, event_type, payload)
      SELECT i.event_id, i.operation_id, i.operation_id, 'phase9a.probe', '{"state":"COMPLETED"}'::jsonb
      FROM ids i JOIN req r ON r.operation_id = i.operation_id RETURNING id
    ), aud AS (
      INSERT INTO freehold.audit_log(actor_id, event_type, resource_id, operation_id, correlation_id, request_id, outcome)
      SELECT $1, 'phase9a.probe', i.operation_id, i.operation_id, i.operation_id, i.operation_id, 'COMPLETED' FROM ids i RETURNING id
    )
    SELECT id FROM ev`, [actor, count]);
  return rows.map(row => row.id);
}
async function claim(client, workerId, leaseSeconds, ids) {
  const started = performance.now();
  const { rows } = await client.query(
    'SELECT event_id, attempt_count FROM freehold.worker_claim_outbox($1::uuid, 10, $2::integer) WHERE event_id = ANY($3::uuid[])',
    [workerId, leaseSeconds, ids]);
  return { ms: performance.now() - started, rows: rows.length, maxAttempt: rows.reduce((max, row) => Math.max(max, row.attempt_count), 0) };
}
async function inboxState(client, ids) {
  const { rows } = await client.query(`
    SELECT coalesce(max(attempt_count), 0)::int AS max_attempt,
           coalesce(min(extract(epoch FROM (lease_until - clock_timestamp()))), 0) AS min_remaining_seconds,
           count(*) FILTER (WHERE processed_at IS NULL)::int AS unprocessed,
           count(DISTINCT worker_id)::int AS workers
    FROM freehold.worker_inbox WHERE event_id = ANY($1::uuid[])`, [ids]);
  return { maxAttempt: rows[0].max_attempt, minRemainingSeconds: Number(rows[0].min_remaining_seconds), unprocessed: rows[0].unprocessed, workers: rows[0].workers };
}
async function retire(client, ids) {
  await client.query('UPDATE freehold.outbox_events SET dispatched_at = clock_timestamp() WHERE id = ANY($1::uuid[]) AND dispatched_at IS NULL', [ids]);
}
