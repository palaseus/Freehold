#!/usr/bin/env node
// Disposable scheduler lifecycle. A killed process must not post a transfer
// that had not committed. A commit that finished before the kill remains.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { refuseEvidenceOverwrite } from './lib/evidence-output.mjs';
import { sourceRevision } from './lib/source-revision.mjs';

const options = '-c statement_timeout=15000 -c idle_in_transaction_session_timeout=15000 -c client_connection_check_interval=2000 -c lock_timeout=15000';
const schedulerUrl = process.env.SCHEDULER_DATABASE_URL;
const childMode = process.argv.includes('--child') || process.argv.includes('--blocked');

if (childMode) {
  const client = new pg.Client({ connectionString: schedulerUrl, options });
  await client.connect();
  try {
    if (process.argv.includes('--blocked')) {
      await client.query('SELECT freehold.scheduler_run_due(1)');
      process.stdout.write('RETURNED\n');
    } else {
      await client.query('BEGIN');
      await client.query('SELECT freehold.scheduler_run_due(1)');
      if (process.argv.includes('--commit')) {
        await client.query('COMMIT');
        process.stdout.write('COMMITTED\n');
      } else process.stdout.write('OPEN\n');
      await new Promise(() => {});
    }
  } catch (error) {
    process.stdout.write(`ERROR ${error.code ?? 'UNKNOWN'}\n`);
    process.exitCode = 1;
  } finally {
    try { await client.end(); } catch { /* killed or canceled */ }
  }
  process.exit(process.exitCode ?? 0);
}

const adminUrl = process.env.PHASE8_ADMIN_URL;
const out = process.env.PHASE8_SCHEDULER_OUT ?? 'docs/evidence/phase8-scheduler-lifecycle.json';
refuseEvidenceOverwrite(out);
if (!adminUrl || !schedulerUrl || !/127\.0\.0\.1|localhost/.test(adminUrl) || !adminUrl.includes('disposable')) {
  throw new Error('Refusing a scheduler lifecycle drill that is not aimed at a loopback disposable database');
}
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
const evidence = [];
const record = (name, ok, detail) => evidence.push({ name, ok, ...detail });
const user = async role => {
  const id = randomUUID();
  await admin.query('INSERT INTO freehold.users(id,email_normalized,password_hash,role) VALUES ($1,$2,$3,$4)', [id, `life-${id}@example.test`, 'not-a-login', role]);
  return id;
};
await admin.query('UPDATE freehold.ledger_settings SET sandbox_enabled=true WHERE singleton');
await admin.query('UPDATE freehold.institutional_control SET writes_suspended=false, suspension_reason=NULL, suspended_by=NULL, suspended_at=NULL WHERE singleton');
const funder = await user('ADMIN');
const owner = await user('USER');
const payee = await user('USER');
const accountOf = async person => (await admin.query('SELECT freehold.create_account($1,$2,$3,$4) AS body', [person, 'USD', `acct-${randomUUID()}`, randomUUID()])).rows[0].body.accountId;
const source = await accountOf(owner);
const destination = await accountOf(payee);
await admin.query('SELECT freehold.sandbox_fund_account($1,$2,5000,$3,$4,$5)', [funder, source, `fund-${randomUUID()}`, 'lifecycle', randomUUID()]);
const due = async amount => {
  await admin.query(`UPDATE freehold.scheduled_transfers SET status='CANCELLED' WHERE status='ACTIVE'`);
  const created = await admin.query(`SELECT freehold.scheduled_transfer_create($1,$2,$3,'USD',$4::bigint,'ONCE',clock_timestamp()+interval '2 minutes',$5) AS body`, [owner, source, destination, amount, `life-${randomUUID()}`]);
  const id = created.rows[0].body.instructionId;
  await admin.query(`UPDATE freehold.scheduled_transfers SET next_execution_at=clock_timestamp()-interval '5 seconds' WHERE id=$1`, [id]);
  return id;
};
const journalsFor = async instruction => (await admin.query(`SELECT count(*)::int AS count FROM freehold.scheduled_transfer_executions e JOIN freehold.ledger_journals j ON j.operation_id=e.operation_id WHERE e.instruction_id=$1`, [instruction])).rows[0].count;
const stateOf = async instruction => (await admin.query(`SELECT status, next_execution_at<=clock_timestamp() AS still_due, last_error FROM freehold.scheduled_transfers WHERE id=$1`, [instruction])).rows[0];
const waitFor = async (sql, params, ms = 15000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const row = (await admin.query(sql, params)).rows[0];
    if (row && Object.values(row).every(value => value !== null && value !== false && value !== 0)) return row;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return null;
};
const startScheduler = () => {
  const child = spawn(process.execPath, ['dist/src/scheduler.js'], {
    env: { SCHEDULER_DATABASE_URL: schedulerUrl, SCHEDULER_POLL_MS: '1000', PATH: process.env.PATH ?? '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk.toString()}`.slice(-400); });
  child.stderrText = () => stderr.replace(/postgres(?:ql)?:\/\/\S+/g, 'postgresql://REDACTED');
  return child;
};
const waitExit = (child, ms) => new Promise(resolve => {
  const timer = setTimeout(() => resolve({ timeout: true, code: null, signal: null }), ms);
  child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ timeout: false, code, signal }); });
});
const waitLine = (child, ms = 10000) => new Promise(resolve => {
  let text = '';
  const timer = setTimeout(() => resolve(text), ms);
  child.stdout.on('data', chunk => {
    text += chunk.toString();
    if (text.includes('\n')) { clearTimeout(timer); resolve(text.trim()); }
  });
});
const lockWaiter = () => waitFor(`SELECT l.pid AS ready FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
  WHERE NOT l.granted AND a.usename='freehold_scheduler' AND a.pid<>pg_backend_pid() LIMIT 1`, [], 12000);
