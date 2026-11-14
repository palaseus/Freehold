#!/usr/bin/env node
// Validate one backup set. A restore, when requested, uses a new disposable
// PostgreSQL container. It never targets the Compose database.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checksumFile, decideBackupOutcome, discoverSets, readManifest, walContinuity } from './lib/backup-set.mjs';
import { refuseEvidenceOverwrite } from './lib/evidence-output.mjs';
import { signatureFor } from './lib/evidence-signature.mjs';
import { sourceRevision } from './lib/source-revision.mjs';

const setIndex = process.argv.indexOf('--set');
const setPath = setIndex >= 0 ? process.argv[setIndex + 1] : null;
const outIndex = process.argv.indexOf('--out');
const out = outIndex >= 0 ? process.argv[outIndex + 1] : null;
const restore = process.argv.includes('--restore');
const requireWal = process.argv.includes('--require-wal');
const maxHours = Number(process.env.BACKUP_MAX_AGE_HOURS ?? 24);
if (out) refuseEvidenceOverwrite(out);
if (!setPath) throw new Error('Usage: backup-validate.mjs --set <directory> [--restore] [--out file]');
if (setPath === '/' || setPath.startsWith('/var/lib/postgresql')) throw new Error('Refusing a PostgreSQL data path');

function filesIn(directory) {
  return readdirSync(directory).filter(name => name !== 'manifest.json').map(name => join(directory, name));
}
function headerOf(path) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(5);
    readSync(fd, buffer, 0, 5, 0);
    return buffer.toString();
  } finally { closeSync(fd); }
}
function canRestore(input) {
  if (!input.payloadPresent || input.checksumOk !== true || input.ageOk !== true) return false;
  if (input.encrypted && input.decrypted !== true) return false;
  if (input.walStatus === 'GAP') return false;
  if (input.kind === 'base' && input.walStatus !== 'CONTINUOUS') return false;
  if (input.requireWal && input.walStatus !== 'CONTINUOUS') return false;
  return true;
}

const sets = discoverSets(setPath);
const input = { present: sets.length > 0, restoreAttempted: false, restoreCompleted: false, restoreError: null, verifierOutcome: null, restoreMs: null };
let manifest = null;
let chosen = null;
let wal = { status: 'UNAVAILABLE', missing: [] };
let payload = null;
if (sets.length) {
  chosen = sets[sets.length - 1];
  try { manifest = readManifest(chosen); } catch { manifest = null; }
  const candidates = filesIn(chosen).filter(file => { try { return statSync(file).isFile(); } catch { return false; } });
  payload = candidates[0] ?? null;
  input.payloadPresent = Boolean(payload);
  input.checksumOk = Boolean(payload && manifest?.sha256 && checksumFile(payload) === manifest.sha256);
  const generated = Date.parse(manifest?.generatedAt ?? '');
  input.ageOk = Number.isFinite(generated) && Date.now() - generated <= maxHours * 3600000;
  input.encrypted = manifest?.encrypted === true;
  input.decrypted = !input.encrypted;
  input.decryptionError = null;
  const header = payload && !input.encrypted ? headerOf(payload) : '';
  input.kind = manifest?.kind ?? (header === 'PGDMP' ? 'logical-custom' : 'unknown');
  try { wal = walContinuity(readdirSync(join(chosen, 'wal'))); } catch { wal = { status: 'UNAVAILABLE', missing: [] }; }
  input.walStatus = wal.status;
  input.requireWal = requireWal;
  const opened = input.encrypted && payload ? openEncrypted(payload, manifest) : null;
  if (opened) {
    input.decrypted = opened.decrypted;
    input.decryptionError = opened.decryptionError;
    if (opened.kind) input.kind = opened.kind;
  }
  try {
    if (restore && canRestore(input)) {
      input.restoreAttempted = true;
      const started = Date.now();
      try {
        if (input.kind !== 'logical-custom') throw new Error('unsupported format');
        const restored = await restoreDump(opened?.plaintext ?? payload);
        input.restoreCompleted = restored.completed === true;
        input.verifierOutcome = restored.verifierOutcome;
        input.verifierError = restored.verifierError ?? null;
      } catch {
        input.restoreError = 'The disposable restore failed';
      } finally {
        input.restoreMs = Date.now() - started;
      }
    }
  } finally {
    if (opened?.directory) rmSync(opened.directory, { recursive: true, force: true });
  }
}
const decision = decideBackupOutcome(input);
if (decision.outcome === 'VERIFIED' && (input.restoreCompleted !== true || input.verifierOutcome !== 'VERIFIED')) {
  decision.outcome = 'ERROR';
  decision.reason = 'Verified was refused because the restore did not finish cleanly.';
}
if (decision.outcome === 'VERIFIED' && input.encrypted === true && input.decrypted !== true) {
  decision.outcome = 'ERROR';
  decision.reason = 'Verified was refused because decryption did not succeed.';
}
const body = {
  reportType: 'freehold.backup-validation',
  generatedAt: new Date().toISOString(),
  sourceRevision: sourceRevision(),
  outcome: decision.outcome,
  reason: decision.reason,
  offsiteCopy: manifest?.offsiteCopy === true,
  offsiteClaim: false,
  walContinuity: wal.status,
  missingWalSegments: wal.missing,
  restoreAttempted: input.restoreAttempted === true,
  restoreCompleted: input.restoreCompleted === true,
  restoreMs: input.restoreMs,
  verifierOutcome: input.verifierOutcome,
  verifierError: input.verifierError ?? null,
  encrypted: input.encrypted === true,
  decrypted: input.decrypted === true,
  decryptionError: input.decryptionError ?? null,
  primaryTouched: false,
  persistentVolumeTouched: false,
};
const report = { ...body, signature: signatureFor(body, process.env.EVIDENCE_SIGNING_KEY ?? '') };
const text = `${JSON.stringify(report, null, 2)}\n`;
if (out) writeFileSync(out, text, { mode: 0o600 });
process.stdout.write(`${decision.outcome}\n`);
if (decision.outcome !== 'VERIFIED') process.exitCode = decision.outcome === 'MISMATCH' ? 2 : decision.outcome === 'INCOMPLETE' ? 3 : decision.outcome === 'ERROR' ? 4 : 5;

