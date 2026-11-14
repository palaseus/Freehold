#!/usr/bin/env node
// Read-only deployment gate. It does not migrate, post, or change balances.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { refuseEvidenceOverwrite } from './lib/evidence-output.mjs';
import { sourceRevision } from './lib/source-revision.mjs';
import { backupProblem, productionEvidenceChecks } from './lib/deployment-evidence.mjs';
import { Client } from 'pg';

const jsonOnly = process.argv.includes('--json');
const outIndex = process.argv.indexOf('--out');
const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : null;
refuseEvidenceOverwrite(outPath);
const checks = [];
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
const add = (id, status, detail) => checks.push({ id, status, detail });

const migrationFiles = readdirSync(new URL('../db/migrations/', import.meta.url))
  .filter(name => name.endsWith('.sql')).sort();
const expectedMigration = process.env.CHECK_EXPECTED_MIGRATION || migrationFiles.at(-1);

let client;
const databaseUrl = process.env.CHECK_DATABASE_URL;
if (!databaseUrl) {
  for (const id of ['database_connection', 'schema_version', 'runtime_roles', 'api_customer_reads', 'verifier_boundary', 'wal_archive', 'worker_heartbeat', 'sandbox_disabled', 'demo_disabled']) {
    add(id, 'INCOMPLETE', 'CHECK_DATABASE_URL is not set. The check did not run.');
  }
} else {
  client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    add('database_connection', 'PASS', 'Connected with a read-only transaction.');
  } catch {
    add('database_connection', 'INCOMPLETE', 'The database connection could not be opened. No schema result is inferred.');
    client = null;
  }
}