const backendState = async pid => (await admin.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1::int) AS alive,
  EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1::int AND NOT granted) AS waiting`, [pid])).rows[0];

async function signalDuringLock(signal) {
  const instruction = await due(signal === 'SIGKILL' ? 6 : 7);
  await admin.query('BEGIN');
  let child;
  let pid = null;
  let releaseMs = null;
  let alive = null;
  let waiting = null;
  try {
    await admin.query('SELECT id FROM freehold.accounts WHERE id=$1 FOR UPDATE', [source]);
    child = startScheduler();
    const connected = await lockWaiter();
    pid = connected?.ready ?? null;
    const marked = Date.now();
    child.kill(signal);
    await waitExit(child, 25000);
    if (pid != null) {
      const released = await waitFor(`SELECT (NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1::int AND NOT granted)) AS ready`, [pid], 20000);
      releaseMs = released ? Date.now() - marked : null;
      const still = await backendState(pid);
      alive = still.alive === true;
      waiting = still.waiting === true;
    }
  } finally { await admin.query('ROLLBACK'); }
  const before = await journalsFor(instruction);
  const pending = await stateOf(instruction);
  const restarted = startScheduler();
  const posted = await waitFor(`SELECT (count(*)=1) AS ready FROM freehold.scheduled_transfer_executions WHERE instruction_id=$1 AND outcome='COMPLETED'`, [instruction]);
  restarted.kill('SIGTERM');
  await waitExit(restarted, 25000);
  await new Promise(resolve => setTimeout(resolve, 2000));
  const after = await journalsFor(instruction);
  return { instruction, pid, releaseMs, alive, waiting, before, pending, posted: posted !== null, after,
    stderr: `${child?.stderrText?.() ?? ''} ${restarted.stderrText?.() ?? ''}`.trim() };
}

const term = await signalDuringLock('SIGTERM');
record('sigterm_during_lock', term.before === 0 && term.pending?.still_due === true && term.pending?.last_error == null && term.waiting === false && term.posted && term.after === 1, {
  lockReleaseMs: term.releaseMs, backendStillPresent: term.alive, backendStillWaiting: term.waiting,
  journalsBeforeRestart: term.before, journalsAfterRestart: term.after, stillDue: term.pending?.still_due ?? null, lastError: term.pending?.last_error ?? null,
  ...(term.posted ? {} : { schedulerStderr: term.stderr }),
});

const killed = await signalDuringLock('SIGKILL');
record('sigkill_during_lock', killed.before === 0 && killed.pending?.still_due === true && killed.pending?.last_error == null && killed.waiting === false && killed.posted && killed.after === 1, {
  lockReleaseMs: killed.releaseMs, backendStillPresent: killed.alive, backendStillWaiting: killed.waiting, pidMustDisappear: false,
  journalsBeforeRestart: killed.before, journalsAfterRestart: killed.after, stillDue: killed.pending?.still_due ?? null,
  ...(killed.posted ? {} : { schedulerStderr: killed.stderr }),
});

const cancelInstruction = await due(4);
await admin.query('BEGIN');
let cancelCode = null;
try {
  await admin.query('SELECT id FROM freehold.accounts WHERE id=$1 FOR UPDATE', [source]);
  const blocked = spawn(process.execPath, ['scripts/phase8-scheduler-lifecycle.mjs', '--blocked'], { env: { ...process.env, SCHEDULER_DATABASE_URL: schedulerUrl }, stdio: ['ignore', 'pipe', 'ignore'] });
  const waiter = await lockWaiter();
  if (waiter?.ready) await admin.query('SELECT pg_cancel_backend($1::int)', [waiter.ready]);
  cancelCode = await waitLine(blocked, 12000);
  await waitExit(blocked, 5000);
} finally { await admin.query('ROLLBACK'); }
const cancelState = await stateOf(cancelInstruction);
record('client_cancel', cancelCode?.startsWith('ERROR 57014') === true && await journalsFor(cancelInstruction) === 0 && cancelState.still_due === true && cancelState.last_error == null, {
  child: cancelCode, journals: await journalsFor(cancelInstruction), stillDue: cancelState.still_due, lastError: cancelState.last_error,
});

async function nearCommit(commit) {
  const instruction = await due(commit ? 3 : 2);
  const child = spawn(process.execPath, ['scripts/phase8-scheduler-lifecycle.mjs', '--child', ...(commit ? ['--commit'] : [])], {
    env: { ...process.env, SCHEDULER_DATABASE_URL: schedulerUrl }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const line = await waitLine(child, 10000);
  const visible = await journalsFor(instruction);
  const marked = Date.now();
  child.kill('SIGKILL');
  await waitExit(child, 5000);
  let settled = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const open = (await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='freehold_scheduler' AND state='idle in transaction'`)).rows[0].n;
    if (open === 0) { settled = true; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const journals = await journalsFor(instruction);
  const state = await stateOf(instruction);
  return { instruction, line, visible, journals, state, settled, settleMs: Date.now() - marked };
}
const open = await nearCommit(false);
record('death_before_commit', open.line === 'OPEN' && open.visible === 0 && open.journals === 0 && open.state.still_due === true && open.settled, {
  journalsWhileOpen: open.visible, journalsAfterDeath: open.journals, sessionCleared: open.settled, clearMs: open.settleMs, stillDue: open.state.still_due,
});
const closed = await nearCommit(true);
const replay = new pg.Client({ connectionString: schedulerUrl, options });
await replay.connect();
const replayResult = await replay.query('SELECT freehold.scheduler_run_due(1) AS body');
await replay.end();
const replayJournals = await journalsFor(closed.instruction);
record('death_after_commit', closed.line === 'COMMITTED' && closed.journals === 1 && replayJournals === 1 && replayResult.rows[0].body.processed === 0, {
  journalsAfterCommit: closed.journals, journalsAfterReplay: replayJournals, replayProcessed: replayResult.rows[0].body.processed,
});

