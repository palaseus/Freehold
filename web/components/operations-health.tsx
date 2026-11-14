'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Health = {
  generatedAt?: string;
  database?: string;
  workerProcess?: string;
  workerLastSeenAt?: string | null;
  schedulerProcess?: string;
  schedulerLastSeenAt?: string | null;
  outboxBacklogCount?: number | string | null;
  outboxOldestAgeSeconds?: number | string | null;
  outboxQuarantinedCount?: number | string | null;
  backupHealth?: { status?: string; reason?: string };
  latestVerifier?: { status?: string; reason?: string };
};

function shown(value: unknown, empty = 'UNAVAILABLE') {
  if (value === null || value === undefined || value === '') return empty;
  return String(value);
}

export function OperationsHealth() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setHealth(await api<Health>('/v1/admin/operations/health')); setError(null); }
    catch (e) { setHealth(null); setError(e instanceof Error ? e.message : 'HEALTH_UNAVAILABLE'); }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 15000);
    return () => clearInterval(timer);
  }, [load]);
  const backlog = health?.outboxBacklogCount;
  const age = backlog === 0 || backlog === '0' ? 'NONE' : shown(health?.outboxOldestAgeSeconds);
  return <section className="ledger-watch"><div className="section-heading"><div><span className="eyebrow">OPERATIONS / MEASURED</span><h2>Process health</h2></div><button className="text-button tiny" onClick={() => void load()}>Read again ↗</button></div>
    {error ? <p className="ledger-watch-line mono">HEALTH / UNAVAILABLE / {error}</p> : !health ? <p className="ledger-watch-line mono">HEALTH / LOADING</p> : <>
      <p className="ledger-watch-line mono">DATABASE / {shown(health.database)}</p>
      <p className="ledger-watch-line mono">WORKER / {shown(health.workerProcess)}{health.workerLastSeenAt ? ` / LAST SEEN ${health.workerLastSeenAt}` : health.workerProcess === 'UNAVAILABLE' ? ' / NO HEARTBEAT RECORDED' : ''}</p>
      <p className="ledger-watch-line mono">SCHEDULER / {shown(health.schedulerProcess)}{health.schedulerLastSeenAt ? ` / LAST SEEN ${health.schedulerLastSeenAt}` : health.schedulerProcess === 'UNAVAILABLE' ? ' / NO HEARTBEAT RECORDED' : ''}</p>
      <p className="ledger-watch-line mono">OUTBOX BACKLOG / {shown(backlog)} / OLDEST AGE SECONDS / {age}</p>
      <p className="ledger-watch-line mono">QUARANTINED EVENTS / {shown(health.outboxQuarantinedCount)}</p>
      <p className="ledger-watch-line mono">BACKUP / {shown(health.backupHealth?.status)}</p>
      {health.backupHealth?.reason && <p className="tiny">{health.backupHealth.reason}</p>}
      <p className="ledger-watch-line mono">VERIFIER / {shown(health.latestVerifier?.status)}</p>
      {health.latestVerifier?.reason && <p className="tiny">{health.latestVerifier.reason}</p>}
      <p className="tiny">Read at {health.generatedAt ?? 'TIME UNAVAILABLE'}. Blank metrics stay unavailable. This panel does not invent worker, scheduler, backup, or verifier results.</p>
    </>}
  </section>;
}
