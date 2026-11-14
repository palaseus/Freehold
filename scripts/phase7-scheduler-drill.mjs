#!/usr/bin/env node
// Starts the real scheduler process. SIGTERM and SIGKILL are process signals.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { refuseEvidenceOverwrite } from './lib/evidence-output.mjs';
import pg from 'pg';

const adminUrl = process.env.PHASE7_ADMIN_URL;
const schedulerUrl = process.env.SCHEDULER_DATABASE_URL;
const out = process.env.PHASE7_SCHEDULER_OUT ?? 'docs/evidence/scheduler-drill-latest.json';
refuseEvidenceOverwrite(out);
if (!adminUrl || !schedulerUrl || !/127\.0\.0\.1|localhost/.test(adminUrl) || !adminUrl.includes('disposable')) {
  throw new Error('Refusing a scheduler drill that is not aimed at a loopback disposable database');
}
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
const evidence = [];
const record = (name, ok, detail) => evidence.push({ name, ok, ...detail });

const user = async (role) => {
  const id = randomUUID();
  await admin.query('INSERT INTO freehold.users(id,email_normalized,password_hash,role) VALUES ($1,$2,$3,$4)',
    [id, `sched-${id}@example.test`, 'scheduler-drill-not-a-login', role]);
  return id;
};
const accountOf = async (owner) => {
  const created = await admin.query('SELECT freehold.create_account($1,$2,$3,$4) AS body', [owner, 'USD', `acct-${randomUUID()}`, randomUUID()]);
  return created.rows[0].body.accountId;
};
await admin.query('UPDATE freehold.ledger_settings SET sandbox_enabled=true WHERE singleton');
await admin.query('UPDATE freehold.institutional_control SET writes_suspended=false, suspension_reason=NULL, suspended_by=NULL, suspended_at=NULL WHERE singleton');
const funder = await user('ADMIN');
const owner = await user('USER');
const payee = await user('USER');
const source = await accountOf(owner);
const destination = await accountOf(payee);
await admin.query('SELECT freehold.sandbox_fund_account($1,$2,5000,$3,$4,$5)', [funder, source, `fund-${randomUUID()}`, 'scheduler drill', randomUUID()]);

const due = async (amount, cadence = 'ONCE') => {
  const created = await admin.query(
    `SELECT freehold.scheduled_transfer_create($1,$2,$3,'USD',$4::bigint,$5,clock_timestamp()+interval '2 minutes',$6) AS body`,
    [owner, source, destination, amount, cadence, `sched-${randomUUID()}`]);
  const id = created.rows[0].body.instructionId;
  await admin.query(`UPDATE freehold.scheduled_transfers SET next_execution_at=clock_timestamp()-interval '5 seconds' WHERE id=$1`, [id]);
  return id;
};
const startScheduler = () => {
  const child = spawn(process.execPath, ['dist/src/scheduler.js'], {
    env: { SCHEDULER_DATABASE_URL: schedulerUrl, SCHEDULER_POLL_MS: '1000', PATH: process.env.PATH ?? '' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return child;
};
const waitExit = (child, ms) => new Promise(resolve => {
  const timer = setTimeout(() => resolve({ timeout: true, code: null, signal: null }), ms);
  child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ timeout: false, code, signal }); });
});
const waitFor = async (sql, params, ms = 15000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const row = (await admin.query(sql, params)).rows[0];
    if (row && Object.values(row).every(value => value !== null && value !== false && value !== 0)) return row;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return null;
};
const journalsFor = async (instruction) => (await admin.query(
  `SELECT count(*)::int AS count FROM freehold.scheduled_transfer_executions e
   JOIN freehold.ledger_journals j ON j.operation_id=e.operation_id WHERE e.instruction_id=$1`, [instruction])).rows[0].count;
const balance = async () => (await admin.query('SELECT available_minor::text AS available FROM freehold.accounts WHERE id=$1', [source])).rows[0].available;

