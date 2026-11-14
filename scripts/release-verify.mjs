#!/usr/bin/env node
// Read-only release check. It does not migrate, post, or change configuration.
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { refuseEvidenceOverwrite } from './lib/evidence-output.mjs';
import { signatureFor } from './lib/evidence-signature.mjs';
import { migrationInventory } from './lib/release-tree.mjs';

const strict = process.argv.includes('--strict');
const json = process.argv.includes('--json');
const manifestIndex = process.argv.indexOf('--manifest');
const manifestPath = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : null;
const outIndex = process.argv.indexOf('--out');
const out = outIndex >= 0 ? process.argv[outIndex + 1] : null;
if (out) refuseEvidenceOverwrite(out);

const checks = [];
const add = (id, status, detail) => checks.push({ id, status, detail });
const absent = (id, detail) => add(id, strict ? 'INCOMPLETE' : 'SKIPPED', detail);
const tree = migrationInventory();

add('source_revision', tree.sourceRevision === 'unknown' ? (strict ? 'INCOMPLETE' : 'SKIPPED') : 'PASS', `Source revision is ${tree.sourceRevision}.`);
add('verifier_version', tree.verifierAlgorithmVersion === '1.7.0' ? 'PASS' : 'FAIL', `Tree verifier algorithm is ${tree.verifierAlgorithmVersion}.`);
add('configuration', process.env.NODE_ENV === 'production' && process.env.DEMO_MODE === 'true' ? 'FAIL' : 'PASS',
  process.env.NODE_ENV === 'production' ? 'NODE_ENV is production. DEMO_MODE must not be true.' : 'This process is not NODE_ENV=production.');

if (!manifestPath) absent('release_manifest', 'No --manifest path was given.');
else {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const problems = [];
    if (manifest.schemaChecksum !== tree.schemaChecksum) problems.push('schema checksum differs');
    if (manifest.migrationVersion !== tree.migrationVersion) problems.push('migration version differs');
    if (manifest.verifierAlgorithmVersion !== tree.verifierAlgorithmVersion) problems.push('verifier algorithm differs');
    if (manifest.sourceRevision !== tree.sourceRevision) problems.push('source revision differs from this tree');
    const listed = new Map((manifest.migrations ?? []).map(item => [item.name, item.sha256]));
    if (listed.size !== tree.migrations.length) problems.push('migration count differs');
    for (const migration of tree.migrations) {
      if (listed.get(migration.name) !== migration.sha256) problems.push(`${migration.name} checksum differs`);
    }
    add('release_manifest', problems.length ? 'FAIL' : 'PASS', problems.length ? problems.join('; ') : `Manifest matches ${tree.migrationVersion}.`);
  } catch {
    add('release_manifest', 'FAIL', 'The manifest could not be read.');
  }
}

