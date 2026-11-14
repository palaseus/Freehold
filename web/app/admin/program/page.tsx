'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { ErrorNotice, PageHeading, State } from '@/components/ui';
import { api } from '@/lib/api';

type Dashboard = {
  simulationOnly: boolean;
  liveRails: boolean;
  legalEscrow: boolean;
  fiduciaryCustody: boolean;
  publicExchange: boolean;
  liveIssuance: boolean;
  previewIsExecution: boolean;
  distributedAtomicity: boolean;
  recordedTotalsAreNotIndependentVerification: boolean;
  workflows: number;
  completed: number;
  unknown: number;
  escrows: number;
  assets: number;
  openQuotes: number;
  pledged: number;
  emptyMessage: string | null;
};

const forbidden = /select |insert |update |delete |drop |alter |javascript:|\/\*|eval\(/i;

function Program() {
  const { session } = useSession();
  const fresh = !!session?.recentTwoFactorUntil && new Date(session.recentTwoFactorUntil).getTime() > Date.now();
  const [board, setBoard] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exposure, setExposure] = useState('1000');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setBoard(await api<Dashboard>('/v1/institution/program/dashboard'));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'PROGRAM_UNAVAILABLE');
    }
  }, []);
  useEffect(() => { if (session?.user.role === 'ADMIN' && fresh) void load(); }, [session, fresh, load]);
  function buildDefinition() {
    setPreview(null);
    if (!/^[1-9][0-9]{0,18}$/.test(exposure)) {
      setBuildError('Enter a positive integer minor-unit limit.');
      return;
    }
    if (forbidden.test(note)) {
      setBuildError('PROGRAM_LANGUAGE');
      return;
    }
    const definition = {
      language: 'fh-workflow-1',
      domain: 'PAYMENT',
      steps: [{ op: 'RECONCILE' }],
    };
    setBuildError(null);
    setPreview(JSON.stringify({
      definition,
      maxExposureMinor: exposure,
      note: note || null,
      preview: true,
      executed: false,
      committedSandboxAccounting: false,
    }, null, 2));
  }
  if (session?.user.role !== 'ADMIN') return <State label="ACCESS / RESTRICTED" title="Institution access required."><p>Your role does not permit simulated programmable finance.</p></State>;
  if (!fresh) return <State label="AUTHORIZATION / 2FA EXPIRED" title="Verify your access again." action={<Link className="button" href="/login">Sign in with an authenticator ↗</Link>}><p>Simulated workflow records require authenticator verification within the last five minutes.</p></State>;
  return <>
    <PageHeading index="16" title="Simulated programmable finance" />
    <div className="page-intro"><p>Preview is not execution. Live rails are off. A workflow built here is a declaration. It does not post, and it is not legal escrow, custody, or a market quote.</p><span className="eyebrow">SIMULATED PROGRAM</span></div>
    {error && <ErrorNotice code={error}>The simulated program could not be read.</ErrorNotice>}
    {!board && !error && <p className="tiny">Reading simulated program records.</p>}
    {board && <>
      <section className="section">
        <div className="section-heading"><h2>Recorded workflows</h2><span className="eyebrow">{board.simulationOnly ? 'SIMULATION ONLY' : 'REVIEW'}</span></div>
        <p className="tiny">Workflows {board.workflows}. Completed {board.completed}. Unknown {board.unknown}. Escrows {board.escrows}. Assets {board.assets}. Open quotes {board.openQuotes}. Pledged {board.pledged}.</p>
        <p className="tiny">Legal escrow: {board.legalEscrow ? 'review' : 'no'}. Fiduciary custody: {board.fiduciaryCustody ? 'review' : 'no'}. Public exchange: {board.publicExchange ? 'review' : 'no'}. Live issuance: {board.liveIssuance ? 'review' : 'no'}. Distributed atomicity: {board.distributedAtomicity ? 'review' : 'no'}.</p>
        <p className="tiny">Recorded totals are not an independent verification. Preview is execution: {board.previewIsExecution ? 'review' : 'no'}.</p>
        {board.emptyMessage && <p className="tiny">{board.emptyMessage}</p>}
      </section>
      <section className="section">
        <div className="section-heading"><h2>Workflow declaration</h2></div>
        <p className="tiny">This form builds fh-workflow-1 JSON in the browser. It does not submit code, and it does not call the execution route.</p>
        <label>Maximum exposure<input value={exposure} onChange={event => setExposure(event.target.value)} autoComplete="off" /></label>
        <label>Note<input value={note} onChange={event => setNote(event.target.value)} autoComplete="off" /></label>
        <button type="button" onClick={buildDefinition}>Build definition</button>
        {buildError && <p className="tiny code">{buildError}</p>}
        {preview && <>
          <p className="tiny">This preview did not post.</p>
          <pre className="mono">{preview}</pre>
        </>}
      </section>
    </>}
  </>;
}

export default function ProgramPage() {
  return <Shell><Program /></Shell>;
}
