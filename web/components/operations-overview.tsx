'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Money } from './ui';

type Liability = { currency: string; exponent: number; customerLiabilityMinor: string; sandboxFundingIssuedMinor: string };
type OperationsReport = {
  generatedAt?: string;
  database?: string;
  issuanceEnabled?: boolean;
  externalAssets?: { status?: string; reason?: string };
  reportingNote?: string;
  financialIntegrity?: {
    independentVerification?: { status?: string; reason?: string };
    reconciliation?: { balanced?: boolean; checkedAt?: string } | null;
    writesSuspended?: boolean;
    suspensionReason?: string | null;
  };
  systemHealth?: {
    workerProcess?: string;
    outboxBacklogCount?: number | string | null;
    outboxOldestAgeSeconds?: number | string | null;
    recoveryTest?: { status?: string; reason?: string };
  };
  governance?: { pending?: number; expiringWithin4Hours?: number; recentAuthorizationFailures?: unknown[] };
  risk?: { openFlags?: number; openCases?: number; limitRejections24h?: number; highSeverityOpenFlags?: number };
  liabilities?: Liability[];
  transfers?: Array<{ currency: string; state: string; count: number; amountMinor: string }>;
};

function line(label: string, value: string) {
  return <p className="ledger-watch-line mono">{label} / {value}</p>;
}
function shown(value: unknown, unavailable = 'UNAVAILABLE') {
  if (value === null || value === undefined || value === '') return unavailable;
  return String(value);
}

export function OperationsOverview() {
  const [report, setReport] = useState<OperationsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setReport(await api<OperationsReport>('/v1/admin/operations')); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'OPERATIONS_UNAVAILABLE'); }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 15000);
    return () => clearInterval(timer);
  }, [load]);
  const integrity = report?.financialIntegrity;
  const health = report?.systemHealth;
  const verification = integrity?.independentVerification?.status ?? 'UNAVAILABLE';
  const reconciliation = !report ? 'LOADING' : integrity?.reconciliation == null ? 'NO RECONCILIATION REPORT RECORDED' : integrity.reconciliation.balanced ? `BALANCED / ${integrity.reconciliation.checkedAt ?? 'TIME UNAVAILABLE'}` : 'MISMATCH';
  return <section className="ledger-watch"><div className="section-heading"><div><span className="eyebrow">OPERATIONS / LIVE READ</span><h2>Institution status</h2></div><button className="text-button tiny" onClick={() => void load()}>Read again ↗</button></div>
    {error ? line('REPORT', `UNAVAILABLE / ${error}`) : !report ? line('REPORT', 'LOADING') : <>
      {line('VERIFICATION', verification)}
      {verification === 'UNAVAILABLE' && <p className="tiny">{integrity?.independentVerification?.reason}</p>}
      {line('RECONCILIATION', reconciliation)}
      {line('FINANCIAL WRITES', integrity?.writesSuspended ? `SUSPENDED / ${integrity.suspensionReason ?? 'REASON UNAVAILABLE'}` : 'ACTIVE')}
      {line('DATABASE', shown(report.database))}
      {line('RECOVERY DRILL', shown(health?.recoveryTest?.status))}
      {health?.recoveryTest?.status === 'UNAVAILABLE' && <p className="tiny">{health.recoveryTest.reason}</p>}
      {line('GOVERNANCE PENDING', shown(report.governance?.pending, 'UNKNOWN'))}
      {line('EXPIRING WITHIN 4 HOURS', shown(report.governance?.expiringWithin4Hours, 'UNKNOWN'))}
      {line('OPEN RISK FLAGS', shown(report.risk?.openFlags, 'UNKNOWN'))}
      {line('OPEN CASES', shown(report.risk?.openCases, 'UNKNOWN'))}
      {line('LIMIT REJECTIONS 24H', shown(report.risk?.limitRejections24h, 'UNKNOWN'))}
      {line('HIGH SEVERITY FLAGS', shown(report.risk?.highSeverityOpenFlags, 'UNKNOWN'))}
      {line('ISSUANCE', report.issuanceEnabled === false ? 'DISABLED' : shown(report.issuanceEnabled, 'UNKNOWN'))}
      {line('EXTERNAL ASSETS', shown(report.externalAssets?.status))}
      {report.externalAssets?.status === 'UNAVAILABLE' && <p className="tiny">{report.externalAssets.reason}</p>}
      <div className="ledger-events">{(report.liabilities ?? []).map(row => <article className="ledger-event" key={row.currency}><div className="ledger-event-main"><span className="mono">{row.currency} / CUSTOMER LIABILITY</span><Money amount={row.customerLiabilityMinor} currency={row.currency} /></div><p className="tiny">Sandbox funding issued <Money amount={row.sandboxFundingIssuedMinor} currency={row.currency} />. This is not an external asset.</p></article>)}</div>
      <p className="tiny">{report.reportingNote}</p>
      <p className="tiny">Worker, quarantine, backup, and verifier measurements are on Process health. This report does not substitute a heartbeat for a worker status. Completed transfer volume is listed by currency. Rejected transfers are not added to completed volume.</p>
      <div className="ledger-events">{(report.transfers ?? []).filter(row => row.state !== 'COMPLETED').map(row => <article className="ledger-event" key={`${row.currency}-${row.state}`}><div className="ledger-event-main"><span className="mono">{row.currency} / {row.count} {row.state}</span><Money amount={row.amountMinor} currency={row.currency} /></div></article>)}</div>
      <div className="ledger-events">{(report.transfers ?? []).filter(row => row.state === 'COMPLETED').map(row => <article className="ledger-event" key={`${row.currency}-${row.state}`}><div className="ledger-event-main"><span className="mono">{row.currency} / {row.count} COMPLETED</span><Money amount={row.amountMinor} currency={row.currency} /></div></article>)}</div>
    </>}
  </section>;
}