const one = await due(7);
const graceful = startScheduler();
const posted = await waitFor(`SELECT (count(*)=1) AS ready FROM freehold.scheduled_transfer_executions WHERE instruction_id=$1 AND outcome='COMPLETED'`, [one]);
const beat = (await admin.query(`SELECT count(*)::int AS n FROM freehold.scheduler_heartbeats WHERE seen_at>clock_timestamp()-interval '30 seconds'`)).rows[0].n;
graceful.kill('SIGTERM');
const term = await waitExit(graceful, 25000);
record('sigterm_exit', term.code === 0 && posted !== null && beat >= 1, { exitCode: term.code, signal: term.signal, posted: posted !== null, journals: await journalsFor(one), heartbeats: beat });

const killedInstruction = await due(5);
await admin.query('BEGIN');
let killed;
let connected = null;
let killResult = { timeout: true, code: null, signal: null };
let waiterPid = null;
let backendGone = false;
let backendAlive = false;
let backendWaiting = false;
try {
  // Hold the source account so execute_internal_transfer blocks inside the
  // scheduler's transaction. Disconnect detection or lock_timeout must end that
  // wait without pg_terminate_backend. The backend may remain until its socket
  // closes, but it must not still be waiting or able to post.
  await admin.query('SELECT id FROM freehold.accounts WHERE id=$1 FOR UPDATE', [source]);
  killed = startScheduler();
  connected = await waitFor(
    `SELECT l.pid AS ready FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
     WHERE NOT l.granted AND a.usename='freehold_scheduler' AND a.pid<>pg_backend_pid() LIMIT 1`,
    [], 8000);
  waiterPid = connected?.ready ?? null;
  killed.kill('SIGKILL');
  killResult = await waitExit(killed, 5000);
  if (waiterPid !== null) {
    const released = await waitFor(
      `SELECT (NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1::integer)
        OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1::integer AND NOT granted)) AS ready`,
      [waiterPid], 12000);
    const still = (await admin.query(
      `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1::integer) AS alive,
              EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1::integer AND NOT granted) AS waiting`,
      [waiterPid])).rows[0];
    backendGone = released !== null && still.waiting !== true;
    backendAlive = still.alive === true;
    backendWaiting = still.waiting === true;
  }
} finally {
  await admin.query('ROLLBACK');
}
await new Promise(resolve => setTimeout(resolve, 2000));
const beforeRestart = await journalsFor(killedInstruction);
const scheduleAfterKill = (await admin.query(
  `SELECT next_execution_at<=clock_timestamp() AS still_due, last_error IS NULL AS clean
   FROM freehold.scheduled_transfers WHERE id=$1`, [killedInstruction])).rows[0];
const restarted = startScheduler();
const resumed = await waitFor(`SELECT (count(*)=1) AS ready FROM freehold.scheduled_transfer_executions WHERE instruction_id=$1 AND outcome='COMPLETED'`, [killedInstruction]);
restarted.kill('SIGTERM');
await waitExit(restarted, 25000);
const afterRestart = await journalsFor(killedInstruction);
await new Promise(resolve => setTimeout(resolve, 2000));
const afterSettle = await journalsFor(killedInstruction);
record('sigkill_restart', killResult.signal === 'SIGKILL' && connected !== null && backendGone && !backendWaiting && scheduleAfterKill?.still_due === true && scheduleAfterKill?.clean === true && beforeRestart === 0 && resumed !== null && afterRestart === 1 && afterSettle === 1, {
  signal: killResult.signal, connectedBeforeKill: connected !== null, waiterPid,
  lockWaitEndedWithoutTerminate: backendGone, backendStillPresent: backendAlive, backendStillWaiting: backendWaiting, terminateCalled: false,
  stillDue: scheduleAfterKill?.still_due ?? null, lastErrorCleared: scheduleAfterKill?.clean ?? null,
  journalsBeforeRestart: beforeRestart, journalsAfterRestart: afterRestart, journalsAfterSettle: afterSettle,
});

const shared = await due(3);
const first = startScheduler();
const second = startScheduler();
const once = await waitFor(`SELECT (count(*)=1) AS ready FROM freehold.scheduled_transfer_executions WHERE instruction_id=$1`, [shared]);
await new Promise(resolve => setTimeout(resolve, 2500));
first.kill('SIGTERM');
second.kill('SIGTERM');
await waitExit(first, 25000);
await waitExit(second, 25000);
const sharedExecutions = (await admin.query('SELECT count(*)::int AS count FROM freehold.scheduled_transfer_executions WHERE instruction_id=$1', [shared])).rows[0].count;
record('concurrent_schedulers', once !== null && sharedExecutions === 1 && await journalsFor(shared) === 1, { executions: sharedExecutions, journals: await journalsFor(shared) });

