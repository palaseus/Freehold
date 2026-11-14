'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Report = {
  generatedAt?: string;
  status?: string;
  blockers?: string[];
  release?: {
    sourceRevision?: string | null;
    apiVersion?: string | null;
    workerVersion?: string | null;
    schedulerVersion?: string | null;
    verifierAlgorithmVersion?: string | null;
    expectedMigration?: string | null;
    activeMigration?: string | null;
    schemaCompatible?: boolean | null;
  };
  runtime?: {
    archiveMode?: string | null;
    workerHeartbeatAgeSeconds?: number | null;
    schedulerHeartbeatAgeSeconds?: number | null;
    workerHeartbeatState?: string | null;
    schedulerHeartbeatState?: string | null;
    dueInstructionCount?: number | null;
    oldestDueAgeSeconds?: number | null;
    outboxPending?: string | null;
    outboxOldestAgeSeconds?: number | string | null;
    outboxQuarantined?: string | null;
    deadlockRetries?: number | null;
    writesSuspended?: boolean | null;
  };
  financial?: {
    latestVerification?: string | null;
    reconciliationBalanced?: boolean | null;
    projectionMismatchCount?: string | null;
    activeHoldMismatchCount?: string | null;
    writesSuspended?: boolean | null;
  };
  backup?: {
    offsiteCopy?: boolean | null;
    generatedAt?: string | null;
    ageHours?: number | null;
    walArchive?: string | null;
    walSuccess?: string | null;
    recoveryOutcome?: string | null;
    storageFreeBytes?: number | null;
  };
  security?: {
    authorizationFailureCount?: string | null;
    unauthorizedFinancialOperations?: string | null;
    openCriticalIncidents?: number | null;
    pendingGovernanceApprovals?: string | null;
    credentialExpiration?: string | null;
  };
};

function shown(value: unknown, empty = 'UNAVAILABLE') {
  if (value === null || value === undefined || value === '') return empty;
  return String(value);
}

export function DeploymentStatus() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setReport(await api<Report>('/v1/admin/deployment')); setError(null); }
    catch (e) { setReport(null); setError(e instanceof Error ? e.message : 'DEPLOYMENT_UNAVAILABLE'); }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 15000);
    return () => clearInterval(timer);
  }, [load]);
  const due = report?.runtime?.dueInstructionCount;
  const delay = due === 0 ? 'NONE' : shown(report?.runtime?.oldestDueAgeSeconds);
  const pending = report?.runtime?.outboxPending;
  const oldest = pending === '0' ? 'NONE' : shown(report?.runtime?.outboxOldestAgeSeconds);
  const backup = report?.backup?.offsiteCopy === true ? 'INDEPENDENT COPY RECORDED' : report?.backup?.offsiteCopy === false ? 'NO INDEPENDENT COPY' : 'UNAVAILABLE';
  const suspension = report?.financial?.writesSuspended === true ? 'SUSPENDED' : report?.financial?.writesSuspended === false ? 'NOT SUSPENDED' : 'UNAVAILABLE';
  return <section className="ledger-watch"><div className="section-heading"><div><span className="eyebrow">DEPLOYMENT / EVIDENCE</span><h2>Deployment</h2></div><button className="text-button tiny" onClick={() => void load()}>Read again ↗</button></div>
    {error ? <p className="ledger-watch-line mono">DEPLOYMENT STATUS / UNAVAILABLE / {error}</p> : !report ? <p className="ledger-watch-line mono">DEPLOYMENT STATUS / LOADING</p> : <>
      <p className="ledger-watch-line mono">DEPLOYMENT STATUS / {shown(report.status)}</p>
      <p className="ledger-watch-line mono">RELEASE / {shown(report.release?.sourceRevision)} / API {shown(report.release?.apiVersion)}</p>
      <p className="ledger-watch-line mono">MIGRATION / ACTIVE {shown(report.release?.activeMigration)} / EXPECTED {shown(report.release?.expectedMigration)} / COMPATIBLE {shown(report.release?.schemaCompatible)}</p>
      <p className="ledger-watch-line mono">WORKER VERSION / UNAVAILABLE / SCHEDULER VERSION / UNAVAILABLE / VERIFIER ALGORITHM {shown(report.release?.verifierAlgorithmVersion)}</p>
      <p className="ledger-watch-line mono">LATEST VERIFICATION / {shown(report.financial?.latestVerification)}</p>
      <p className="ledger-watch-line mono">RECONCILIATION / {report.financial?.reconciliationBalanced == null ? 'UNAVAILABLE' : report.financial.reconciliationBalanced ? 'BALANCED' : 'NOT BALANCED'}</p>
      <p className="ledger-watch-line mono">JOURNAL DISCREPANCIES / PROJECTION {shown(report.financial?.projectionMismatchCount)} / HOLDS {shown(report.financial?.activeHoldMismatchCount)}</p>
      <p className="ledger-watch-line mono">EMERGENCY FINANCIAL WRITES / {suspension}</p>
      <p className="ledger-watch-line mono">LAST VERIFIED BACKUP / {backup}</p>
      <p className="ledger-watch-line mono">BACKUP AGE HOURS / {shown(report.backup?.ageHours)} / WAL ARCHIVE MODE {shown(report.backup?.walArchive)} / WAL SUCCESS UNAVAILABLE</p>
      <p className="ledger-watch-line mono">RECOVERY DRILL / {shown(report.backup?.recoveryOutcome)} / STORAGE FREE BYTES / {shown(report.backup?.storageFreeBytes)}</p>
      <p className="ledger-watch-line mono">WORKER HEARTBEAT AGE SECONDS / {shown(report.runtime?.workerHeartbeatAgeSeconds)} / SCHEDULER HEARTBEAT AGE SECONDS / {shown(report.runtime?.schedulerHeartbeatAgeSeconds)}</p>
      <p className="ledger-watch-line mono">WORKER HEARTBEAT / {shown(report.runtime?.workerHeartbeatState)} / SCHEDULER HEARTBEAT / {shown(report.runtime?.schedulerHeartbeatState)}</p>
      <p className="ledger-watch-line mono">OUTBOX PENDING / {shown(pending)} / OLDEST AGE SECONDS / {oldest} / QUARANTINED / {shown(report.runtime?.outboxQuarantined)}</p>
      <p className="ledger-watch-line mono">SCHEDULER DUE / {shown(due)} / DELAY SECONDS / {delay} / DEADLOCK RETRIES / UNAVAILABLE</p>
      <p className="ledger-watch-line mono">PRIVILEGED AUTH FAILURES STORED / {shown(report.security?.authorizationFailureCount)} / UNAUTHORIZED FINANCIAL OPERATIONS / UNAVAILABLE</p>
      <p className="ledger-watch-line mono">OPEN CRITICAL INCIDENTS / {shown(report.security?.openCriticalIncidents)} / PENDING GOVERNANCE APPROVALS / {shown(report.security?.pendingGovernanceApprovals)}</p>
      <p className="ledger-watch-line mono">CREDENTIAL EXPIRATION / UNAVAILABLE</p>
      {report.blockers?.length ? report.blockers.map(blocker => <p className="tiny" key={blocker}>{blocker}</p>) : null}
      <p className="tiny">Read at {report.generatedAt ?? 'TIME UNAVAILABLE'}. Missing evidence stays unavailable. This panel does not treat a live API as READY.</p>
    </>}
  </section>;
}