const databaseUrl = process.env.CHECK_DATABASE_URL;
if (!databaseUrl) {
  absent('runtime_roles', 'CHECK_DATABASE_URL is not set.');
  absent('schema_version', 'CHECK_DATABASE_URL is not set.');
  absent('worker_health', 'CHECK_DATABASE_URL is not set.');
  absent('scheduler_health', 'CHECK_DATABASE_URL is not set.');
} else if (!/127\.0\.0\.1|localhost/.test(databaseUrl)) {
  add('runtime_roles', 'FAIL', 'CHECK_DATABASE_URL is not a loopback address. This command will not open it.');
} else {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const roles = await client.query(`SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolinherit
      FROM pg_roles WHERE rolname IN ('freehold_api','freehold_worker','freehold_verifier','freehold_auth','freehold_scheduler')`);
    const problems = [];
    for (const name of ['freehold_api', 'freehold_worker', 'freehold_verifier', 'freehold_auth', 'freehold_scheduler']) {
      const role = roles.rows.find(row => row.rolname === name);
      if (!role) problems.push(`${name} missing`);
      else if (!role.rolcanlogin || role.rolsuper || role.rolbypassrls || role.rolinherit) problems.push(`${name} is not confined`);
    }
    add('runtime_roles', problems.length ? 'FAIL' : 'PASS', problems.length ? problems.join('; ') : 'The five runtime logins are confined.');
    const applied = await client.query('SELECT name FROM freehold_deploy.migrations ORDER BY name DESC LIMIT 1');
    const latest = applied.rows[0]?.name ?? null;
    add('schema_version', latest === tree.migrationVersion ? 'PASS' : 'FAIL', `Database migration is ${latest ?? 'none'}. Tree expects ${tree.migrationVersion}.`);
    const worker = await client.query(`SELECT max(seen_at) AS seen FROM freehold.worker_heartbeats`);
    const scheduler = await client.query(`SELECT max(seen_at) AS seen FROM freehold.scheduler_heartbeats`);
    const fresh = value => value && Date.now() - new Date(value).getTime() <= 120000;
    add('worker_health', fresh(worker.rows[0].seen) ? 'PASS' : 'FAIL', worker.rows[0].seen ? 'Worker heartbeat was read.' : 'No worker heartbeat is stored.');
    add('scheduler_health', fresh(scheduler.rows[0].seen) ? 'PASS' : 'FAIL', scheduler.rows[0].seen ? 'Scheduler heartbeat was read.' : 'No scheduler heartbeat is stored.');
    await client.query('ROLLBACK');
  } catch {
    if (!checks.some(check => check.id === 'runtime_roles')) add('runtime_roles', 'INCOMPLETE', 'The database check did not finish.');
    if (!checks.some(check => check.id === 'schema_version')) add('schema_version', 'INCOMPLETE', 'Schema version was not read.');
    if (!checks.some(check => check.id === 'worker_health')) add('worker_health', 'INCOMPLETE', 'Worker health was not read.');
    if (!checks.some(check => check.id === 'scheduler_health')) add('scheduler_health', 'INCOMPLETE', 'Scheduler health was not read.');
    try { await client.query('ROLLBACK'); } catch { /* already closed */ }
  } finally {
    try { await client.end(); } catch { /* closed */ }
  }
}

if (!process.env.CHECK_API_URL) absent('required_services', 'CHECK_API_URL is not set. Service health was not read.');
else {
  try {
    const response = await fetch(process.env.CHECK_API_URL, { signal: AbortSignal.timeout(5000) });
    add('required_services', response.status === 200 ? 'PASS' : 'FAIL', `HTTP ${response.status}. A 200 from /ready is not a READY deployment.`);
  } catch {
    add('required_services', 'FAIL', 'The API URL did not answer.');
  }
}

const backupPath = process.env.CHECK_BACKUP_MANIFEST;
if (!backupPath) absent('backup_readiness', 'CHECK_BACKUP_MANIFEST is not set.');
else {
  try {
    const manifest = JSON.parse(readFileSync(backupPath, 'utf8'));
    const age = Date.now() - Date.parse(manifest.generatedAt);
    const maxHours = Number(process.env.CHECK_BACKUP_MAX_AGE_HOURS ?? 24);
    if (!manifest.sha256 || !Number.isFinite(age)) add('backup_readiness', 'FAIL', 'The manifest has no sha256 or generatedAt.');
    else if (age > maxHours * 3600000) add('backup_readiness', 'FAIL', 'The backup manifest is older than the allowed age.');
    else if (manifest.offsiteCopy !== true) add('backup_readiness', 'FAIL', 'The manifest does not record an independently administered copy.');
    else add('backup_readiness', 'PASS', 'A recent manifest records an independent copy and a sha256.');
  } catch {
    add('backup_readiness', 'FAIL', 'The backup manifest could not be read.');
  }
}

const failed = checks.some(check => check.status === 'FAIL');
const incomplete = checks.some(check => check.status === 'INCOMPLETE' || check.status === 'SKIPPED');
const result = failed ? 'NOT_READY' : incomplete ? 'INCOMPLETE' : 'READY';
const body = {
  reportType: 'freehold.release-verification',
  generatedAt: new Date().toISOString(),
  sourceRevision: tree.sourceRevision,
  result,
  strict,
  readOnly: true,
  migrationsApplied: false,
  balancesChanged: false,
  checks,
};
const report = { ...body, signature: signatureFor(body, process.env.EVIDENCE_SIGNING_KEY ?? '') };
const text = `${JSON.stringify(report, null, 2)}\n`;
if (out) writeFileSync(out, text, { mode: 0o600 });
if (json || !out) process.stdout.write(json ? text : `${result}\n`);
if (failed) process.exitCode = 2;
else if (strict && result !== 'READY') process.exitCode = 3;
