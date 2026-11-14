import test from 'node:test';
import assert from 'node:assert/strict';
import { decideBackupOutcome, walContinuity } from '../scripts/lib/backup-set.mjs';

const restored = {
  present: true,
  payloadPresent: true,
  checksumOk: true,
  ageOk: true,
  encrypted: false,
  decrypted: false,
  kind: 'logical-custom',
  walStatus: 'UNAVAILABLE',
  requireWal: false,
  restoreAttempted: true,
  restoreCompleted: true,
  restoreError: null,
  verifierOutcome: 'VERIFIED',
};

test('a finished logical restore can be verified without pretending WAL exists', () => {
  const decision = decideBackupOutcome(restored);
  assert.equal(decision.outcome, 'VERIFIED');
});

test('an incomplete restore is never verified', () => {
  assert.equal(decideBackupOutcome({ ...restored, restoreAttempted: false, restoreCompleted: false }).outcome, 'INCOMPLETE');
  assert.equal(decideBackupOutcome({ ...restored, restoreCompleted: false }).outcome, 'INCOMPLETE');
  assert.equal(decideBackupOutcome({ ...restored, verifierOutcome: null }).outcome, 'INCOMPLETE');
  assert.equal(decideBackupOutcome({ ...restored, verifierOutcome: 'ERROR' }).outcome, 'ERROR');
});

test('checksum and verifier mismatches stay mismatches', () => {
  assert.equal(decideBackupOutcome({ ...restored, checksumOk: false }).outcome, 'MISMATCH');
  assert.equal(decideBackupOutcome({ ...restored, verifierOutcome: 'MISMATCH' }).outcome, 'MISMATCH');
});

test('a missing set is unavailable and a WAL gap is incomplete', () => {
  assert.equal(decideBackupOutcome({ present: false }).outcome, 'UNAVAILABLE');
  assert.equal(decideBackupOutcome({ ...restored, walStatus: 'GAP' }).outcome, 'INCOMPLETE');
  assert.equal(decideBackupOutcome({ ...restored, kind: 'base', walStatus: 'UNAVAILABLE' }).outcome, 'INCOMPLETE');
  const gap = walContinuity(['000000010000000000000001', '000000010000000000000003']);
  assert.equal(gap.status, 'GAP');
  assert.deepEqual(gap.missing, ['000000010000000000000002']);
  assert.equal(walContinuity([]).status, 'UNAVAILABLE');
  assert.equal(walContinuity(['000000010000000000000001', '000000010000000000000002']).status, 'CONTINUOUS');
});
