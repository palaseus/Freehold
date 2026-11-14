#!/usr/bin/env node
// Prove migrate.mjs replaces the five runtime passwords on a disposable database.
// The old password must fail and the new password must succeed. No secret is written.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { refuseEvidenceOverwrite } from './lib/evidence-output.mjs';
import { signatureFor } from './lib/evidence-signature.mjs';
import { sourceRevision } from './lib/source-revision.mjs';

const out = process.env.PHASE9A_ROTATION_OUT ?? 'docs/evidence/phase9a-credential-rotation.json';
refuseEvidenceOverwrite(out);
const container = `freehold-rot9a-${process.pid}`;
if (/^freehold-(postgres|api|web|redis)-1$/.test(container)) throw new Error('Refusing a persistent Compose container name');
const password = () => randomBytes(24).toString('base64url');
const postgresPassword = password();
const first = { api: password(), worker: password(), verifier: password(), auth: password(), scheduler: password() };
const second = { api: password(), worker: password(), verifier: password(), auth: password(), scheduler: password() };
const result = {
  oldPasswordRejected: false,
  newPasswordAccepted: false,
  oldCode: null,
  appliedCountUnchanged: false,
  appliedCount: null,
  demoMode: false,
  persistentDatabase: false,
  containerRemoved: false,
  error: null,
};

function redact(text) {
  return String(text ?? '').replace(/postgresql:\/\/\S+/g, 'postgresql://redacted').slice(0, 300);
}
function migrateEnv(url, secrets) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'test',
    DEMO_MODE: 'false',
    DEMO_BOOTSTRAP_TOKEN: '',
    MIGRATION_DATABASE_URL: url,
    API_DATABASE_PASSWORD: secrets.api,
    WORKER_DATABASE_PASSWORD: secrets.worker,
    VERIFIER_DATABASE_PASSWORD: secrets.verifier,
    AUTH_DATABASE_PASSWORD: secrets.auth,
    SCHEDULER_DATABASE_PASSWORD: secrets.scheduler,
  };
}
async function login(address, secret) {
  const client = new pg.Client({
    connectionString: `postgresql://freehold_api:${encodeURIComponent(secret)}@${address}/freehold_rotation_disposable`,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    const { rows } = await client.query('SELECT 1 AS ok');
    return { ok: rows[0]?.ok === 1, code: null };
  } catch (error) {
    return { ok: false, code: typeof error?.code === 'string' ? error.code : 'CONNECT_FAILED' };
  } finally {
    await client.end().catch(() => undefined);
  }
}

const started = spawnSync('docker', ['run', '--name', container, '-d', '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${postgresPassword}`, '-e', 'POSTGRES_DB=freehold_rotation_disposable', 'postgres:16'], { encoding: 'utf8' });
try {
  if (started.status !== 0) throw new Error('container');
  let address = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ping = spawnSync('docker', ['exec', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'freehold_rotation_disposable', '-X', '-Atc', 'SELECT 1'], { encoding: 'utf8' });
    if (ping.status === 0) {
      address = spawnSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).stdout.trim();
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!address.startsWith('127.0.0.1:')) throw new Error('listen');
  const adminUrl = `postgresql://postgres:${encodeURIComponent(postgresPassword)}@${address}/freehold_rotation_disposable`;
  const firstMigrate = spawnSync(process.execPath, ['scripts/migrate.mjs'], { encoding: 'utf8', env: migrateEnv(adminUrl, first) });
  if (firstMigrate.status !== 0) throw new Error(`migrate-first ${redact(firstMigrate.stderr)}`);
  const firstLogin = await login(address, first.api);
  if (!firstLogin.ok) throw new Error(`first-login ${firstLogin.code}`);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const before = (await admin.query('SELECT count(*)::int AS n FROM freehold_deploy.migrations')).rows[0].n;
  const demo = (await admin.query('SELECT enabled FROM freehold.demo_settings WHERE singleton')).rows[0].enabled;
  result.demoMode = demo === true;
  await admin.end();
  const secondMigrate = spawnSync(process.execPath, ['scripts/migrate.mjs'], { encoding: 'utf8', env: migrateEnv(adminUrl, second) });
  if (secondMigrate.status !== 0) throw new Error(`migrate-second ${redact(secondMigrate.stderr)}`);
  const adminAfter = new pg.Client({ connectionString: adminUrl });
  await adminAfter.connect();
  const after = (await adminAfter.query('SELECT count(*)::int AS n FROM freehold_deploy.migrations')).rows[0].n;
  await adminAfter.end();
  const rejected = await login(address, first.api);
  const accepted = await login(address, second.api);
  result.oldPasswordRejected = rejected.ok === false && rejected.code === '28P01';
  result.oldCode = rejected.code;
  result.newPasswordAccepted = accepted.ok === true;
  result.appliedCount = after;
  result.appliedCountUnchanged = before === after && after > 0;
} catch (error) {
  result.error = redact(error?.message ?? 'rotation failed');
} finally {
  spawnSync('docker', ['rm', '-f', '-v', container]);
  const inspect = spawnSync('docker', ['inspect', container], { encoding: 'utf8' });
  result.containerRemoved = inspect.status !== 0;
  const body = {
    reportType: 'freehold.phase9a-credential-rotation',
    generatedAt: new Date().toISOString(),
    sourceRevision: sourceRevision(),
    ...result,
    passed: result.oldPasswordRejected === true && result.newPasswordAccepted === true && result.appliedCountUnchanged === true && result.demoMode === false && result.persistentDatabase === false && result.containerRemoved === true && result.error == null,
  };
  const report = { ...body, signature: signatureFor(body, process.env.EVIDENCE_SIGNING_KEY ?? '') };
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  if (!body.passed) process.exitCode = 1;
}
