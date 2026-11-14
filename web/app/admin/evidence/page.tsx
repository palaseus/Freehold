'use client';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { ErrorNotice, PageHeading, State } from '@/components/ui';
import { api, post } from '@/lib/api';

type Review = { reviewId: string; recordedAt: string };
type Item = {
  evidenceId: string; controlId: string; citation: string; sourceTitle: string; technicalControl: string;
  testRef: string; responsibleRole: string; technicalStatus: string; legalStatus: string;
  certificationStatus: string; regulatoryStatus: string; expiresAt: string | null; deficiency: string;
  reviews: Review[];
};
type ExportPackage = { determination: string; items: Item[] };

function EvidenceRoom() {
  const { session } = useSession();
  const fresh = !!session?.recentTwoFactorUntil && new Date(session.recentTwoFactorUntil).getTime() > Date.now();
  const [pack, setPack] = useState<ExportPackage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [controlId, setControlId] = useState('');
  const [citation, setCitation] = useState('');
  const [sourceTitle, setSourceTitle] = useState('');
  const [technicalControl, setTechnicalControl] = useState('');
  const [testRef, setTestRef] = useState('');
  const [responsibleRole, setResponsibleRole] = useState('');
  const [deficiency, setDeficiency] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [noteId, setNoteId] = useState('');
  const [note, setNote] = useState('');
  const load = useCallback(async () => {
    try {
      setPack(await api<ExportPackage>('/v1/monetary/evidence'));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'EVIDENCE_UNAVAILABLE');
    }
  }, []);
  useEffect(() => { if (session?.user.role === 'ADMIN' && fresh) void load(); }, [session, fresh, load]);
  async function openEvidence(event: FormEvent) {
    event.preventDefault();
    if (!session || busy) return;
    setBusy(true); setFormError(null);
    try {
      await post('/v1/monetary/evidence', {
        controlId, citation, sourceTitle, technicalControl, testRef, responsibleRole, deficiency,
        ...(expiresOn ? { expiresOn } : {}),
      }, session.csrfToken);
      setControlId(''); setCitation(''); setSourceTitle(''); setTechnicalControl(''); setTestRef(''); setResponsibleRole(''); setDeficiency(''); setExpiresOn('');
      await load();
    } catch (reason) { setFormError(reason instanceof Error ? reason.message : 'EVIDENCE_UNCONFIRMED'); }
    finally { setBusy(false); }
  }
  async function addNote(event: FormEvent) {
    event.preventDefault();
    if (!session || busy || !noteId) return;
    setBusy(true); setNoteError(null);
    try {
      await post(`/v1/monetary/evidence/${noteId}/notes`, { note }, session.csrfToken);
      setNote('');
      await load();
    } catch (reason) { setNoteError(reason instanceof Error ? reason.message : 'NOTE_UNCONFIRMED'); }
    finally { setBusy(false); }
  }
  if (session?.user.role !== 'ADMIN') return <State label="ACCESS / RESTRICTED" title="Institution access required."><p>Your role does not permit the evidence room.</p></State>;
  if (!fresh) return <State label="AUTHORIZATION / 2FA EXPIRED" title="Verify your access again." action={<Link className="button" href="/login">Sign in with an authenticator ↗</Link>}><p>The evidence room requires authenticator verification within the last five minutes.</p></State>;
  return <>
    <PageHeading index="11" title="Evidence room" />
    <div className="page-intro"><p>Technical verification, legal review, external certification, and regulatory approval stay separate. This room does not produce a compliance determination.</p><span className="eyebrow">NOT A DETERMINATION</span></div>
    {error && <ErrorNotice code={error}>The evidence package could not be read.</ErrorNotice>}
    {pack && <section className="section">
      <div className="section-heading"><h2>Exportable package</h2></div>
      <p className="ledger-caption">Determination: {pack.determination}.</p>
      {!pack.items.length ? <p className="tiny">No control record is stored.</p> : pack.items.map(item => <article className="ledger-event" key={item.evidenceId}>
        <div className="ledger-event-main"><span className="mono">{item.controlId}</span></div>
        <p className="tiny mono">Record {item.evidenceId}</p>
        <p className="tiny">Citation {item.citation}. Source {item.sourceTitle}.</p>
        <p className="tiny">Technical control {item.technicalControl}. Test {item.testRef}. Role {item.responsibleRole}.</p>
        <p className="ledger-caption">Technical {item.technicalStatus}. Legal {item.legalStatus}. Certification {item.certificationStatus}. Regulatory {item.regulatoryStatus}.</p>
        <p className="tiny">Expires {item.expiresAt ?? 'not recorded'}. Deficiency {item.deficiency || 'none recorded'}. Reviews {item.reviews.length}. Opening a record does not change these statuses.</p>
      </article>)}
    </section>}
    <section className="section">
      <div className="section-heading"><h2>Open a control record</h2></div>
      <form className="transfer-layout" onSubmit={openEvidence}>
        <label htmlFor="control-id">Control identifier</label>
        <input id="control-id" value={controlId} onChange={event => setControlId(event.target.value)} maxLength={80} required />
        <label htmlFor="citation">Regulatory citation</label>
        <input id="citation" value={citation} onChange={event => setCitation(event.target.value)} maxLength={300} required />
        <label htmlFor="source-title">Source document</label>
        <input id="source-title" value={sourceTitle} onChange={event => setSourceTitle(event.target.value)} maxLength={300} required />
        <label htmlFor="technical-control">Technical control</label>
        <input id="technical-control" value={technicalControl} onChange={event => setTechnicalControl(event.target.value)} maxLength={500} required />
        <label htmlFor="test-ref">Linked test</label>
        <input id="test-ref" value={testRef} onChange={event => setTestRef(event.target.value)} maxLength={200} required />
        <label htmlFor="responsible-role">Responsible role</label>
        <input id="responsible-role" value={responsibleRole} onChange={event => setResponsibleRole(event.target.value)} maxLength={80} required />
        <label htmlFor="deficiency">Deficiency</label>
        <input id="deficiency" value={deficiency} onChange={event => setDeficiency(event.target.value)} maxLength={500} />
        <label htmlFor="expires-on">Evidence expiration</label>
        <input id="expires-on" value={expiresOn} onChange={event => setExpiresOn(event.target.value)} placeholder="YYYY-MM-DD" pattern="\d{4}-\d{2}-\d{2}" />
        <button type="submit" disabled={busy}>{busy ? 'Recording…' : 'Open control record'}</button>
      </form>
      {formError && <ErrorNotice code={formError}>The control record was not opened.</ErrorNotice>}
    </section>
    <section className="section">
      <div className="section-heading"><h2>Review note</h2></div>
      <p className="ledger-caption">The person who opened a record cannot note it. A note does not change technical, legal, certification, or regulatory status.</p>
      <form className="transfer-layout" onSubmit={addNote}>
        <label htmlFor="note-id">Evidence identifier</label>
        <input id="note-id" value={noteId} onChange={event => setNoteId(event.target.value)} required />
        <label htmlFor="review-note">Note</label>
        <input id="review-note" value={note} onChange={event => setNote(event.target.value)} maxLength={500} required />
        <button type="submit" disabled={busy}>{busy ? 'Recording…' : 'Record review note'}</button>
      </form>
      {noteError && <ErrorNotice code={noteError}>The review note was not recorded.</ErrorNotice>}
    </section>
  </>;
}

export default function Page() { return <Shell><EvidenceRoom /></Shell>; }
