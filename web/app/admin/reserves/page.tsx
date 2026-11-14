'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { ErrorNotice, PageHeading, State } from '@/components/ui';
import { api } from '@/lib/api';

type Book = {
  code: string; outstanding: string; pendingIssuance: string; pendingRedemption: string;
  simulatedEligibleReserves: string; coverageGapMinor: string; issuanceCapacityMinor: string;
  redemptionSuspended: boolean;
};
type Maturity = { category: string; bucket: string; evidenceState: string; amountMinor: string; rowCount: string; countsAsExternalAsset: boolean };
type Dashboard = {
  simulationOnly: boolean; simulatedReservesAreRealAssets: boolean; independentVerification: string;
  externalReserveEvidence: string; books: Book[]; maturityDistribution: Maturity[];
  failedSettlements: Array<{ redemptionId: string; state: string; amountMinor: string; externalSettlement: boolean }>;
  reserveDeficitAlerts: Array<{ alertId: string; code: string; acknowledged: boolean }>;
  approvalQueue: Array<{ kind: string; id: string; amountMinor: string }>;
};

function evidenceLabel(state: string) {
  if (state === 'VERIFIED') return 'Simulated internal record';
  if (state === 'UNVERIFIED') return 'Not confirmed';
  if (state === 'PENDING_CONFIRMATION') return 'Pending confirmation';
  if (state === 'REJECTED') return 'Rejected';
  if (state === 'STALE') return 'Stale';
  return 'Recorded';
}

function Reserves() {
  const { session } = useSession();
  const fresh = !!session?.recentTwoFactorUntil && new Date(session.recentTwoFactorUntil).getTime() > Date.now();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setDashboard(await api<Dashboard>('/v1/monetary/dashboard'));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'DASHBOARD_UNAVAILABLE');
    }
  }, []);
  useEffect(() => { if (session?.user.role === 'ADMIN' && fresh) void load(); }, [session, fresh, load]);
  if (session?.user.role !== 'ADMIN') return <State label="ACCESS / RESTRICTED" title="Institution access required."><p>Your role does not permit the reserve position.</p></State>;
  if (!fresh) return <State label="AUTHORIZATION / 2FA EXPIRED" title="Verify your access again." action={<Link className="button" href="/login">Sign in with an authenticator ↗</Link>}><p>The reserve position requires authenticator verification within the last five minutes.</p></State>;
  return <>
    <PageHeading index="10" title="Simulated reserve position" />
    <div className="page-intro"><p>These figures are simulated ledger records. They are not cash, deposits, or external assets. This screen does not verify backing.</p><span className="eyebrow">SIMULATION ONLY</span></div>
    {error && <ErrorNotice code={error}>The reserve position could not be read.</ErrorNotice>}
    {dashboard && <>
      <section className="section">
        <div className="section-heading"><h2>Evidence availability</h2></div>
        <p className="ledger-caption">Simulated reserves are not real assets.</p>
        <p className="ledger-caption">External reserve evidence: {dashboard.externalReserveEvidence}. Independent check: {dashboard.independentVerification}.</p>
        <p className="tiny">A database row is not cash. No external custodian confirmation is attached to this screen.</p>
      </section>
      {dashboard.books.map(book => <section className="section" key={book.code}>
        <div className="section-heading"><h2>{book.code}</h2><span className="eyebrow">MINOR UNITS</span></div>
        <p className="ledger-caption">Outstanding {book.outstanding}. Simulated eligible reserves {book.simulatedEligibleReserves}. Coverage gap {book.coverageGapMinor}.</p>
        <p className="ledger-caption">Issuance capacity {book.issuanceCapacityMinor}. Pending issuance {book.pendingIssuance}. Pending redemption {book.pendingRedemption}. Redemption suspended: {book.redemptionSuspended ? 'yes' : 'no'}.</p>
      </section>)}
      <section className="section">
        <div className="section-heading"><h2>Maturity distribution</h2></div>
        {!dashboard.maturityDistribution.length ? <p className="tiny">No simulated reserve rows are stored.</p> : dashboard.maturityDistribution.map(row => <p className="ledger-caption" key={`${row.category}-${row.bucket}-${row.evidenceState}`}>{row.category} / {row.bucket} / {evidenceLabel(row.evidenceState)}. Amount {row.amountMinor} minor units. Rows {row.rowCount}. Counts as an external asset: no.</p>)}
      </section>
      <section className="section">
        <div className="section-heading"><h2>Reserve deficit alerts</h2></div>
        {!dashboard.reserveDeficitAlerts.length ? <p className="tiny">No open reserve deficit alert.</p> : dashboard.reserveDeficitAlerts.map(alert => <p className="ledger-caption" key={alert.alertId}>Open alert {alert.code}. Simulated eligible reserves are below outstanding simulated units. Acknowledged: {alert.acknowledged ? 'yes' : 'no'}.</p>)}
      </section>
      <section className="section">
        <div className="section-heading"><h2>Failed settlement cases</h2></div>
        {!dashboard.failedSettlements.length ? <p className="tiny">No failed simulated settlement is stored.</p> : dashboard.failedSettlements.map(row => <p className="ledger-caption" key={row.redemptionId}>Redemption {row.state}. Amount {row.amountMinor} minor units. External settlement: {row.externalSettlement ? 'yes' : 'no'}.</p>)}
      </section>
      <section className="section">
        <div className="section-heading"><h2>Governance approval queue</h2></div>
        {!dashboard.approvalQueue.length ? <p className="tiny">No issuance or cap request is waiting for approval.</p> : dashboard.approvalQueue.map(row => <p className="ledger-caption" key={row.id}>{row.kind}. Amount {row.amountMinor} minor units.</p>)}
      </section>
    </>}
  </>;
}

export default function Page() { return <Shell><Reserves /></Shell>; }
