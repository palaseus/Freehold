'use client';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { useBank } from '@/components/data';
import { useSession } from '@/components/session';
import { ErrorNotice, Money, PageHeading, State } from '@/components/ui';
import { api, post } from '@/lib/api';

type Execution = { scheduledFor: string; outcome: string; errorCode: string | null; operationId: string | null; recordedAt: string };
type Instruction = {
  instructionId: string; status: string; cadence: string; timezone: string; currency: string; amountMinor: string;
  sourceAccountId: string; destinationAccountId: string; nextExecutionAt: string; lastStatus: string | null; lastError: string | null;
  attemptCount: number; executions: Execution[];
};

function defaultWhen() {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

function Schedule() {
  const { accounts, loading, error, refresh } = useBank();
  const { session } = useSession();
  const [items, setItems] = useState<Instruction[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [cadence, setCadence] = useState<'ONCE' | 'DAILY' | 'WEEKLY' | 'MONTHLY'>('ONCE');
  const [when, setWhen] = useState(defaultWhen);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const account = accounts.find(item => item.id === source) ?? accounts[0];
  const load = useCallback(async () => {
    try { setItems(await api<Instruction[]>('/v1/scheduled-transfers')); setListError(null); }
    catch (e) { setListError(e instanceof Error ? e.message : 'SCHEDULE_UNAVAILABLE'); }
  }, []);
  useEffect(() => { setKey(crypto.randomUUID()); void load(); }, [load]);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!account || busy) return;
    if (!/^[1-9][0-9]{0,18}$/.test(amount)) { setNotice('INVALID_AMOUNT'); return; }
    const next = new Date(when);
    if (Number.isNaN(next.getTime())) { setNotice('INVALID_SCHEDULE — use a UTC ISO-8601 timestamp.'); return; }
    setBusy(true); setNotice(null);
    try {
      await post('/v1/scheduled-transfers', {
        sourceAccountId: account.id, destinationAccountId: destination, currency: account.currency, amountMinor: amount, cadence, nextExecutionAt: next.toISOString(),
      }, session!.csrfToken, key);
      setKey(crypto.randomUUID()); setAmount(''); await load(); await refresh();
    } catch (e) { setNotice(e instanceof Error ? e.message : 'SCHEDULE_UNCONFIRMED'); }
    finally { setBusy(false); }
  }
  async function cancel(id: string) {
    setBusy(true); setNotice(null);
    try { await post(`/v1/scheduled-transfers/${id}/cancel`, {}, session!.csrfToken); await load(); }
    catch (e) { setNotice(e instanceof Error ? e.message : 'CANCEL_UNCONFIRMED'); }
    finally { setBusy(false); }
  }
  return <><PageHeading index="05" title="Scheduled transfers" />
    <div className="page-intro"><p>Internal same-currency instructions. Execution uses the ledger posting function. Nothing is reserved until a transfer is posted. Times are UTC.</p><span className="eyebrow">NO STANDING RESERVE</span></div>
    {loading ? <State label="ACCOUNTS / READING" title="Reading your accounts." /> : error && !accounts.length ? <State label="ACCOUNTS / ERROR" title="Accounts are unavailable."><p className="code">{error}</p></State> : !accounts.length ? <State label="ACCOUNTS / EMPTY" title="Open an account before scheduling." /> : <>
      <form className="transfer-form" onSubmit={create}>
        <div className="form-section-number">01 / SOURCE</div>
        <label htmlFor="sched-source">Source account</label>
        <select id="sched-source" value={account.id} onChange={e => setSource(e.target.value)}>{accounts.map(item => <option key={item.id} value={item.id}>{item.currency} · {item.id}</option>)}</select>
        <div className="form-section-number">02 / DESTINATION</div>
        <label htmlFor="sched-dest">Destination account ID</label>
        <input id="sched-dest" required value={destination} onChange={e => setDestination(e.target.value)} placeholder="Account UUID" />
        <div className="form-section-number">03 / AMOUNT AND CADENCE</div>
        <label htmlFor="sched-amount">Amount in minor units</label>
        <input id="sched-amount" required inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value)} />
        <label htmlFor="sched-cadence">Cadence</label>
        <select id="sched-cadence" value={cadence} onChange={e => setCadence(e.target.value as typeof cadence)}><option value="ONCE">Once</option><option value="DAILY">Daily, UTC</option><option value="WEEKLY">Weekly, UTC</option><option value="MONTHLY">Monthly, UTC calendar month</option></select>
        <label htmlFor="sched-when">Next execution, UTC ISO-8601</label>
        <input id="sched-when" required value={when} onChange={e => setWhen(e.target.value)} />
        <p className="field-help">Must be more than 30 seconds ahead. Monthly dates use PostgreSQL UTC month arithmetic. A missed window runs once after recovery and does not burst-catch-up. Step-up cannot be completed by the scheduler and fails closed.</p>
        <p className="tiny mono">REQUEST KEY / {key || 'PREPARING'}</p>
        {notice && <ErrorNotice code={notice}>Retry keeps this request key.</ErrorNotice>}
        <button className="transfer-submit" disabled={busy || !destination || !amount}>{busy ? 'Saving…' : 'Schedule transfer ↗'}</button>
      </form>
      <section className="section"><div className="section-heading"><h2>Instructions</h2><button className="text-button tiny" onClick={() => void load()}>Read again ↗</button></div>
        {listError ? <State label="SCHEDULE / ERROR" title="Instructions are unavailable." action={<button onClick={() => void load()}>Read again</button>}><p className="code">{listError}</p></State> : items === null ? <p className="tiny">Reading instructions.</p> : !items.length ? <p className="tiny">No scheduled transfers.</p> : <div className="ledger-events">{items.map(item => <article className="ledger-event" key={item.instructionId}><div className="ledger-event-main"><span className="mono">{item.cadence} / {item.status} / {item.timezone}</span><Money amount={item.amountMinor} currency={item.currency} /></div><p className="tiny mono">NEXT {item.nextExecutionAt} / ATTEMPTS {item.attemptCount}{item.lastError ? ` / LAST ${item.lastStatus} ${item.lastError}` : ''}</p><p className="tiny mono">{item.sourceAccountId} → {item.destinationAccountId}</p>{item.executions?.length ? <p className="tiny">History: {item.executions.map(row => `${row.scheduledFor} ${row.outcome}${row.errorCode ? ` ${row.errorCode}` : ''}`).join(' · ')}</p> : <p className="tiny">No executions recorded.</p>}{item.status === 'ACTIVE' && <button className="secondary" disabled={busy} onClick={() => void cancel(item.instructionId)}>Cancel before execution ↗</button>}</article>)}</div>}
      </section>
    </>}
  </>;
}

export default function Page() { return <Shell><Schedule /></Shell>; }
