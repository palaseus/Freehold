#!/usr/bin/env node
// Disposable proof of why worker_inbox.attempt_count can exceed 1.
// Does not change migrations, does not connect to the persistent Compose database,
// and does not acknowledge events. A second claim is the only redelivery signal.
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { signatureFor } from './lib/evidence-signature.mjs';
import { refuseEvidenceOverwrite } from './lib/evidence-output.mjs';
import { sourceRevision } from './lib/source-revision.mjs';

const out = process.env.PHASE9A_LEASE_OUT ?? 'docs/evidence/phase9a-lease-cause.json';
refuseEvidenceOverwrite(out);
const container = `freehold-lease9a-${process.pid}`;
if (/freehold-(postgres|api|web|redis)-1/.test(container)) throw new Error('Refusing a persistent container name');

const round = value => Math.round(Number(value) * 1000) / 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tolerate = client => { client.on('error', () => undefined); return client; };

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${(result.stderr || result.stdout || '').slice(0, 400)}`);
  return result.stdout.trim();
}

const password = randomBytes(24).toString('base64url');
const rolePassword = () => randomBytes(24).toString('base64url');
docker(['run', '--name', container, '-d', '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=freehold_lease_disposable', 'postgres:16']);
let removed = false;
const removeContainer = () => {
  if (removed) return;
  removed = true;
  spawnSync('docker', ['rm', '-f', '-v', container], { encoding: 'utf8' });
};
process.on('exit', removeContainer);

try {
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const ping = spawnSync('docker', ['exec', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'freehold_lease_disposable', '-X', '-Atc', 'SELECT 1'], { encoding: 'utf8' });
    if (ping.status === 0) break;
    if (attempt === 100) throw new Error('Lease-cause database failed to start');
    await sleep(200);
  }
  const address = docker(['port', container, '5432/tcp']).split('\n').find(line => line.startsWith('127.0.0.1:'));
  if (!address) throw new Error('Lease-cause database did not publish a loopback port');
  const adminUrl = `postgresql://postgres:${encodeURIComponent(password)}@${address}/freehold_lease_disposable`;
  if (!adminUrl.includes('127.0.0.1') || !adminUrl.includes('disposable')) throw new Error('Refusing a non-disposable database URL');
  const migrated = spawnSync('node', ['scripts/migrate.mjs'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MIGRATION_DATABASE_URL: adminUrl,
      API_DATABASE_PASSWORD: rolePassword(),
      WORKER_DATABASE_PASSWORD: rolePassword(),
      VERIFIER_DATABASE_PASSWORD: rolePassword(),
      AUTH_DATABASE_PASSWORD: rolePassword(),
      SCHEDULER_DATABASE_PASSWORD: rolePassword(),
      NODE_ENV: 'test',
      DEMO_MODE: 'false',
      DEMO_BOOTSTRAP_TOKEN: '',
    },
  });
  if (migrated.status !== 0) throw new Error(`migrate failed: ${(migrated.stderr || migrated.stdout || '').slice(-800)}`);

  const admin = tolerate(new pg.Client({ connectionString: adminUrl, application_name: 'phase9a-admin' }));
  await admin.connect();
  const version = (await admin.query('SHOW server_version')).rows[0].server_version;
  const definition = (await admin.query(`SELECT pg_get_functiondef('freehold.worker_claim_outbox(uuid,integer,integer)'::regprocedure) AS def`)).rows[0].def;
  const productionFunction = {
    sha256: createHash('sha256').update(definition).digest('hex'),
    stampsLeaseWithClockTimestampInsideTheClaim: definition.includes('clock_timestamp()+make_interval(secs=>p_lease_seconds)'),
    reclaimsWhenLeaseUntilReachesClockTimestamp: definition.includes('inbox.lease_until<=clock_timestamp()'),
    conflictUpdatesAttemptWithoutALeasePredicate: /ON CONFLICT[\s\S]*attempt_count=inbox_row\.attempt_count\+1[\s\S]*WHERE inbox_row\.status IS DISTINCT FROM 'QUARANTINED'/.test(definition)
      && !/ON CONFLICT[\s\S]*lease_until/.test(definition),
  };

  const actor = randomUUID();
  await admin.query('INSERT INTO freehold.users(id, email_normalized, password_hash) VALUES ($1, $2, $3)', [actor, 'lease-probe@example.test', 'not-a-login']);
  const journals = async () => (await admin.query('SELECT count(*)::int AS n FROM freehold.ledger_journals')).rows[0].n;

  async function insertEvents(count) {
    const { rows } = await admin.query(`
      WITH ids AS (
        SELECT gen_random_uuid() AS operation_id, gen_random_uuid() AS event_id
        FROM generate_series(1, $2)
      ), req AS (
        INSERT INTO freehold.idempotency_requests(actor_id, operation, key, operation_id, request_payload, request_hash, response_status, response_body, completed_at)
        SELECT $1, 'TRANSFER', 'phase9a-' || operation_id::text, operation_id, '{}'::jsonb, decode(repeat('ab', 32), 'hex'),
               200, jsonb_build_object('operationId', operation_id::text, 'state', 'COMPLETED'), clock_timestamp()
        FROM ids
        RETURNING operation_id
      ), ev AS (
        INSERT INTO freehold.outbox_events(id, aggregate_id, operation_id, event_type, payload)
        SELECT i.event_id, i.operation_id, i.operation_id, 'phase9a.probe', '{"state":"COMPLETED"}'::jsonb
        FROM ids i JOIN req r ON r.operation_id = i.operation_id
        RETURNING id
      ), aud AS (
        INSERT INTO freehold.audit_log(actor_id, event_type, resource_id, operation_id, correlation_id, request_id, outcome)
        SELECT $1, 'phase9a.probe', i.operation_id, i.operation_id, i.operation_id, i.operation_id, 'COMPLETED'
        FROM ids i
        RETURNING id
      )
      SELECT id FROM ev`, [actor, count]);
    return rows.map(row => row.id);
  }
  async function retire(ids) {
    if (ids.length === 0) return;
    await admin.query(`UPDATE freehold.outbox_events SET dispatched_at = clock_timestamp() WHERE id = ANY($1::uuid[]) AND dispatched_at IS NULL`, [ids]);
  }
  async function inboxState(ids) {
    const { rows } = await admin.query(`
      SELECT count(*)::int AS rows,
             coalesce(max(attempt_count), 0)::int AS max_attempt,
             coalesce(min(extract(epoch FROM (lease_until - clock_timestamp()))), 0) AS min_remaining_seconds,
             count(*) FILTER (WHERE processed_at IS NULL)::int AS unprocessed,
             count(*) FILTER (WHERE status = 'PROCESSING')::int AS processing
      FROM freehold.worker_inbox WHERE event_id = ANY($1::uuid[])`, [ids]);
    const row = rows[0];
    return {
      rows: row.rows,
      maxAttempt: row.max_attempt,
      minRemainingSeconds: round(row.min_remaining_seconds),
      unprocessed: row.unprocessed,
      processing: row.processing,
    };
  }
  async function claim(client, workerId, limit, leaseSeconds, ids = null) {
    const started = performance.now();
    const { rows } = await client.query(
      `SELECT event_id, attempt_count FROM freehold.worker_claim_outbox($1::uuid, $2::integer, $3::integer)
       ${ids ? 'WHERE event_id = ANY($4::uuid[])' : ''}`,
      ids ? [workerId, limit, leaseSeconds, ids] : [workerId, limit, leaseSeconds]);
    return {
      ms: round(performance.now() - started),
      rows: rows.length,
      maxAttempt: rows.reduce((max, row) => Math.max(max, row.attempt_count), 0),
    };
  }

  const open = async name => {
    const client = tolerate(new pg.Client({ connectionString: adminUrl, application_name: name }));
    await client.connect();
    return client;
  };

  const baselineIds = await insertEvents(50);
  const baselineClient = await open('phase9a-baseline');
  const baselineClaim = await claim(baselineClient, randomUUID(), 50, 30, baselineIds);
  const baselineState = await inboxState(baselineIds);
  await baselineClient.end();
  await retire(baselineIds);

  const controlIds = await insertEvents(2);
  const controlFirst = await claim(admin, randomUUID(), 10, 5, controlIds);
  const controlAfterFirst = await inboxState(controlIds);
  const controlSecond = await claim(admin, randomUUID(), 10, 5, controlIds);
  const controlAfterSecond = await inboxState(controlIds);
  await retire(controlIds);

  const expiryIds = await insertEvents(2);
  const expiryWorker = randomUUID();
  const expiryFirst = await claim(admin, expiryWorker, 10, 5, expiryIds);
  const expiryAfterClaim = await inboxState(expiryIds);
  await sleep(6000);
  const expiryAfterSleep = await inboxState(expiryIds);
  const expirySecond = await claim(admin, randomUUID(), 10, 5, expiryIds);
  const expiryFinal = await inboxState(expiryIds);
  await retire(expiryIds);

  await admin.query(`
    CREATE FUNCTION freehold.phase9a_stall() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $$
    BEGIN
      IF current_setting('freehold.stall_claim', true) = 'on' AND NEW.attempt_count = 1 THEN
        PERFORM pg_sleep(6);
      END IF;
      RETURN NULL;
    END $$;
    GRANT EXECUTE ON FUNCTION freehold.phase9a_stall() TO freehold_owner;
    CREATE TRIGGER phase9a_stall AFTER INSERT ON freehold.worker_inbox
    FOR EACH ROW EXECUTE FUNCTION freehold.phase9a_stall()`);
  const stallIds = await insertEvents(2);
  const stallClient = await open('phase9a-stall');
  await stallClient.query(`SELECT set_config('freehold.stall_claim', 'on', false)`);
  const stallWaits = [];
  let stallSampling = true;
  const stallSampler = (async () => {
    while (stallSampling) {
      const { rows } = await admin.query(`SELECT coalesce(wait_event_type, 'none') || '/' || coalesce(wait_event, 'none') AS wait, state
        FROM pg_stat_activity WHERE application_name = 'phase9a-stall'`);
      for (const row of rows) stallWaits.push(`${row.state}:${row.wait}`);
      await sleep(200);
    }
  })();
  const stallFirst = await claim(stallClient, randomUUID(), 10, 5, stallIds);
  stallSampling = false;
  await stallSampler;
  const stallAfterFirst = await inboxState(stallIds);
  const stallSecond = await claim(admin, randomUUID(), 10, 5, stallIds);
  const stallFinal = await inboxState(stallIds);
  await stallClient.end();
  await admin.query('DROP TRIGGER phase9a_stall ON freehold.worker_inbox; DROP FUNCTION freehold.phase9a_stall()');
  await retire(stallIds);

  const concurrentIds = await insertEvents(200);
  const concurrentA = await open('phase9a-concurrent-a');
  const concurrentB = await open('phase9a-concurrent-b');
  const waits = new Set();
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const { rows } = await admin.query(`SELECT coalesce(wait_event_type, 'none') || '/' || coalesce(wait_event, 'none') AS wait
        FROM pg_stat_activity WHERE application_name LIKE 'phase9a-concurrent-%'`);
      for (const row of rows) waits.add(row.wait);
      await sleep(15);
    }
  })();
  const concurrentStarted = performance.now();
  const [callsA, callsB] = await Promise.all([
    claimLoop(concurrentA, randomUUID()),
    claimLoop(concurrentB, randomUUID()),
  ]);
  sampling = false;
  await sampler;
  const concurrentWallMs = round(performance.now() - concurrentStarted);
  const concurrentState = await inboxState(concurrentIds);
  await concurrentA.end();
  await concurrentB.end();
  await retire(concurrentIds);

  await admin.query(`
    CREATE FUNCTION freehold.phase9a_claim_gate() RETURNS boolean
    LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $$
    BEGIN
      PERFORM pg_advisory_lock(924001);
      PERFORM pg_advisory_unlock(924001);
      RETURN true;
    END $$;
    REVOKE ALL ON FUNCTION freehold.phase9a_claim_gate() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION freehold.phase9a_claim_gate() TO freehold_owner`);
  await admin.query(`
    CREATE FUNCTION freehold.worker_claim_outbox_gated(p_worker_id uuid, p_ids uuid[], p_lease_seconds integer)
    RETURNS TABLE(event_id uuid, operation_id uuid, aggregate_id uuid, event_type text, payload_version integer, payload jsonb,
     created_at timestamptz, actor_id uuid, attempt_count integer)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
    DECLARE candidate record; new_attempt integer;
    BEGIN
     IF p_worker_id IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 300 OR p_ids IS NULL THEN
      RAISE EXCEPTION 'INVALID_WORKER_CLAIM' USING ERRCODE = '22023';
     END IF;
     FOR candidate IN
      WITH gate AS MATERIALIZED (SELECT freehold.phase9a_claim_gate() AS ok)
      SELECT o.id AS event_id, o.operation_id, o.aggregate_id, o.event_type, o.payload_version, o.payload, o.created_at, i.actor_id
      FROM gate
      JOIN freehold.outbox_events o ON gate.ok
      JOIN freehold.idempotency_requests i ON i.operation_id = o.operation_id
      LEFT JOIN freehold.worker_inbox inbox ON inbox.event_id = o.id
      WHERE o.id = ANY(p_ids)
       AND o.dispatched_at IS NULL
       AND o.quarantined_at IS NULL
       AND o.available_at <= clock_timestamp()
       AND (inbox.event_id IS NULL OR (inbox.status = 'PROCESSING' AND inbox.lease_until <= clock_timestamp()))
      ORDER BY o.available_at, o.created_at, o.id
      FOR UPDATE OF o SKIP LOCKED
     LOOP
      new_attempt := NULL;
      INSERT INTO freehold.worker_inbox AS inbox_row(event_id, worker_id, status, claimed_at, lease_until, attempt_count)
      VALUES (candidate.event_id, p_worker_id, 'PROCESSING', clock_timestamp(), clock_timestamp() + make_interval(secs => p_lease_seconds), 1)
      ON CONFLICT ON CONSTRAINT worker_inbox_pkey DO UPDATE SET worker_id = EXCLUDED.worker_id, status = 'PROCESSING', claimed_at = EXCLUDED.claimed_at,
       lease_until = EXCLUDED.lease_until, attempt_count = inbox_row.attempt_count + 1, processed_at = NULL
       WHERE inbox_row.status IS DISTINCT FROM 'QUARANTINED'
      RETURNING inbox_row.attempt_count INTO new_attempt;
      IF new_attempt IS NULL THEN CONTINUE; END IF;
      UPDATE freehold.outbox_events o SET attempt_count = o.attempt_count + 1 WHERE o.id = candidate.event_id;
      RETURN QUERY SELECT candidate.event_id, candidate.operation_id, candidate.aggregate_id, candidate.event_type,
       candidate.payload_version, candidate.payload, candidate.created_at, candidate.actor_id, new_attempt;
     END LOOP;
    END $$;
    ALTER FUNCTION freehold.worker_claim_outbox_gated(uuid, uuid[], integer) OWNER TO freehold_owner`);
  const raceIds = await insertEvents(2);
  const explain = (await admin.query(`
    EXPLAIN
    WITH gate AS MATERIALIZED (SELECT freehold.phase9a_claim_gate() AS ok)
    SELECT o.id FROM gate
    JOIN freehold.outbox_events o ON gate.ok
    WHERE o.id = ANY($1::uuid[])
    FOR UPDATE OF o SKIP LOCKED`, [raceIds])).rows.map(row => row['QUERY PLAN']);
  const holder = await open('phase9a-holder');
  const gated = await open('phase9a-gated');
  const peer = await open('phase9a-peer');
  await holder.query('SELECT pg_advisory_lock(924001)');
  const gatedStarted = performance.now();
  const gatedPromise = gated.query(
    'SELECT event_id, attempt_count FROM freehold.worker_claim_outbox_gated($1::uuid, $2::uuid[], 30)',
    [randomUUID(), raceIds]);
  gatedPromise.catch(() => undefined);
  let gateWait = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await admin.query(`SELECT state, coalesce(wait_event_type, 'none') AS wait_type, coalesce(wait_event, 'none') AS wait_event
      FROM pg_stat_activity WHERE application_name = 'phase9a-gated'`);
    gateWait = rows[0] ?? null;
    if (gateWait?.wait_event === 'advisory') break;
    await sleep(50);
  }
  const locksWhileBlocked = (await admin.query(`
    SELECT l.locktype, l.mode, l.granted, coalesce(l.relation::regclass::text, '') AS relation
    FROM pg_locks l
    JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE a.application_name = 'phase9a-gated'`)).rows;
  const peerClaim = await claim(peer, randomUUID(), 10, 30, raceIds);
  const beforeUnlock = await inboxState(raceIds);
  await holder.query('SELECT pg_advisory_unlock(924001)');
  let gatedRows = [];
  let gatedError = null;
  try { gatedRows = (await gatedPromise).rows; } catch (error) { gatedError = error.message; }
  const gatedMs = round(performance.now() - gatedStarted);
  const afterGated = await inboxState(raceIds);
  await holder.end();
  await gated.end();
  await peer.end();
  await admin.query(`DROP FUNCTION freehold.worker_claim_outbox_gated(uuid, uuid[], integer); DROP FUNCTION freehold.phase9a_claim_gate()`);
  await retire(raceIds);
  const experimentObjects = (await admin.query(`SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'freehold'::regnamespace AND proname LIKE 'phase9a_%' OR proname = 'worker_claim_outbox_gated'`)).rows[0].n;
  const journalCount = await journals();
  await admin.end();

  const naturalRedelivery = concurrentState.maxAttempt > 1 && concurrentWallMs < 30000;
  const raceProven = peerClaim.rows === 2
    && beforeUnlock.minRemainingSeconds > 0
    && beforeUnlock.maxAttempt === 1
    && gatedRows.length === 2
    && Math.max(...gatedRows.map(row => row.attempt_count), 0) >= 2
    && afterGated.maxAttempt >= 2
    && gateWait?.wait_event === 'advisory'
    && !locksWhileBlocked.some(lock => lock.relation.includes('outbox_events') && lock.granted);
  const clockProven = stallFirst.maxAttempt === 1
    && stallAfterFirst.minRemainingSeconds < 0
    && stallAfterFirst.maxAttempt === 1
    && stallFinal.maxAttempt >= 2
    && stallFirst.ms > 5000;
  const trueExpiryProven = expiryAfterClaim.minRemainingSeconds > 0
    && expiryAfterSleep.minRemainingSeconds < 0
    && expiryFirst.maxAttempt === 1
    && expiryFinal.maxAttempt >= 2;
  let reproducibleCause = 'INCONCLUSIVE';
  if (raceProven) reproducibleCause = 'SNAPSHOT_RACE_ON_CONFLICT_STEALS_LIVE_LEASE';
  else if (naturalRedelivery) reproducibleCause = 'CONCURRENT_CLAIM_REDELIVERY_WITHOUT_LEASE_EXPIRY';
  const body = {
    generatedAt: new Date().toISOString(),
    reportType: 'freehold.phase9a-lease-cause',
    sourceRevision: sourceRevision(),
    persistentDatabase: false,
    containerRemoved: true,
    serverVersion: version,
    journals: journalCount,
    journalsRemainZero: journalCount === 0,
    productionFunction,
    priorPhase8: {
      source: 'docs/evidence/phase8-integrated-100k.json',
      workers: 2,
      leaseSeconds: 30,
      redeliveredBeforeCrash: 805,
      phase7RedeliveredBeforeCrash: 101,
      acknowledgmentEndToEndMaxMs: 3348.103,
      note: 'Cited from the preserved Phase 8 workload. This script did not rerun it. A 3.3 second created-to-dispatched maximum cannot expire a 30 second lease.',
    },
    baselineClaimOfFifty: { claim: baselineClaim, after: baselineState },
    controlNoContention: {
      first: controlFirst,
      afterFirst: controlAfterFirst,
      second: controlSecond,
      afterSecond: controlAfterSecond,
      secondClaimTookNothing: controlSecond.rows === 0 && controlAfterSecond.maxAttempt === 1,
    },
    trueLeaseExpiry: {
      first: expiryFirst,
      afterClaim: expiryAfterClaim,
      afterSleep: expiryAfterSleep,
      second: expirySecond,
      afterSecond: expiryFinal,
      proven: trueExpiryProven,
      note: 'The client waited past a 5 second lease before the second claim. This is the supported at-least-once path. No acknowledgement was sent.',
    },
    inTransactionLeaseClock: {
      first: stallFirst,
      afterFirst: stallAfterFirst,
      second: stallSecond,
      afterSecond: stallFinal,
      observedWaits: [...new Set(stallWaits)].slice(0, 12),
      proven: clockProven,
      note: 'An AFTER INSERT trigger slept 6 seconds inside the real claim transaction after each lease was stamped with clock_timestamp(). The trigger was removed before the later arms.',
    },
    naturalConcurrency: {
      events: concurrentIds.length,
      wallMs: concurrentWallMs,
      callsA, callsB,
      after: concurrentState,
      observedWaits: [...waits],
      redeliveryInsideLeaseWindow: naturalRedelivery,
      note: 'Both callers used the installed worker_claim_outbox. A wall time under 30 seconds cannot be lease expiry.',
    },
    snapshotRace: {
      explain,
      gateWait,
      locksWhileBlocked,
      peerWhileGatedClaimBlocked: peerClaim,
      inboxBeforePeerCommitReleased: beforeUnlock,
      gatedMs,
      gatedError,
      gatedReturned: gatedRows.map(row => ({ attemptCount: row.attempt_count })),
      after: afterGated,
      proven: raceProven,
      note: 'The gated copy keeps migration 012 claim and conflict SQL. A materialized advisory-lock gate holds the statement snapshot open before any outbox lock. The peer uses the real function and commits a fresh 30 second lease. The gated statement then resumes.',
    },
    experimentObjectsRemaining: experimentObjects,
    reproducibleCause,
    explainsPhase8Increase: raceProven || naturalRedelivery,
    optimizationApplied: false,
  };
  const report = { ...body, signature: signatureFor(body) };
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`${body.reproducibleCause} journals ${journalCount} race ${raceProven} clock ${clockProven} expiry ${trueExpiryProven} natural ${naturalRedelivery}`);
  if (!body.journalsRemainZero || experimentObjects !== 0) process.exitCode = 1;
} finally {
  removeContainer();
}

async function claimLoop(client, workerId) {
  const calls = [];
  for (;;) {
    const started = performance.now();
    const { rows } = await client.query('SELECT attempt_count FROM freehold.worker_claim_outbox($1::uuid, 50, 30)', [workerId]);
    calls.push({
      ms: round(performance.now() - started),
      rows: rows.length,
      maxAttempt: rows.reduce((max, row) => Math.max(max, row.attempt_count), 0),
    });
    if (rows.length === 0 || calls.length >= 30) break;
  }
  return calls;
}