if (client) {
  const applied = await client.query('SELECT name FROM freehold_deploy.migrations ORDER BY name');
  const names = applied.rows.map(row => row.name);
  const latest = names.at(-1) ?? null;
  add('schema_version', latest === expectedMigration ? 'PASS' : 'FAIL',
    `Latest applied migration is ${latest ?? 'none'}. Expected ${expectedMigration}.`);
  const roles = await client.query(`SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolinherit, rolreplication
    FROM pg_roles WHERE rolname IN ('freehold_api','freehold_worker','freehold_verifier','freehold_auth','freehold_scheduler','freehold_backup')
    ORDER BY rolname`);
  const required = ['freehold_api', 'freehold_worker', 'freehold_verifier', 'freehold_auth', 'freehold_scheduler'];
  const byName = new Map(roles.rows.map(row => [row.rolname, row]));
  const roleProblems = [];
  for (const name of required) {
    const role = byName.get(name);
    if (!role) roleProblems.push(`${name} missing`);
    else if (!role.rolcanlogin || role.rolsuper || role.rolbypassrls || role.rolinherit) roleProblems.push(`${name} is not a confined login`);
  }
  add('runtime_roles', roleProblems.length ? 'FAIL' : 'PASS', roleProblems.length ? roleProblems.join('; ') : 'The five runtime logins exist and are not superuser, inheritance, or bypassrls.');
  const apiReads = await client.query(`SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='freehold' AND c.relkind='r' AND has_table_privilege('freehold_api', c.oid, 'SELECT')
      AND c.relname <> 'currencies'`);
  add('api_customer_reads', apiReads.rows.length ? 'FAIL' : 'PASS',
    apiReads.rows.length ? `freehold_api can read ${apiReads.rows.map(row => row.relname).join(', ')}` : 'freehold_api has no table SELECT beyond currencies.');
  const verifier = await client.query(`SELECT
    has_table_privilege('freehold_verifier','freehold.accounts','SELECT') AS accounts,
    has_table_privilege('freehold_verifier','freehold.ledger_entries','SELECT') AS entries,
    to_regclass('freehold.account_rollups') IS NOT NULL AND has_table_privilege('freehold_verifier','freehold.account_rollups','SELECT') AS rollups,
    EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='freehold' AND p.proname='execute_internal_transfer'
        AND has_function_privilege('freehold_verifier', p.oid, 'EXECUTE')) AS can_post`);
  const boundary = verifier.rows[0];
  const verifierOk = boundary?.accounts === true && boundary?.entries === true && boundary?.rollups !== true && boundary?.can_post !== true;
  add('verifier_boundary', verifierOk ? 'PASS' : 'FAIL',
    verifierOk ? 'The verifier can read the accounting tables and cannot post or read rollups.'
      : 'Verifier grants do not match the read-only accounting boundary.');
  const archive = await client.query('SHOW archive_mode');
  const archiveMode = archive.rows[0].archive_mode;
  add('wal_archive', archiveMode === 'on' || archiveMode === 'always' ? 'PASS' : 'FAIL',
    `archive_mode is ${archiveMode}.`);
  const heartbeat = await client.query(`SELECT to_regclass('freehold.worker_heartbeats') AS present`);
  if (!heartbeat.rows[0].present) add('worker_heartbeat', 'INCOMPLETE', 'worker_heartbeats is not in this schema. Worker liveness was not measured.');
  else {
    const seen = await client.query(`SELECT max(seen_at) AS seen FROM freehold.worker_heartbeats`);
    const at = seen.rows[0].seen;
    if (!at) add('worker_heartbeat', 'FAIL', 'No worker heartbeat is stored.');
    else if (Date.now() - new Date(at).getTime() > 120000) add('worker_heartbeat', 'FAIL', 'The newest worker heartbeat is older than 120 seconds.');
    else add('worker_heartbeat', 'PASS', 'A worker heartbeat is newer than 120 seconds.');
  }
  const schedulerBeat = await client.query(`SELECT to_regclass('freehold.scheduler_heartbeats') AS present`);
  if (!schedulerBeat.rows[0].present) add('scheduler_availability', 'INCOMPLETE', 'scheduler_heartbeats is not in this schema. Scheduler liveness was not measured.');
  else {
    const seen = await client.query(`SELECT max(seen_at) AS seen FROM freehold.scheduler_heartbeats`);
    const at = seen.rows[0].seen;
    if (!at) add('scheduler_availability', 'FAIL', 'No scheduler heartbeat is stored.');
    else if (Date.now() - new Date(at).getTime() > 120000) add('scheduler_availability', 'FAIL', 'The newest scheduler heartbeat is older than 120 seconds.');
    else add('scheduler_availability', 'PASS', 'A scheduler heartbeat is newer than 120 seconds.');
  }
  try {
    const posture = await client.query(`SELECT sandbox_enabled AS sandbox,
      (SELECT enabled FROM freehold.demo_settings WHERE singleton) AS demo
      FROM freehold.ledger_settings WHERE singleton`);
    const row = posture.rows[0];
    add('sandbox_disabled', row && row.sandbox === false ? 'PASS' : 'FAIL',
      row ? `sandbox_enabled is ${row.sandbox}.` : 'ledger_settings has no row.');
    add('demo_disabled', row && row.demo === false ? 'PASS' : 'FAIL',
      row ? `demo_settings.enabled is ${row.demo}.` : 'demo_settings has no row.');
  } catch {
    add('sandbox_disabled', 'FAIL', 'Deployment posture could not be read.');
    add('demo_disabled', 'FAIL', 'Deployment posture could not be read.');
  }
  await client.query('ROLLBACK');
  await client.end();
} else {
  add('scheduler_availability', 'INCOMPLETE', 'No database connection. Scheduler liveness was not measured.');
  if (databaseUrl) {
    add('sandbox_disabled', 'INCOMPLETE', 'No database connection. Sandbox posture was not measured.');
    add('demo_disabled', 'INCOMPLETE', 'No database connection. Demo posture was not measured.');
  }
}