const recurring = await due(4, 'DAILY');
const recur = startScheduler();
await waitFor(`SELECT (status='ACTIVE' AND last_status='COMPLETED') AS ready FROM freehold.scheduled_transfers WHERE id=$1`, [recurring]);
const next = (await admin.query('SELECT next_execution_at > clock_timestamp() AS future FROM freehold.scheduled_transfers WHERE id=$1', [recurring])).rows[0].future;
recur.kill('SIGTERM');
await waitExit(recur, 25000);
record('recurring_advances', next === true && await journalsFor(recurring) === 1, { journals: await journalsFor(recurring), nextInFuture: next });

const cancelled = await due(2);
await admin.query(`SELECT freehold.scheduled_transfer_cancel($1,$2)`, [owner, cancelled]);
const cancelRun = startScheduler();
await new Promise(resolve => setTimeout(resolve, 2500));
cancelRun.kill('SIGTERM');
await waitExit(cancelRun, 25000);
const cancelExec = (await admin.query('SELECT count(*)::int AS count FROM freehold.scheduled_transfer_executions WHERE instruction_id=$1', [cancelled])).rows[0].count;
record('cancel_blocks_execution', cancelExec === 0, { executions: cancelExec });

const poor = await due(100000);
const beforePoor = await balance();
const poorRun = startScheduler();
const poorRow = await waitFor(`SELECT outcome IS NOT NULL AS ready, outcome FROM freehold.scheduled_transfer_executions WHERE instruction_id=$1`, [poor]);
poorRun.kill('SIGTERM');
await waitExit(poorRun, 25000);
const afterPoor = await balance();
record('insufficient_funds', poorRow?.outcome === 'REJECTED' && beforePoor === afterPoor && await journalsFor(poor) === 0, { outcome: poorRow?.outcome ?? null, balanceUnchanged: beforePoor === afterPoor });

await admin.query(`UPDATE freehold.accounts SET status='FROZEN' WHERE id=$1`, [source]);
const frozen = await due(1);
const frozenRun = startScheduler();
const frozenRow = await waitFor(`SELECT outcome IS NOT NULL AS ready, outcome FROM freehold.scheduled_transfer_executions WHERE instruction_id=$1`, [frozen]);
frozenRun.kill('SIGTERM');
await waitExit(frozenRun, 25000);
record('frozen_account', frozenRow?.outcome === 'REJECTED' && await journalsFor(frozen) === 0, { outcome: frozenRow?.outcome ?? null });
await admin.query(`UPDATE freehold.accounts SET status='ACTIVE' WHERE id=$1`, [source]);

await admin.query(`UPDATE freehold.institutional_control SET writes_suspended=true, suspension_reason='scheduler drill', suspended_by=$1, suspended_at=clock_timestamp() WHERE singleton`, [funder]);
const suspended = await due(1);
const suspendRun = startScheduler();
const suspendState = await waitFor(`SELECT last_error IS NOT NULL AS ready, last_error FROM freehold.scheduled_transfers WHERE id=$1`, [suspended]);
suspendRun.kill('SIGTERM');
await waitExit(suspendRun, 25000);
record('emergency_suspension', typeof suspendState?.last_error === 'string' && suspendState.last_error.includes('FINANCIAL_WRITES_SUSPENDED') && await journalsFor(suspended) === 0,
  { lastError: suspendState?.last_error ?? null });
await admin.query('UPDATE freehold.institutional_control SET writes_suspended=false, suspension_reason=NULL, suspended_by=NULL, suspended_at=NULL WHERE singleton');

const report = {
  generatedAt: new Date().toISOString(),
  reportType: 'freehold.phase7-scheduler-drill',
  sourceRevision: 'unknown',
  signature: null,
  processSignals: true,
  scenarios: evidence,
  passed: evidence.every(item => item.ok),
};
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`${report.passed ? 'PASS' : 'FAIL'} scheduler drill ${evidence.filter(item => item.ok).length}/${evidence.length}`);
await admin.end();
if (!report.passed) process.exitCode = 1;
