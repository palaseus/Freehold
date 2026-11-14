'use client';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { ErrorNotice, PageHeading, State } from '@/components/ui';
import { api, post } from '@/lib/api';

type Check = { item: string; state: string };
type Partner = {
  partnerId: string; legalName: string; entityKind: string; charterStatus: string; relationshipStatus: string;
  settlementCapability: string; custodyCapability: string; integrationStatus: string; externalEvidence: string;
  agreementExpiresOn: string | null; complianceResponsibility: string; escalationContact: string; checks: Check[];
};
type PartnerList = { partners: Partner[] };

const kinds = ['PROSPECTIVE_BANK', 'PROSPECTIVE_CUSTODIAN', 'PROSPECTIVE_ISSUER'] as const;
const items = ['IDENTITY', 'LICENSE_OR_CHARTER', 'SERVICE_AGREEMENT', 'DUE_DILIGENCE', 'PRODUCTS', 'SETTLEMENT', 'CUSTODY', 'CONTACTS', 'COMPLIANCE', 'EXPIRATION', 'ESCALATION', 'INTEGRATION'] as const;

function checkLabel(state: string) {
  if (state === 'OPEN') return 'Open';
  if (state === 'RECORDED_NOT_VERIFIED') return 'Recorded, not confirmed';
  return 'Recorded';
}

function Partners() {
  const { session } = useSession();
  const fresh = !!session?.recentTwoFactorUntil && new Date(session.recentTwoFactorUntil).getTime() > Date.now();
  const [list, setList] = useState<PartnerList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [legalName, setLegalName] = useState('');
  const [entityKind, setEntityKind] = useState<(typeof kinds)[number]>('PROSPECTIVE_BANK');
  const [checkItem, setCheckItem] = useState<(typeof items)[number]>('IDENTITY');
  const load = useCallback(async () => {
    try {
      setList(await api<PartnerList>('/v1/monetary/partners'));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'PARTNERS_UNAVAILABLE');
    }
  }, []);
  useEffect(() => { if (session?.user.role === 'ADMIN' && fresh) void load(); }, [session, fresh, load]);
  async function openPartner(event: FormEvent) {
    event.preventDefault();
    if (!session || busy) return;
    setBusy(true); setFormError(null);
    try {
      await post('/v1/monetary/partners', { legalName, entityKind }, session.csrfToken);
      setLegalName('');
      await load();
    } catch (reason) { setFormError(reason instanceof Error ? reason.message : 'PARTNER_UNCONFIRMED'); }
    finally { setBusy(false); }
  }
  async function recordCheck(partnerId: string) {
    if (!session || busy) return;
    setBusy(true); setFormError(null);
    try {
      await post(`/v1/monetary/partners/${partnerId}/checks`, { item: checkItem }, session.csrfToken);
      await load();
    } catch (reason) { setFormError(reason instanceof Error ? reason.message : 'CHECK_UNCONFIRMED'); }
    finally { setBusy(false); }
  }
  if (session?.user.role !== 'ADMIN') return <State label="ACCESS / RESTRICTED" title="Institution access required."><p>Your role does not permit prospective partner records.</p></State>;
  if (!fresh) return <State label="AUTHORIZATION / 2FA EXPIRED" title="Verify your access again." action={<Link className="button" href="/login">Sign in with an authenticator ↗</Link>}><p>Prospective partner records require authenticator verification within the last five minutes.</p></State>;
  return <>
    <PageHeading index="12" title="Prospective partners" />
    <div className="page-intro"><p>No banking partner is approved. A checklist entry is not a charter, a service agreement, or external evidence. Relationship status stays not confirmed.</p><span className="eyebrow">NOT CONFIRMED</span></div>
    {error && <ErrorNotice code={error}>Prospective partners could not be read.</ErrorNotice>}
    {list && <section className="section">
      <div className="section-heading"><h2>Records</h2></div>
      {!list.partners.length ? <p className="tiny">No prospective partner is recorded.</p> : list.partners.map(partner => <article className="ledger-event" key={partner.partnerId}>
        <div className="ledger-event-main"><span className="mono">{partner.legalName}</span></div>
        <p className="ledger-caption">{partner.entityKind}. Relationship: not confirmed. Charter: not confirmed. External evidence: unavailable.</p>
        <p className="tiny">Settlement {partner.settlementCapability}. Custody {partner.custodyCapability}. Integration {partner.integrationStatus}. Agreement expiration {partner.agreementExpiresOn ?? 'not recorded'}.</p>
        <p className="tiny">Compliance responsibility: {partner.complianceResponsibility} Escalation: {partner.escalationContact}</p>
        {partner.checks.map(check => <p className="tiny" key={check.item}>{check.item}: {checkLabel(check.state)}.</p>)}
        <button type="button" disabled={busy} onClick={() => void recordCheck(partner.partnerId)}>Record {checkItem} for this partner</button>
      </article>)}
    </section>}
    <section className="section">
      <div className="section-heading"><h2>Open a prospective record</h2></div>
      <form className="transfer-layout" onSubmit={openPartner}>
        <label htmlFor="legal-name">Legal name</label>
        <input id="legal-name" value={legalName} onChange={event => setLegalName(event.target.value)} minLength={3} maxLength={160} required />
        <label htmlFor="entity-kind">Entity kind</label>
        <select id="entity-kind" value={entityKind} onChange={event => setEntityKind(event.target.value as (typeof kinds)[number])}>
          {kinds.map(kind => <option key={kind} value={kind}>{kind}</option>)}
        </select>
        <label htmlFor="check-item">Checklist item to record</label>
        <select id="check-item" value={checkItem} onChange={event => setCheckItem(event.target.value as (typeof items)[number])}>
          {items.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
        <button type="submit" disabled={busy}>{busy ? 'Recording…' : 'Record a prospective partner'}</button>
      </form>
      <p className="tiny">Recording a checklist item does not confirm the relationship.</p>
      {formError && <ErrorNotice code={formError}>The prospective record was not changed.</ErrorNotice>}
    </section>
  </>;
}

export default function Page() { return <Shell><Partners /></Shell>; }
