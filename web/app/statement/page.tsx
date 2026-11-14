'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Shell } from '@/components/shell';
import { useBank } from '@/components/data';
import { Money, PageHeading, State } from '@/components/ui';
import { api } from '@/lib/api';

type StatementLine = { entryId: string; effectiveAt: string; operationId: string; kind: string; bucket: string; side: string; amountMinor: string; counterpartyAccountId: string | null };
type Statement = {
  accountId: string; currency: string; minorUnitExponent: number; from: string; to: string; generatedAt: string;
  openingAvailableMinor: string; closingAvailableMinor: string; openingReservedMinor: string; closingReservedMinor: string;
  lines: StatementLine[]; nextCursor: string | null;
};

function monthRange(month: string) {
  const [year, mon] = month.split('-').map(Number);
  const from = new Date(Date.UTC(year!, mon! - 1, 1)).toISOString();
  const to = new Date(Date.UTC(year!, mon!, 1)).toISOString();
  return { from, to };
}

function StatementView() {
  const { accounts, currencies, loading, error } = useBank();
  const [accountId, setAccountId] = useState('');
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [statement, setStatement] = useState<Statement | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const selected = accountId || accounts[0]?.id || '';
  const exponent = currencies.find(currency => currency.code === accounts.find(account => account.id === selected)?.currency)?.minorUnitExponent;
  async function read(nextCursor?: string | null) {
    if (!selected) return;
    const range = from && to ? { from: new Date(from).toISOString(), to: new Date(to).toISOString() } : monthRange(month);
    setReading(true); setReadError(null);
    try {
      const page = await api<Statement>(`/v1/accounts/${selected}/statement?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&limit=100${nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : ''}`);
      setStatement(previous => nextCursor && previous ? { ...page, lines: [...previous.lines, ...page.lines] } : page);
      setCursor(page.nextCursor);
    } catch (e) { setReadError(e instanceof Error ? e.message : 'STATEMENT_UNAVAILABLE'); }
    finally { setReading(false); }
  }
  const query = statement ? `from=${encodeURIComponent(statement.from)}&to=${encodeURIComponent(statement.to)}` : '';
  return <><PageHeading index="04" title="Account statement" /><div className="page-intro"><p>Opening and closing balances are taken from the ledger. This page does not change them.</p><span className="eyebrow">UTC WINDOW / MINOR UNITS IN THE FILE</span></div>
    {loading ? <State label="ACCOUNTS / READING" title="Locating your accounts." /> : error ? <State label="ACCOUNTS / ERROR" title="The account list is unavailable."><p className="code">{error}</p></State> : !selected ? <State label="STATEMENT / EMPTY" title="No accounts yet." action={<Link className="button" href="/">Open a currency account ↗</Link>} /> : <><div className="filter-row"><label htmlFor="statement-account" className="eyebrow">ACCOUNT</label><select id="statement-account" value={selected} onChange={e => { setAccountId(e.target.value); setStatement(null); setCursor(null); }}>{accounts.map(account => <option value={account.id} key={account.id}>{account.currency} · {account.id.slice(0, 8)}</option>)}</select><label htmlFor="statement-month" className="eyebrow">MONTH</label><input id="statement-month" type="month" value={month} onChange={e => setMonth(e.target.value)} /><label htmlFor="statement-from" className="eyebrow">FROM</label><input id="statement-from" type="date" value={from} onChange={e => setFrom(e.target.value)} /><label htmlFor="statement-to" className="eyebrow">TO</label><input id="statement-to" type="date" value={to} onChange={e => setTo(e.target.value)} /><button onClick={() => void read(null)} disabled={reading}>{reading ? 'Reading…' : 'Read statement ↗'}</button></div>
      {readError && <State label="STATEMENT / ERROR" title="The statement could not be read."><p className="code">{readError}</p></State>}
      {statement && <section className="ledger-watch"><div className="section-heading"><div><span className="eyebrow">{statement.currency} / EXPONENT {statement.minorUnitExponent ?? exponent ?? 'UNKNOWN'}</span><h2>Statement</h2></div><div className="transfer-actions"><a className="button secondary" href={`/api/v1/accounts/${selected}/statement.csv?${query}`}>CSV</a><a className="button secondary" href={`/api/v1/accounts/${selected}/statement.pdf?${query}`}>PDF</a></div></div>
        <p className="tiny mono">ACCOUNT {statement.accountId}</p>
        <p className="tiny mono">WINDOW {statement.from} TO {statement.to} EXCLUSIVE</p>
        <p className="tiny mono">GENERATED {statement.generatedAt}</p>
        <p className="ledger-watch-line">Opening available <Money amount={statement.openingAvailableMinor} currency={statement.currency} /></p>
        <p className="ledger-watch-line">Closing available <Money amount={statement.closingAvailableMinor} currency={statement.currency} /></p>
        <p className="tiny">Reserved opening <Money amount={statement.openingReservedMinor} currency={statement.currency} /> / closing <Money amount={statement.closingReservedMinor} currency={statement.currency} /></p>
        {!statement.lines.length ? <p className="tiny">No entries in this window.</p> : <div className="ledger-events">{statement.lines.map(line => <article className="ledger-event" key={line.entryId}><div className="ledger-event-main"><span className="mono">{line.kind} / {line.side} / {line.bucket}</span><Money amount={line.side === 'DEBIT' ? `-${line.amountMinor}` : line.amountMinor} currency={statement.currency} /></div><time className="tiny mono">{line.effectiveAt}</time><div className="tiny mono ledger-event-ref">OPERATION {line.operationId}{line.counterpartyAccountId ? ` / COUNTERPARTY ${line.counterpartyAccountId}` : ''}</div></article>)}</div>}
        {cursor && <button className="secondary" disabled={reading} onClick={() => void read(cursor)}>Older entries ↗</button>}
      </section>}
    </>}</>;
}
export default function Page() { return <Shell><StatementView /></Shell>; }
