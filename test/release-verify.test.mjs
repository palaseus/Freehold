import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(args) {
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

test('release verification is read-only and strict mode rejects missing evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'freehold-release-'));
  const manifest = join(directory, 'manifest.json');
  const report = join(directory, 'verify.json');
  try {
    const written = run(['scripts/release-manifest.mjs', '--out', manifest]);
    assert.equal(written.status, 0, written.stderr);
    const manifestBody = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.equal(manifestBody.signature.status, 'UNSIGNED');
    assert.equal(manifestBody.migrationVersion, '034_phase16_2_institution_usage_execute_privileges.sql');
    const loose = run(['scripts/release-verify.mjs', '--manifest', manifest, '--json', '--out', report]);
    assert.equal(loose.status, 0, loose.stderr);
    const looseBody = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(looseBody.result, 'INCOMPLETE');
    assert.equal(looseBody.readOnly, true);
    assert.equal(looseBody.migrationsApplied, false);
    assert.equal(looseBody.balancesChanged, false);
    assert.equal(looseBody.checks.find(check => check.id === 'release_manifest').status, 'PASS');
    const strict = run(['scripts/release-verify.mjs', '--manifest', manifest, '--strict', '--json']);
    assert.equal(strict.status, 3, strict.stderr);
    const strictBody = JSON.parse(strict.stdout);
    assert.notEqual(strictBody.result, 'READY');
    manifestBody.schemaChecksum = '0'.repeat(64);
    writeFileSync(manifest, `${JSON.stringify(manifestBody)}\n`);
    const tampered = run(['scripts/release-verify.mjs', '--manifest', manifest, '--json']);
    assert.equal(tampered.status, 2);
    assert.equal(JSON.parse(tampered.stdout).result, 'NOT_READY');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
