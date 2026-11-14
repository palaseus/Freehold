'use client';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { ErrorNotice, PageHeading, State } from '@/components/ui';
import { api, post } from '@/lib/api';

type Institution = { institutionId: string; code: string; legalName: string; status: string; liveAuthorized: boolean };
type InstitutionList = { institutions: Institution[]; simulationOnly: boolean };

function Platform() {
  const { session } = useSession();
  const fresh = !!session?.recentTwoFactorUntil && new Date(session.recentTwoFactorUntil).getTime() > Date.now();
  const [list, setList] = useState<InstitutionList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [legalName, setLegalName] = useState('');
  const load = useCallback(async () => {
    try {
      setList(await api<InstitutionList>('/v1/institution/institutions'));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'INSTITUTIONS_UNAVAILABLE');
    }
  }, []);
  useEffect(() => { if (session?.user.role === 'ADMIN' && fresh) void load(); }, [session, fresh, load]);
  async function openInstitution(event: FormEvent) {
    event.preventDefault();
    if (!session || busy) return;
    setBusy(true); setFormError(null);
    try {
      await post('/v1/institution/institutions', { code, legalName }, session.csrfToken);
      setCode('');
      setLegalName('');
      await load();
    } catch (reason) { setFormError(reason instanceof Error ? reason.message : 'INSTITUTION_UNCONFIRMED'); }
    finally { setBusy(false); }
  }
  if (session?.user.role !== 'ADMIN') return <State label="ACCESS / RESTRICTED" title="Institution access required."><p>Your role does not permit institutional tenant records.</p></State>;
  if (!fresh) return <State label="AUTHORIZATION / 2FA EXPIRED" title="Verify your access again." action={<Link className="button" href="/login">Sign in with an authenticator ↗</Link>}><p>Institutional tenant records require authenticator verification within the last five minutes.</p></State>;
  return <>
    <PageHeading index="14" title="Simulated institutional sandbox" />
    <div className="page-intro"><p>These tenants do not share accounts, customers, or ledger records. The sandbox does not authorize a bank, a custodian, or a payment stablecoin issuer. Live rails are off.</p><span className="eyebrow">SIMULATED SANDBOX</span></div>
    {error && <ErrorNotice code={error}>Institutional tenants could not be read.</ErrorNotice>}
    {list && <section className="section">
      <div className="section-heading"><h2>Tenants you belong to</h2><span className="eyebrow">{list.simulationOnly ? 'SIMULATION ONLY' : 'REVIEW'}</span></div>
      {!list.institutions.length ? <p className="tiny">No simulated institution is open for this administrator.</p> : list.institutions.map(institution => <article className="ledger-event" key={institution.institutionId}>
        <div className="ledger-event-main"><span className="mono">{institution.legalName}</span></div>
        <p className="ledger-caption">Code {institution.code}. Status {institution.status}. Live authorized: no.</p>
      </article>)}
    </section>}
    <section className="section">
      <div className="section-heading"><h2>Open a simulated tenant</h2></div>
      <form onSubmit={event => void openInstitution(event)}>
        <label>Tenant code<input value={code} onChange={event => setCode(event.target.value)} pattern="[a-z0-9-]{3,40}" required autoComplete="off" /></label>
        <label>Legal name<input value={legalName} onChange={event => setLegalName(event.target.value)} minLength={3} maxLength={160} required autoComplete="off" /></label>
        <button type="submit" disabled={busy}>Open simulated institution</button>
        {formError && <ErrorNotice code={formError}>The institution was not opened.</ErrorNotice>}
      </form>
      <p className="tiny">An administrator who is not a member cannot read another tenant. Opening a tenant records that administrator as a member of that tenant only.</p>
    </section>
  </>;
}

export default function PlatformPage() {
  return <Shell><Platform /></Shell>;
}
