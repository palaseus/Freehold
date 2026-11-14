'use client';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useSession } from './session';
import { ErrorNotice } from './ui';
import { api, post } from '@/lib/api';

type Flag = { id: string; ruleCode: string; severity: string; accountId: string | null; status: string; createdAt: string };
type Policy = { id: string; scope: string; ruleCode: string; currencyCode: string | null; thresholdMinor: string | null; enabled: boolean };
type CaseRow = { caseId: string; summary: string; severity: string; status: string; assignedReviewerId: string | null; subjectAccountId: string | null; updatedAt: string };

export function RiskBoard() {
  const { session } = useSession();
  const [flags, setFlags] = useState<Flag[] | null>(null);
  const [policies, setPolicies] = useState<Policy[] | null>(null);
  const [cases, setCases] = useState<CaseRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const [severity, setSeverity] = useState<'LOW' | 'MEDIUM' | 'HIGH'>('MEDIUM');
  const [subjectAccountId, setSubjectAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      api<Flag[]>('/v1/admin/risk/flags?limit=30'),
      api<Policy[]>('/v1/admin/risk/policies'),
      api<CaseRow[]>('/v1/admin/compliance/cases?limit=30'),
    ]);
    const messages: string[] = [];
    if (results[0].status === 'fulfilled') setFlags(results[0].value); else { setFlags(null); messages.push(`FLAGS ${results[0].reason instanceof Error ? results[0].reason.message : 'UNAVAILABLE'}`); }
    if (results[1].status === 'fulfilled') setPolicies(results[1].value); else { setPolicies(null); messages.push(`POLICIES ${results[1].reason instanceof Error ? results[1].reason.message : 'UNAVAILABLE'}`); }
    if (results[2].status === 'fulfilled') setCases(results[2].value); else { setCases(null); messages.push(`CASES ${results[2].reason instanceof Error ? results[2].reason.message : 'UNAVAILABLE'}`); }
    setError(messages.length ? messages.join(' · ') : null);
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function openCase(event: FormEvent) {
    event.preventDefault();
    if (!summary.trim() || busy) return;
    setBusy(true); setActionError(null);
    try {
      await post('/v1/admin/compliance/cases', { summary: summary.trim(), severity, ...(subjectAccountId ? { subjectAccountId } : {}) }, session!.csrfToken);
      setSummary(''); setSubjectAccountId(''); await load();
    } catch (e) { setActionError(e instanceof Error ? e.message : 'CASE_UNCONFIRMED'); }
    finally { setBusy(false); }
  }
  return <section className="ledger-watch"><div className="section-heading"><div><span className="eyebrow">RISK AND COMPLIANCE</span><h2>Flags, policies, and cases</h2></div><button className="text-button tiny" onClick={() => void load()}>Read again ↗</button></div>
    {error && <p className="ledger-watch-line mono">PARTIAL / {error}</p>}
    <h3 className="eyebrow">OPEN RISK FLAGS</h3>
    {flags === null && !error ? <p className="tiny">Reading flags.</p> : flags === null ? <p className="tiny">Risk flags are unavailable for this session.</p> : !flags.length ? <p className="tiny">No risk flags recorded.</p> : <div className="ledger-events">{flags.map(flag => <article className="ledger-event" key={flag.id}><div className="ledger-event-main"><span className="mono">{flag.ruleCode} / {flag.severity} / {flag.status}</span><time className="tiny mono">{new Date(flag.createdAt).toLocaleString()}</time></div><p className="tiny mono">{flag.accountId ?? 'NO ACCOUNT'}</p></article>)}</div>}
    <h3 className="eyebrow">RISK POLICIES</h3>
    {policies === null ? <p className="tiny">Risk policies are unavailable for this session.</p> : !policies.length ? <p className="tiny">No risk policies recorded.</p> : <div className="ledger-events">{policies.map(policy => <article className="ledger-event" key={policy.id}><div className="ledger-event-main"><span className="mono">{policy.scope} / {policy.ruleCode} / {policy.enabled ? 'ENABLED' : 'DISABLED'}</span><span className="tiny mono">{policy.currencyCode ?? 'ALL CURRENCIES'}</span></div><p className="tiny">Threshold minor {policy.thresholdMinor ?? 'NONE'}. Institutional policy changes stay on the dual-control queue.</p></article>)}</div>}
    <h3 className="eyebrow">COMPLIANCE CASES</h3>
    {cases === null ? <p className="tiny">Compliance cases are unavailable for this session.</p> : !cases.length ? <p className="tiny">No compliance cases recorded.</p> : <div className="ledger-events">{cases.map(row => <article className="ledger-event" key={row.caseId}><div className="ledger-event-main"><span className="mono">{row.status} / {row.severity}</span><time className="tiny mono">{new Date(row.updatedAt).toLocaleString()}</time></div><p className="tiny">{row.summary}</p><p className="tiny mono">ASSIGNED {row.assignedReviewerId ?? 'UNASSIGNED'} / ACCOUNT {row.subjectAccountId ?? 'NONE'}</p><CaseActions id={row.caseId} onChanged={load} /></article>)}</div>}
    <form onSubmit={openCase}><div className="form-section-number">OPEN A CASE</div><label htmlFor="case-summary">Summary</label><textarea id="case-summary" required maxLength={2000} value={summary} onChange={e => setSummary(e.target.value)} /><label htmlFor="case-severity">Severity</label><select id="case-severity" value={severity} onChange={e => setSeverity(e.target.value as 'LOW' | 'MEDIUM' | 'HIGH')}><option>LOW</option><option>MEDIUM</option><option>HIGH</option></select><label htmlFor="case-account">Subject account ID</label><input id="case-account" required value={subjectAccountId} onChange={e => setSubjectAccountId(e.target.value)} placeholder="Account UUID" />{actionError && <ErrorNotice code={actionError}>The case was not confirmed.</ErrorNotice>}<button className="secondary" disabled={busy || !summary.trim() || !subjectAccountId.trim()}>{busy ? 'Saving…' : 'Open case ↗'}</button></form>
  </section>;
}

function CaseActions({ id, onChanged }: { id: string; onChanged: () => Promise<void> }) {
  const { session } = useSession();
  const [reviewerId, setReviewerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function transition(status: string) {
    setBusy(true); setError(null);
    try { await post(`/v1/admin/compliance/cases/${id}/transition`, { status, ...(reviewerId ? { reviewerId } : {}) }, session!.csrfToken); await onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'TRANSITION_UNCONFIRMED'); }
    finally { setBusy(false); }
  }
  return <div>{error && <p className="tiny code">{error}</p>}<label htmlFor={`reviewer-${id}`}>Assign reviewer</label><input id={`reviewer-${id}`} value={reviewerId} onChange={e => setReviewerId(e.target.value)} placeholder="Reviewer user UUID" /><div className="transfer-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void transition('UNDER_REVIEW')}>Under review</button><button type="button" className="secondary" disabled={busy} onClick={() => void transition('ESCALATED')}>Escalate</button><button type="button" className="secondary" disabled={busy} onClick={() => void transition('RESOLVED')}>Resolve</button></div></div>;
}