function openEncrypted(payload, manifest) {
  const passphrase = process.env.BACKUP_EXPORT_PASSPHRASE ?? '';
  if (passphrase.length < 16) return { decrypted: false, decryptionError: 'PASSPHRASE_UNAVAILABLE', plaintext: null, directory: null, kind: null };
  if (typeof manifest?.plaintextSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.plaintextSha256)) {
    return { decrypted: false, decryptionError: 'PLAINTEXT_HASH_ABSENT', plaintext: null, directory: null, kind: null };
  }
  const directory = mkdtempSync(join(tmpdir(), 'freehold-decrypt-'));
  const plain = join(directory, 'plain.dump');
  const decrypted = spawnSync('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-in', payload, '-out', plain, '-pass', 'env:BACKUP_EXPORT_PASSPHRASE'], { encoding: 'utf8' });
  if (decrypted.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    return { decrypted: false, decryptionError: 'DECRYPT_FAILED', plaintext: null, directory: null, kind: null };
  }
  let hash = '';
  try { hash = checksumFile(plain); } catch { hash = ''; }
  if (hash !== manifest.plaintextSha256) {
    rmSync(directory, { recursive: true, force: true });
    return { decrypted: false, decryptionError: 'PLAINTEXT_HASH_MISMATCH', plaintext: null, directory: null, kind: null };
  }
  const plainHeader = headerOf(plain);
  return { decrypted: true, decryptionError: null, plaintext: plain, directory, kind: plainHeader === 'PGDMP' ? 'logical-custom' : (manifest?.kind ?? 'unknown') };
}

async function restoreDump(dump) {
  const container = `freehold-bval-${process.pid}`;
  const password = randomBytes(24).toString('base64url');
  const verifierPassword = randomBytes(24).toString('base64url');
  const started = spawnSync('docker', ['run', '--name', container, '-d', '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=freehold_backup_validation_disposable', 'postgres:16'], { encoding: 'utf8' });
  if (started.status !== 0) throw new Error('container');
  try {
    let address = '';
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const ping = spawnSync('docker', ['exec', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'freehold_backup_validation_disposable', '-X', '-Atc', 'SELECT 1'], { encoding: 'utf8' });
      if (ping.status === 0) {
        address = spawnSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).stdout.trim();
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!address.startsWith('127.0.0.1:')) throw new Error('listen');
    const roles = ['freehold_owner', 'freehold_app', 'freehold_runtime', 'freehold_api', 'freehold_worker', 'freehold_verifier', 'freehold_auth', 'freehold_scheduler', 'freehold_backup']
      .map(role => `CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`).join(' ');
    if (spawnSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'freehold_backup_validation_disposable', '-v', 'ON_ERROR_STOP=1', '-c', roles], { encoding: 'utf8' }).status !== 0) throw new Error('roles');
    if (spawnSync('docker', ['cp', dump, `${container}:/tmp/backup.dump`], { encoding: 'utf8' }).status !== 0) throw new Error('copy');
    const restored = spawnSync('docker', ['exec', container, 'pg_restore', '-U', 'postgres', '-d', 'freehold_backup_validation_disposable', '--exit-on-error', '/tmp/backup.dump'], { encoding: 'utf8' });
    spawnSync('docker', ['exec', container, 'rm', '-f', '/tmp/backup.dump']);
    if (restored.status !== 0) throw new Error('restore');
    const literal = verifierPassword.replaceAll("'", "''");
    if (spawnSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'freehold_backup_validation_disposable', '-v', 'ON_ERROR_STOP=1', '-c', `ALTER ROLE freehold_verifier LOGIN PASSWORD '${literal}'`], { encoding: 'utf8' }).status !== 0) throw new Error('login');
    const verify = spawnSync(process.execPath, ['scripts/verify-ledger.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, VERIFY_DATABASE_URL: `postgresql://freehold_verifier:${verifierPassword}@${address}/freehold_backup_validation_disposable` },
    });
    let outcome = null;
    let verifierError = null;
    try {
      const parsed = JSON.parse(verify.stdout);
      outcome = parsed.outcome ?? null;
      verifierError = typeof parsed.error?.code === 'string' ? parsed.error.code : null;
    } catch { outcome = null; }
    return { completed: outcome != null, verifierOutcome: outcome, verifierError };
  } finally {
    spawnSync('docker', ['rm', '-f', '-v', container]);
  }
}
