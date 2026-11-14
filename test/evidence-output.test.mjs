import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refuseEvidenceOverwrite } from '../scripts/lib/evidence-output.mjs';

test('preserved phase evidence is not replaced unless the overwrite flag is set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'freehold-evidence-'));
  const preserved = join(dir, 'phase7-projection-cost-before.json');
  const working = join(dir, 'projection-cost-latest.json');
  try {
    const nestedDir = join(dir, 'docs', 'evidence', 'phase5-recovery');
    mkdirSync(nestedDir, { recursive: true });
    const nested = join(nestedDir, 'manifest.json');
    writeFileSync(preserved, '{}\n');
    writeFileSync(working, '{}\n');
    writeFileSync(nested, '{}\n');
    const previous = process.env.FREEHOLD_EVIDENCE_OVERWRITE;
    delete process.env.FREEHOLD_EVIDENCE_OVERWRITE;
    assert.throws(() => refuseEvidenceOverwrite(preserved), /Refusing to overwrite/);
    assert.throws(() => refuseEvidenceOverwrite(nested), /Refusing to overwrite/);
    assert.doesNotThrow(() => refuseEvidenceOverwrite(working));
    assert.doesNotThrow(() => refuseEvidenceOverwrite(join(dir, 'phase9-missing.json')));
    process.env.FREEHOLD_EVIDENCE_OVERWRITE = '1';
    assert.doesNotThrow(() => refuseEvidenceOverwrite(preserved));
    if (previous === undefined) delete process.env.FREEHOLD_EVIDENCE_OVERWRITE;
    else process.env.FREEHOLD_EVIDENCE_OVERWRITE = previous;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the helper ignores an empty path', () => {
  assert.doesNotThrow(() => refuseEvidenceOverwrite(''));
});
