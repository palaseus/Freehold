import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const VERIFIER_ALGORITHM_VERSION = '1.7.0';
export type DeploymentStatus = 'READY' | 'NOT_READY' | 'INCOMPLETE' | 'UNAVAILABLE';
export type HeartbeatState = 'FRESH' | 'STALE' | 'MISSING' | 'UNAVAILABLE';

export type DeploymentFacts = {
  databaseRead: boolean;
  activeMigration: string | null;
  expectedMigration: string | null;
  archiveMode: string | null;
  sandboxEnabled: boolean | null;
  demoEnabled: boolean | null;
  writesSuspended: boolean | null;
  workerHeartbeatAgeSeconds: number | null;
  schedulerHeartbeatAgeSeconds: number | null;
  workerHeartbeatState?: HeartbeatState;
  schedulerHeartbeatState?: HeartbeatState;
  openCriticalIncidents: number | null;
  runtimeRolesConfined: boolean | null;
  sourceRevision: string | null;
  lastVerificationOutcome: string | null;
  lastBackupOffsite: boolean | null;
  lastRecoveryOutcome: string | null;
};

const HEARTBEAT_MAX_SECONDS = 120;

function knownBad(value: 'ok' | 'bad' | 'missing'): boolean {
  return value === 'bad';
}

function prove(ok: boolean, bad: boolean): 'ok' | 'bad' | 'missing' {
  if (ok) return 'ok';
  if (bad) return 'bad';
  return 'missing';
}

export function heartbeatState(record: Record<string, unknown> | null | undefined, key: string): HeartbeatState {
  if (record == null || !Object.prototype.hasOwnProperty.call(record, key)) return 'UNAVAILABLE';
  const age = asNumber(record[key]);
  if (age == null) return 'MISSING';
  if (age > HEARTBEAT_MAX_SECONDS) return 'STALE';
  return 'FRESH';
}

function heartbeatProof(state: HeartbeatState | undefined, age: number | null): 'ok' | 'bad' | 'missing' {
  if (state === 'FRESH') return 'ok';
  if (state === 'STALE' || state === 'MISSING') return 'bad';
  if (state === 'UNAVAILABLE') return 'missing';
  return prove(age != null && age <= HEARTBEAT_MAX_SECONDS, age == null || age > HEARTBEAT_MAX_SECONDS);
}

function heartbeatLabel(role: 'Worker' | 'Scheduler', state: HeartbeatState | undefined): string {
  if (state === 'UNAVAILABLE') return `${role} heartbeat telemetry is unavailable.`;
  if (state === 'MISSING') return `${role} heartbeat is missing.`;
  if (state === 'STALE') return `${role} heartbeat is stale.`;
  return `${role} heartbeat is missing or older than 120 seconds.`;
}

