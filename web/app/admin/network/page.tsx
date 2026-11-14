'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { ErrorNotice, PageHeading, State } from '@/components/ui';
import { api } from '@/lib/api';

type Member = { institutionId: string; status: string; riskClass: string; liveAuthorized: boolean };
type Position = { cycleId: string; institutionId: string; currency: string; grossOutgoingMinor: string; grossIncomingMinor: string; netMinor: string };
type Dashboard = {
  simulationOnly: boolean;
  liveRails: boolean;
  licensedPaymentSystem: boolean;
  customerNamesIncluded: boolean;
  recordedPositionsAreNotIndependentVerification: boolean;
  independentVerificationStored: boolean;
  emptyMessage: string | null;
  membership: { active: number; suspended: number; pending: number; terminated: number; rulebookAccepted: number; members: Member[] };
  payments: { instructions: number; pending: number; failed: number; routingExceptions: number };
  clearing: { cycles: number; openCycles: number; finalizedCycles: number; failedCycles: number; grossObligationsMinor: string; excludedObligations: number; positions: Position[] };
  settlement: { pendingInstructions: number; simulatedConfirmations: number; final: number; failed: number; unknown: number };
  risk: { zeroOpeningActiveMembers: number; concentrationBps: string; staleSettlementEvidence: number };
  integrity: { workerBacklog: number; signatureCheck: string; independentVerification: string };
};

function Network() {
  const { session } = useSession();
  const fresh = !!session?.recentTwoFactorUntil && new Date(session.recentTwoFactorUntil).getTime() > Date.now();
  const [board, setBoard] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setBoard(await api<Dashboard>('/v1/institution/network/dashboard'));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'NETWORK_UNAVAILABLE');
    }
  }, []);
  useEffect(() => { if (session?.user.role === 'ADMIN' && fresh) void load(); }, [session, fresh, load]);
  if (session?.user.role !== 'ADMIN') return <State label="ACCESS / RESTRICTED" title="Institution access required."><p>Your role does not permit simulated network records.</p></State>;
  if (!fresh) return <State label="AUTHORIZATION / 2FA EXPIRED" title="Verify your access again." action={<Link className="button" href="/login">Sign in with an authenticator ↗</Link>}><p>Simulated network records require authenticator verification within the last five minutes.</p></State>;
  return <>
    <PageHeading index="15" title="Simulated financial network" />
    <div className="page-intro"><p>These figures are simulated network activity among fictional member institutions. Live rails are off. This is not a licensed payment system, and a recorded net position is not settlement at a bank.</p><span className="eyebrow">SIMULATED NETWORK</span></div>
    {error && <ErrorNotice code={error}>The simulated network could not be read.</ErrorNotice>}
    {!board && !error && <p className="tiny">Reading simulated network records.</p>}
    {board && <>
      <section className="section">
        <div className="section-heading"><h2>Network membership</h2><span className="eyebrow">{board.simulationOnly ? 'SIMULATION ONLY' : 'REVIEW'}</span></div>
        <p className="tiny">Active {board.membership.active}. Suspended {board.membership.suspended}. Pending {board.membership.pending}. Terminated {board.membership.terminated}. Rulebook acceptances {board.membership.rulebookAccepted}. Live authorized: no. Licensed payment system: {board.licensedPaymentSystem ? 'review' : 'no'}.</p>
        {!board.membership.members.length ? <p className="tiny">No simulated member is recorded.</p> : board.membership.members.map(member => <article className="ledger-event" key={member.institutionId}>
          <div className="ledger-event-main"><span className="mono">{member.institutionId}</span></div>
          <p className="ledger-caption">Status {member.status}. Risk {member.riskClass}. Live authorized: no.</p>
        </article>)}
      </section>
      <section className="section">
        <div className="section-heading"><h2>Payment activity</h2></div>
        <p className="tiny">Instructions {board.payments.instructions}. Pending {board.payments.pending}. Failed or unknown {board.payments.failed}. Routing exceptions {board.payments.routingExceptions}.</p>
        {board.emptyMessage && <p className="tiny">{board.emptyMessage}</p>}
      </section>
      <section className="section">
        <div className="section-heading"><h2>Clearing</h2></div>
        <p className="tiny">Cycles {board.clearing.cycles}. Open {board.clearing.openCycles}. Finalized {board.clearing.finalizedCycles}. Failed {board.clearing.failedCycles}. Gross obligations {board.clearing.grossObligationsMinor}. Excluded {board.clearing.excludedObligations}.</p>
        <p className="tiny">Recorded positions are not an independent verification.</p>
        {board.clearing.positions.map(position => <article className="ledger-event" key={`${position.cycleId}-${position.institutionId}`}>
          <div className="ledger-event-main"><span className="mono">{position.institutionId}</span></div>
          <p className="ledger-caption">{position.currency} out {position.grossOutgoingMinor}, in {position.grossIncomingMinor}, net {position.netMinor}.</p>
        </article>)}
      </section>
      <section className="section">
        <div className="section-heading"><h2>Settlement</h2></div>
        <p className="tiny">Pending instructions {board.settlement.pendingInstructions}. Simulated confirmations {board.settlement.simulatedConfirmations}. Final {board.settlement.final}. Failed {board.settlement.failed}. Unknown {board.settlement.unknown}. A simulated confirmation is not external finality.</p>
      </section>
      <section className="section">
        <div className="section-heading"><h2>Risk</h2></div>
        <p className="tiny">Active members with zero opening liquidity {board.risk.zeroOpeningActiveMembers}. Concentration basis points {board.risk.concentrationBps}. Stale settlement evidence {board.risk.staleSettlementEvidence}. No central-bank balance is created here.</p>
      </section>
      <section className="section">
        <div className="section-heading"><h2>Integrity</h2></div>
        <p className="tiny">Independent verification stored: {board.independentVerificationStored ? 'yes' : 'no'}. {board.integrity.independentVerification}. Signature check {board.integrity.signatureCheck}. Worker backlog {board.integrity.workerBacklog}. Customer names included: {board.customerNamesIncluded ? 'yes' : 'no'}.</p>
      </section>
    </>}
  </>;
}

export default function NetworkPage() {
  return <Shell><Network /></Shell>;
}