const shared = await due(5);
const first = new pg.Client({ connectionString: schedulerUrl, options });
const second = new pg.Client({ connectionString: schedulerUrl, options });
await first.connect();
await second.connect();
await first.query('BEGIN');
const firstRun = first.query('SELECT freehold.scheduler_run_due(1) AS body');
await firstRun;
const secondRun = await second.query('SELECT freehold.scheduler_run_due(1) AS body');
await first.query('COMMIT');
await first.end();
await second.end();
const sharedJournals = await journalsFor(shared);
record('row_lock_lease', secondRun.rows[0].body.processed === 0 && sharedJournals === 1, {
  secondProcessed: secondRun.rows[0].body.processed, journals: sharedJournals,
  note: 'The scheduler has no lease timestamp. The instruction row lock is the lease and ends when the transaction ends.',
});

const beforeExhaust = (await admin.query('SELECT count(*)::int AS n FROM freehold.ledger_journals')).rows[0].n;
const max = Number((await admin.query('SHOW max_connections')).rows[0].max_connections);
const reserved = Number((await admin.query('SHOW superuser_reserved_connections')).rows[0].superuser_reserved_connections);
const holders = [];
let refused = false;
try {
  for (let index = 0; index < max; index += 1) {
    const holder = new pg.Client({ connectionString: schedulerUrl, connectionTimeoutMillis: 2000 });
    try { await holder.connect(); holders.push(holder); }
    catch { refused = true; break; }
  }
} finally {
  for (const holder of holders) { try { await holder.end(); } catch { /* already closed */ } }
}
const afterExhaust = (await admin.query('SELECT count(*)::int AS n FROM freehold.ledger_journals')).rows[0].n;
record('connection_exhaustion', refused && afterExhaust === beforeExhaust && holders.length >= max - reserved - 5, {
  opened: holders.length, maxConnections: max, superuserReserved: reserved, refused, journalsUnchanged: afterExhaust === beforeExhaust,
});

const pairA = startScheduler();
const pairB = startScheduler();
const paired = await due(1);
const once = await waitFor(`SELECT (count(*)=1) AS ready FROM freehold.scheduled_transfer_executions WHERE instruction_id=$1`, [paired]);
await new Promise(resolve => setTimeout(resolve, 1500));
pairA.kill('SIGTERM');
pairB.kill('SIGTERM');
await waitExit(pairA, 25000);
await waitExit(pairB, 25000);
const pairedJournals = await journalsFor(paired);
record('two_schedulers', once !== null && pairedJournals === 1, {
  journals: pairedJournals,
  ...(once ? {} : { schedulerStderr: `${pairA.stderrText?.() ?? ''} ${pairB.stderrText?.() ?? ''}`.trim() }),
});

const report = {
  generatedAt: new Date().toISOString(),
  reportType: 'freehold.phase8-scheduler-lifecycle',
  sourceRevision: sourceRevision(),
  signature: null,
  persistentDatabase: false,
  scenarios: evidence,
  passed: evidence.every(item => item.ok),
};
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`${report.passed ? 'PASS' : 'FAIL'} scheduler lifecycle ${evidence.filter(item => item.ok).length}/${evidence.length}`);
await admin.end();
if (!report.passed) process.exitCode = 1;