export function assessDeployment(facts: DeploymentFacts): { status: DeploymentStatus; blockers: string[] } {
  if (!facts.databaseRead) return { status: 'UNAVAILABLE', blockers: ['The database posture could not be read.'] };
  const measured = [
    prove(facts.activeMigration != null && facts.expectedMigration != null && facts.activeMigration === facts.expectedMigration, facts.activeMigration != null && facts.expectedMigration != null && facts.activeMigration !== facts.expectedMigration),
    prove(facts.archiveMode === 'on' || facts.archiveMode === 'always', facts.archiveMode != null && facts.archiveMode !== 'on' && facts.archiveMode !== 'always'),
    prove(facts.sandboxEnabled === false, facts.sandboxEnabled === true),
    prove(facts.demoEnabled === false, facts.demoEnabled === true),
    prove(facts.writesSuspended === false, facts.writesSuspended === true),
    heartbeatProof(facts.workerHeartbeatState, facts.workerHeartbeatAgeSeconds),
    heartbeatProof(facts.schedulerHeartbeatState, facts.schedulerHeartbeatAgeSeconds),
    prove(facts.openCriticalIncidents === 0, facts.openCriticalIncidents != null && facts.openCriticalIncidents > 0),
    prove(facts.runtimeRolesConfined === true, facts.runtimeRolesConfined === false),
    prove(facts.lastVerificationOutcome === 'VERIFIED', facts.lastVerificationOutcome != null),
    prove(facts.lastBackupOffsite === true, facts.lastBackupOffsite === false),
    prove(facts.lastRecoveryOutcome === 'VERIFIED', facts.lastRecoveryOutcome != null),
  ];
  const labels = [
    `Active migration ${facts.activeMigration ?? 'none'} does not match expected ${facts.expectedMigration ?? 'unknown'}.`,
    `archive_mode is ${facts.archiveMode ?? 'unknown'}.`,
    'sandbox_enabled is not false.',
    'demo mode is not false.',
    facts.writesSuspended === true ? 'Financial writes are suspended.' : 'Financial write suspension could not be read.',
    heartbeatLabel('Worker', facts.workerHeartbeatState),
    heartbeatLabel('Scheduler', facts.schedulerHeartbeatState),
    facts.openCriticalIncidents != null && facts.openCriticalIncidents > 0 ? 'An open critical incident is stored.' : 'Open critical incidents could not be read.',
    'Runtime roles are missing or not confined.',
    facts.lastVerificationOutcome ? `Independent verification is ${facts.lastVerificationOutcome}.` : 'A successful independent verification is not recorded.',
    facts.lastBackupOffsite === false ? 'The backup manifest does not record an independently administered copy.' : 'An independently administered backup is not recorded.',
    facts.lastRecoveryOutcome ? `Recovery drill outcome is ${facts.lastRecoveryOutcome}.` : 'A successful recovery drill is not recorded.',
  ];
  const bad = measured.map((item, index) => knownBad(item) ? labels[index] : null).filter((item): item is string => item != null);
  if (bad.length) return { status: 'NOT_READY', blockers: bad };
  const missing = measured.map((item, index) => item === 'missing' ? labels[index] : null).filter((item): item is string => item != null);
  if (!facts.sourceRevision || facts.sourceRevision === 'unknown') missing.push('Source revision is not recorded.');
  if (missing.length) return { status: 'INCOMPLETE', blockers: missing };
  return { status: 'READY', blockers: [] };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

export function expectedMigrationFile(): string | null {
  try {
    const names = readdirSync(join(__dirname, '../../../db/migrations')).filter(name => name.endsWith('.sql')).sort();
    return names.at(-1) ?? null;
  } catch {
    return null;
  }
}

function packageVersion(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8')) as { version?: unknown };
    return asString(parsed.version);
  } catch {
    return null;
  }
}

