import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const WAL_NAME = /^[0-9A-F]{24}$/;

export function walContinuity(names) {
  const segments = [...new Set(names.filter(name => WAL_NAME.test(name)))].sort();
  if (!segments.length) return { status: 'UNAVAILABLE', missing: [] };
  const missing = [];
  for (let index = 1; index < segments.length; index += 1) {
    const previous = BigInt(`0x${segments[index - 1]}`);
    const current = BigInt(`0x${segments[index]}`);
    for (let value = previous + 1n; value < current; value += 1n) missing.push(value.toString(16).toUpperCase().padStart(24, '0'));
  }
  return { status: missing.length ? 'GAP' : 'CONTINUOUS', missing };
}

export function discoverSets(directory) {
  let entries = [];
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return []; }
  const sets = [];
  const ownManifest = join(directory, 'manifest.json');
  try {
    if (statSync(ownManifest).isFile()) sets.push(directory);
  } catch { /* this directory is a parent, not a set */ }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = join(directory, entry.name, 'manifest.json');
    try { if (statSync(manifest).isFile()) sets.push(join(directory, entry.name)); } catch { /* skip */ }
  }
  return sets;
}

export function readManifest(setDirectory) {
  const manifest = JSON.parse(readFileSync(join(setDirectory, 'manifest.json'), 'utf8'));
  return manifest && typeof manifest === 'object' ? manifest : null;
}

export function checksumFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function decideBackupOutcome(input) {
  if (!input.present) return { outcome: 'UNAVAILABLE', reason: 'No eligible backup set was found.' };
  if (!input.payloadPresent) return { outcome: 'INCOMPLETE', reason: 'The backup payload is missing.' };
  if (input.checksumOk !== true) return { outcome: 'MISMATCH', reason: 'The payload sha256 does not match the manifest.' };
  if (input.ageOk !== true) return { outcome: 'INCOMPLETE', reason: 'The backup is older than the allowed age or has no timestamp.' };
  if (input.encrypted && input.decrypted !== true) return { outcome: 'INCOMPLETE', reason: 'The encrypted backup was not decrypted.' };
  if (input.kind === 'base' && input.walStatus !== 'CONTINUOUS') return { outcome: 'INCOMPLETE', reason: 'The base backup does not have a continuous WAL archive.' };
  if (input.requireWal && input.walStatus !== 'CONTINUOUS') return { outcome: 'INCOMPLETE', reason: 'WAL continuity was required and was not proven.' };
  if (input.walStatus === 'GAP') return { outcome: 'INCOMPLETE', reason: 'A WAL segment is missing.' };
  if (!input.restoreAttempted) return { outcome: 'INCOMPLETE', reason: 'The backup was not restored into a disposable instance.' };
  if (input.restoreError) return { outcome: 'ERROR', reason: input.restoreError };
  if (input.restoreCompleted !== true) return { outcome: 'INCOMPLETE', reason: 'The disposable restore did not finish.' };
  if (input.verifierOutcome === 'MISMATCH') return { outcome: 'MISMATCH', reason: 'Independent verification of the restored database returned MISMATCH.' };
  if (input.verifierOutcome === 'VERIFIED') return { outcome: 'VERIFIED', reason: 'Checksum, disposable restore, and independent verification succeeded.' };
  if (input.verifierOutcome === 'INCOMPLETE' || input.verifierOutcome == null) return { outcome: 'INCOMPLETE', reason: 'Independent verification did not return VERIFIED.' };
  return { outcome: 'ERROR', reason: `Verifier outcome ${input.verifierOutcome}.` };
}
