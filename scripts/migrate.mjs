// Deployment process only. The application/seed containers never receive this
// connection string. A dedicated connection holds the migration advisory lock.
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
const connectionString = process.env.MIGRATION_DATABASE_URL;
const apiPassword = process.env.API_DATABASE_PASSWORD;
const workerPassword = process.env.WORKER_DATABASE_PASSWORD;
const verifierPassword = process.env.VERIFIER_DATABASE_PASSWORD;
const authPassword = process.env.AUTH_DATABASE_PASSWORD;
const schedulerPassword = process.env.SCHEDULER_DATABASE_PASSWORD;
if (!connectionString || !apiPassword || apiPassword.length < 32 || !workerPassword || workerPassword.length < 32 || !verifierPassword || verifierPassword.length < 32 || !authPassword || authPassword.length < 32 || !schedulerPassword || schedulerPassword.length < 32) {
  throw new Error('Migration credentials and separate 32+ character API, auth, worker, verifier, and scheduler database passwords are required');
}
const client = new Client({ connectionString });
const literal = value => "'" + value.replaceAll("'", "''") + "'";
await client.connect();
try {
  await client.query('SELECT pg_advisory_lock(76804321)');
  await client.query('CREATE SCHEMA IF NOT EXISTS freehold_deploy');
  await client.query('REVOKE ALL ON SCHEMA freehold_deploy FROM PUBLIC');
  await client.query('CREATE TABLE IF NOT EXISTS freehold_deploy.migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  const migrationNames = (await readdir(new URL('../db/migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort();
  const testStop = process.env.MIGRATION_TEST_STOP_AFTER;
  if (testStop && process.env.NODE_ENV !== 'test') throw new Error('MIGRATION_TEST_STOP_AFTER is allowed only in NODE_ENV=test');
  if (testStop && !migrationNames.some(name => name.startsWith(`${testStop}_`))) throw new Error('Unknown test migration boundary');
  for (const name of migrationNames) {
    const sql = await readFile(new URL(`../db/migrations/${name}`, import.meta.url), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const { rows } = await client.query('SELECT checksum FROM freehold_deploy.migrations WHERE name=$1', [name]);
    if (rows[0]) {
      if (rows[0].checksum !== checksum) throw new Error(`Applied migration checksum changed: ${name}`);
      continue;
    }
    // Migrations have their own BEGIN/COMMIT. Strip those boundaries so recording
    // the checksum is atomic with the schema change, including initial role DDL.
    const body = sql.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
    await client.query('BEGIN');
    try {
      await client.query(body);
      await client.query('INSERT INTO freehold_deploy.migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    console.log(`Applied ${name}`);
    if (testStop && name.startsWith(`${testStop}_`)) break;
  }
  const { rows: runtimeRoles } = await client.query("SELECT count(*)::int AS count FROM pg_roles WHERE rolname IN ('freehold_api','freehold_worker','freehold_verifier','freehold_auth','freehold_scheduler')");
  if (runtimeRoles[0].count === 5) {
    await client.query(`ALTER ROLE freehold_api PASSWORD ${literal(apiPassword)}`);
    await client.query(`ALTER ROLE freehold_worker PASSWORD ${literal(workerPassword)}`);
    await client.query(`ALTER ROLE freehold_verifier PASSWORD ${literal(verifierPassword)}`);
    await client.query(`ALTER ROLE freehold_auth PASSWORD ${literal(authPassword)}`);
    await client.query(`ALTER ROLE freehold_scheduler PASSWORD ${literal(schedulerPassword)}`);
    if (process.env.BACKUP_DATABASE_PASSWORD && process.env.BACKUP_DATABASE_PASSWORD.length >= 32) {
      await client.query(`ALTER ROLE freehold_backup PASSWORD ${literal(process.env.BACKUP_DATABASE_PASSWORD)}`);
    }
  } else if (!testStop) throw new Error('Runtime roles were not created by the applied migrations');
  await client.query("INSERT INTO freehold.currencies(code,name,minor_unit_exponent) VALUES('USD','US dollar',2),('EUR','Euro',2),('JPY','Japanese yen',0),('KWD','Kuwaiti dinar',3) ON CONFLICT DO NOTHING");
  const demo = process.env.DEMO_MODE === 'true';
  const token = process.env.DEMO_BOOTSTRAP_TOKEN ?? '';
  if (demo && token.length < 32) throw new Error('Demo bootstrap token must have 32+ characters');
  await client.query('BEGIN');
  await client.query('UPDATE freehold.demo_settings SET enabled=$1,bootstrap_hash=$2 WHERE singleton', [demo, demo ? createHash('sha256').update(token).digest() : null]);
  await client.query('UPDATE freehold.ledger_settings SET sandbox_enabled=$1 WHERE singleton', [demo]);
  await client.query('COMMIT');
} finally { await client.end(); }
