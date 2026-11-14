'use client';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useSession } from '@/components/session';
import { ErrorNotice } from '@/components/ui';
import { api, post } from '@/lib/api';

type Alert = { id: string; alertKey: string; severity: string; source: string; description: string; state: string; details?: { telemetry?: string } };
type Incident = { incidentId: string; classification: string; severity: string; status: string; title: string; summary?: string; containment?: string | null; resolution?: string | null };

export function Incidents() {
  const { session } = useSession();
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [severity, setSeverity] = useState<'INFORMATIONAL' | 'WARNING' | 'HIGH' | 'CRITICAL'>('HIGH');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [nextAlerts, nextIncidents] = await Promise.all([
        api<Alert[]>('/v1/admin/monitor/alerts'),
        api<Incident[]>('/v1/admin/incidents'),
      ]);
      setAlerts(nextAlerts);
      setIncidents(nextIncidents);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'INCIDENTS_UNAVAILABLE'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function evaluate() {
    if (!session || busy) return;
    setBusy(true); setError(null);
    try { await post('/v1/admin/monitor/evaluate', {}, session.csrfToken); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'MONITOR_UNCONFIRMED'); }
    finally { setBusy(false); }
  }
  async function open(event: FormEvent) {
    event.preventDefault();
    if (!session || busy) return;
    setBusy(true); setError(null);
    try {
      await post('/v1/admin/incidents', { severity, title, summary }, session.csrfToken);
      setTitle(''); setSummary(''); await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'INCIDENT_UNCONFIRMED'); }
    finally { setBusy(false); }
  }
  async function act(id: string, action: 'NOTE' | 'CONTAIN' | 'RESOLVE' | 'CLOSE') {
    if (!session || busy || !note.trim()) return;
    setBusy(true); setError(null);
    try { await post(`/v1/admin/incidents/${id}/actions`, { action, body: note }, session.csrfToken); setNote(''); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'INCIDENT_ACTION_UNCONFIRMED'); }
    finally { setBusy(false); }
  }

  const current = incidents?.[0] ?? null;
  return <section className="ledger-watch"><div className="section-heading"><div><span className="eyebrow">OPERATIONS / INCIDENTS</span><h2>Operational incidents</h2></div><button className="text-button tiny" onClick={() => void load()}>Read again ↗</button></div>
    <p className="tiny">An operational incident records a service or reconciliation problem. It is not a compliance case and it does not change a ledger balance.</p>
    {error && <ErrorNotice code={error}>The monitor did not edit financial records.</ErrorNotice>}
    <button className="secondary" disabled={busy} onClick={() => void evaluate()}>{busy ? 'Working…' : 'Evaluate monitor ↗'}</button>
    {alerts === null ? <p className="tiny">Reading alerts.</p> : !alerts.length ? <p className="tiny">No alerts recorded. An empty list is not proof that telemetry is healthy.</p> : <div className="ledger-events">{alerts.map(alert => <article className="ledger-event" key={alert.id}><div className="ledger-event-main"><span className="mono">{alert.severity} / {alert.state} / {alert.alertKey}</span><span className="tiny">{alert.details?.telemetry ?? 'TELEMETRY UNSPECIFIED'}</span></div><p className="tiny">{alert.description}</p></article>)}</div>}
    <form className="transfer-form" onSubmit={open}>
      <label htmlFor="incident-severity">Severity</label>
      <select id="incident-severity" value={severity} onChange={e => setSeverity(e.target.value as typeof severity)}><option>INFORMATIONAL</option><option>WARNING</option><option>HIGH</option><option>CRITICAL</option></select>
      <label htmlFor="incident-title">Incident title</label>
      <input id="incident-title" required value={title} onChange={e => setTitle(e.target.value)} />
      <label htmlFor="incident-summary">Incident summary</label>
      <textarea id="incident-summary" required value={summary} onChange={e => setSummary(e.target.value)} />
      <button disabled={busy || !title.trim() || !summary.trim()}>Open incident ↗</button>
    </form>
    {incidents === null ? <p className="tiny">Reading incidents.</p> : !current ? <p className="tiny">No operational incidents recorded.</p> : <article className="ledger-event"><div className="ledger-event-main"><span className="mono">{current.classification} / {current.status} / {current.severity}</span></div><h3>{current.title}</h3>{current.summary && <p className="tiny">{current.summary}</p>}<label htmlFor="incident-note">Investigation note</label><textarea id="incident-note" value={note} onChange={e => setNote(e.target.value)} /><div className="transfer-actions"><button className="secondary" disabled={busy || !note.trim()} onClick={() => void act(current.incidentId, 'NOTE')}>Add note ↗</button><button className="secondary" disabled={busy || !note.trim()} onClick={() => void act(current.incidentId, 'CONTAIN')}>Record containment ↗</button><button className="secondary" disabled={busy || !note.trim()} onClick={() => void act(current.incidentId, 'RESOLVE')}>Resolve ↗</button><button className="secondary" disabled={busy || !note.trim() || current.status !== 'RESOLVED'} onClick={() => void act(current.incidentId, 'CLOSE')}>Close ↗</button></div></article>}
  </section>;
}