if (process.env.DATABASE_URL && process.env.AUTH_DATABASE_URL) {
  add('credential_separation', 'FAIL', 'This process holds both DATABASE_URL and AUTH_DATABASE_URL.');
} else if (!process.env.CHECK_DATABASE_URL && !process.env.DATABASE_URL && !process.env.AUTH_DATABASE_URL) {
  add('credential_separation', 'INCOMPLETE', 'No runtime database URLs were supplied to judge separation.');
} else {
  add('credential_separation', 'PASS', 'This process does not hold both financial and authentication database URLs.');
}

const apiUrl = process.env.CHECK_API_URL;
if (!apiUrl) add('api_readiness', 'INCOMPLETE', 'CHECK_API_URL is not set.');
else {
  try {
    const response = await fetch(apiUrl, { signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    add('api_readiness', response.status === 200 && body?.status === 'accepting' && !response.redirected ? 'PASS' : 'FAIL',
      'The endpoint must return HTTP 200 with status accepting without redirecting.');
    if (production) add('production_api_tls', new URL(apiUrl).protocol === 'https:' ? 'PASS' : 'FAIL', 'Production readiness requires a verified HTTPS endpoint.');
  } catch {
    add('api_readiness', 'FAIL', 'The API URL did not answer.');
  }
}

const buildId = new URL('../web/.next/BUILD_ID', import.meta.url);
try {
  statSync(buildId);
  add('frontend_build', 'PASS', 'web/.next/BUILD_ID exists.');
} catch {
  add('frontend_build', 'FAIL', 'web/.next/BUILD_ID is absent. The production frontend has not been built.');
}

const manifestPath = process.env.CHECK_BACKUP_MANIFEST;
if (!manifestPath) add('backup_availability', 'INCOMPLETE', 'CHECK_BACKUP_MANIFEST is not set. No backup is treated as present.');
else {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const maxHours = Number(process.env.CHECK_BACKUP_MAX_AGE_HOURS ?? 24);
    const problem = backupProblem(manifest, maxHours);
    add('backup_availability', problem ? 'FAIL' : 'PASS', problem ?? 'A recent encrypted backup manifest records an independent copy and SHA-256.');
  } catch {
    add('backup_availability', 'FAIL', 'The backup manifest could not be read.');
  }
}

if (!process.env.VERIFY_DATABASE_URL) add('independent_verifier', 'INCOMPLETE', 'VERIFY_DATABASE_URL is not set. Verification did not run.');
else {
  const run = spawnSync(process.execPath, ['scripts/verify-ledger.mjs'], {
    env: { ...process.env }, encoding: 'utf8', timeout: 180000,
  });
  let outcome = null;
  try { outcome = JSON.parse(run.stdout).outcome; } catch { outcome = null; }
  add('independent_verifier', run.status === 0 && outcome === 'VERIFIED' ? 'PASS' : 'FAIL',
    outcome ? `Verifier outcome ${outcome}.` : 'The verifier did not return a report.');
}

if (production) {
  let evidence;
  try { evidence = JSON.parse(readFileSync(process.env.CHECK_PRODUCTION_EVIDENCE, 'utf8')); } catch { /* missing evidence stays incomplete */ }
  checks.push(...productionEvidenceChecks(evidence, process.env.CHECK_ENVIRONMENT, sourceRevision()));
}
const failed = checks.some(check => check.status === 'FAIL');
const incomplete = checks.some(check => check.status === 'INCOMPLETE');
const result = failed ? 'NOT_READY' : incomplete ? 'INCOMPLETE' : 'READY';
const report = {
  reportType: 'freehold.deployment-readiness',
  scope: production ? 'production' : 'technical',
  generatedAt: new Date().toISOString(),
  sourceRevision: sourceRevision(),
  signature: null,
  result,
  readOnly: true,
  migrationsApplied: false,
  balancesChanged: false,
  checks,
};
if (outPath) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
if (jsonOnly) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  process.stdout.write(`${result}\n`);
  for (const check of checks) process.stdout.write(`${check.status}\t${check.id}\t${check.detail}\n`);
}
if (result !== 'READY') process.exitCode = result === 'NOT_READY' ? 2 : 3;