function readJson(path: string | undefined): Record<string, unknown> | null {
  if (!path) return null;
  try {
    const text = readFileSync(path, 'utf8');
    if (text.length > 1_000_000) return null;
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function assembleDeployment(posture: Record<string, unknown> | null, env: NodeJS.ProcessEnv = process.env) {
  const expectedMigration = expectedMigrationFile();
  const verification = readJson(env.FREEHOLD_VERIFICATION_REPORT);
  const backup = readJson(env.FREEHOLD_BACKUP_MANIFEST);
  const recovery = readJson(env.FREEHOLD_RECOVERY_REPORT);
  const storage = readJson(env.FREEHOLD_STORAGE_REPORT);
  const reconciliation = posture?.latestReconciliation && typeof posture.latestReconciliation === 'object'
    ? posture.latestReconciliation as Record<string, unknown> : null;
  const generatedAt = new Date().toISOString();
  let backupAgeHours: number | null = null;
  const backupAt = asString(backup?.generatedAt);
  if (backupAt) {
    const age = Date.now() - Date.parse(backupAt);
    backupAgeHours = Number.isFinite(age) ? Math.floor(age / 3600000) : null;
  }
  const workerHeartbeatState = heartbeatState(posture, 'workerHeartbeatAgeSeconds');
  const schedulerHeartbeatState = heartbeatState(posture, 'schedulerHeartbeatAgeSeconds');
  const facts: DeploymentFacts = {
    databaseRead: posture != null,
    activeMigration: asString(posture?.activeMigration),
    expectedMigration,
    archiveMode: asString(posture?.archiveMode),
    sandboxEnabled: asBool(posture?.sandboxEnabled),
    demoEnabled: asBool(posture?.demoEnabled),
    writesSuspended: asBool(posture?.writesSuspended),
    workerHeartbeatAgeSeconds: asNumber(posture?.workerHeartbeatAgeSeconds),
    schedulerHeartbeatAgeSeconds: asNumber(posture?.schedulerHeartbeatAgeSeconds),
    workerHeartbeatState,
    schedulerHeartbeatState,
    openCriticalIncidents: asNumber(posture?.openCriticalIncidents),
    runtimeRolesConfined: asBool(posture?.runtimeRolesConfined),
    sourceRevision: asString(env.FREEHOLD_SOURCE_REVISION),
    lastVerificationOutcome: asString(verification?.outcome),
    lastBackupOffsite: backup ? backup.offsiteCopy === true : null,
    lastRecoveryOutcome: asString(recovery?.outcome),
  };
  const assessment = assessDeployment(facts);
  const due = asNumber(posture?.dueInstructionCount);
  return {
    generatedAt,
    status: assessment.status,
    blockers: assessment.blockers,
    release: {
      sourceRevision: facts.sourceRevision,
      apiVersion: packageVersion(),
      workerVersion: null,
      schedulerVersion: null,
      verifierAlgorithmVersion: VERIFIER_ALGORITHM_VERSION,
      expectedMigration,
      activeMigration: facts.activeMigration,
      schemaCompatible: facts.activeMigration != null && facts.activeMigration === expectedMigration,
    },
    runtime: {
      archiveMode: facts.archiveMode,
      walLevel: asString(posture?.walLevel),
      sandboxEnabled: facts.sandboxEnabled,
      demoEnabled: facts.demoEnabled,
      writesSuspended: facts.writesSuspended,
      runtimeRolesConfined: facts.runtimeRolesConfined,
      workerHeartbeatAgeSeconds: facts.workerHeartbeatAgeSeconds,
      schedulerHeartbeatAgeSeconds: facts.schedulerHeartbeatAgeSeconds,
      workerHeartbeatState,
      schedulerHeartbeatState,
      workerHeartbeatAt: asString(posture?.workerHeartbeatAt),
      schedulerHeartbeatAt: asString(posture?.schedulerHeartbeatAt),
      dueInstructionCount: due,
      oldestDueAgeSeconds: due === 0 ? null : asNumber(posture?.oldestDueAgeSeconds),
      outboxPending: asString(posture?.outboxPending),
      outboxOldestAgeSeconds: posture?.outboxOldestAgeSeconds ?? null,
      outboxQuarantined: asString(posture?.outboxQuarantined),
      deadlockRetries: null,
    },
    financial: {
      latestVerification: facts.lastVerificationOutcome,
      reconciliationBalanced: reconciliation ? asBool(reconciliation.balanced) : null,
      reconciliationAt: reconciliation ? asString(reconciliation.recordedAt) : null,
      debitsEqualCredits: reconciliation ? asString(reconciliation.debitsEqualCredits) : null,
      projectionMismatchCount: reconciliation ? asString(reconciliation.projectionMismatchCount) : null,
      activeHoldMismatchCount: reconciliation ? asString(reconciliation.activeHoldMismatchCount) : null,
      writesSuspended: facts.writesSuspended,
    },
    backup: {
      offsiteCopy: facts.lastBackupOffsite,
      generatedAt: backupAt,
      ageHours: backupAgeHours,
      walArchive: facts.archiveMode,
      walSuccess: null,
      recoveryOutcome: facts.lastRecoveryOutcome,
      storageFreeBytes: asNumber(storage?.freeBytes),
    },
    security: {
      authorizationFailureCount: asString(posture?.authorizationFailureCount),
      unauthorizedFinancialOperations: null,
      openCriticalIncidents: facts.openCriticalIncidents,
      pendingGovernanceApprovals: asString(posture?.pendingGovernanceApprovals),
      credentialExpiration: null,
    },
    unavailableReasons: {
      workerVersion: 'Worker heartbeats do not record a build version.',
      schedulerVersion: 'Scheduler heartbeats do not record a build version.',
      deadlockRetries: 'Deadlock retries are not stored.',
      unauthorizedFinancialOperations: 'No separate counter of unauthorized financial postings is stored.',
      credentialExpiration: 'No credential expiration record is stored.',
      walSuccess: 'archive_mode is not evidence that a segment was archived.',
      latestVerification: 'Verifier output is external evidence and is not stored in this database.',
      backup: 'Backup evidence is not stored in this database.',
      recovery: 'Recovery drill evidence is not stored in this database.',
      storage: 'Storage capacity is not stored in this database.',
    },
  };
}
