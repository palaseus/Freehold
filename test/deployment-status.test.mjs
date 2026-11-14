import test from 'node:test';
import assert from 'node:assert/strict';
import { assessDeployment, assembleDeployment } from '../dist/src/admin/deployment-status.js';

const ready = () => ({
  databaseRead: true,
  activeMigration: '020_phase8_deployment_posture.sql',
  expectedMigration: '020_phase8_deployment_posture.sql',
  archiveMode: 'on',
  sandboxEnabled: false,
  demoEnabled: false,
  writesSuspended: false,
  workerHeartbeatAgeSeconds: 1,
  schedulerHeartbeatAgeSeconds: 1,
  openCriticalIncidents: 0,
  runtimeRolesConfined: true,
  sourceRevision: 'abc123',
  lastVerificationOutcome: 'VERIFIED',
  lastBackupOffsite: true,
  lastRecoveryOutcome: 'VERIFIED',
});

test('a closed database is unavailable', () => {
  assert.equal(assessDeployment({ ...ready(), databaseRead: false }).status, 'UNAVAILABLE');
  assert.equal(assembleDeployment(null, {}).status, 'UNAVAILABLE');
});

test('positive evidence is ready and a listening process is not enough', () => {
  assert.equal(assessDeployment(ready()).status, 'READY');
  const live = ready();
  live.sandboxEnabled = true;
  live.lastBackupOffsite = null;
  live.lastVerificationOutcome = null;
  const assessed = assessDeployment(live);
  assert.equal(assessed.status, 'NOT_READY');
  assert.equal(assessed.status === 'READY', false);
});

test('missing external evidence stays incomplete', () => {
  const facts = ready();
  facts.lastBackupOffsite = null;
  facts.lastRecoveryOutcome = null;
  facts.lastVerificationOutcome = null;
  facts.sourceRevision = 'unknown';
  assert.equal(assessDeployment(facts).status, 'INCOMPLETE');
});

test('a recorded verification mismatch is not ready', () => {
  const facts = ready();
  facts.lastVerificationOutcome = 'MISMATCH';
  assert.equal(assessDeployment(facts).status, 'NOT_READY');
});

test('the assembler does not invent worker or backup telemetry', () => {
  const report = assembleDeployment({
    activeMigration: '020_phase8_deployment_posture.sql',
    archiveMode: 'off',
    sandboxEnabled: true,
    demoEnabled: true,
    writesSuspended: false,
    workerHeartbeatAgeSeconds: null,
    schedulerHeartbeatAgeSeconds: 1,
    openCriticalIncidents: 0,
    runtimeRolesConfined: true,
  }, {});
  assert.equal(report.status, 'NOT_READY');
  assert.equal(report.release.workerVersion, null);
  assert.equal(report.release.schedulerVersion, null);
  assert.equal(report.runtime.deadlockRetries, null);
  assert.equal(report.security.credentialExpiration, null);
  assert.equal(report.security.unauthorizedFinancialOperations, null);
  assert.equal(report.backup.offsiteCopy, null);
  assert.equal(report.backup.walSuccess, null);
  assert.equal(report.financial.latestVerification, null);
});
