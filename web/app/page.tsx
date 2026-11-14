'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Shell } from '@/components/shell';
import { useBank } from '@/components/data';
import { useSession } from '@/components/session';
import { ErrorNotice, Money, PageHeading, State } from '@/components/ui';
import { History } from '@/components/history';
import { copyText } from '@/lib/clipboard';
import { post } from '@/lib/api';
function Overview() {
  const { accounts, currencies, loading, error, refresh } = useBank(); const { session } = useSession();
  const [selectedCurrency, setSelectedCurrency] = useState(''); const [creating, setCreating] = useState(false); const [createError, setCreateError] = useState<string | null>(null);
  const [createKey, setCreateKey] = useState<string | null>(null);
  const first = accounts.find(a => a.currency === 'USD') ?? accounts[0];
  const available = currencies.filter(c => c.enabled && !accounts.some(a => a.currency === c.code));
  async function create() {
    const currency = selectedCurrency || available[0]?.code; if (!currency || creating) return;
    const key = createKey ?? crypto.randomUUID(); setCreateKey(key); setCreating(true); setCreateError(null);
    try { await post('/v1/accounts', { currency }, session!.csrfToken, key); setCreateKey(null); setSelectedCurrency(''); await refresh(); }
    catch (e) { setCreateError(e instanceof Error ? e.message : 'ACCOUNT_CREATION_UNCONFIRMED'); }
    finally { setCreating(false); }
  }
  return <><PageHeading index="01" title="Account overview"><Link className="button" href="/transfer">Make a transfer <span>↗</span></Link></PageHeading>
    {loading ? <State label="BALANCES / READING" title="Reading your accounts."><p>Balances are requested directly from the institution.</p></State> : error && !accounts.length ? <State label="BALANCES / ERROR" title="Balances are unavailable." action={<button onClick={() => void refresh()}>Read again</button>}><p className="code">{error}</p></State> : <>
      {first ? <section className="balance-hero"><div><div className="eyebrow">AVAILABLE TO MOVE <span className="hero-currency">{first.currency}</span></div><div className="hero-amount"><Money amount={first.availableMinor} currency={first.currency} /><span>{first.currency}</span></div><div className="hero-account"><span className="tiny mono">ACCOUNT / {first.id.slice(0, 8).toUpperCase()}</span><span className="status">{first.status}</span></div></div><div className="reserved-block"><span className="eyebrow">RESERVED</span><p><Money amount={first.reservedMinor} currency={first.currency} /> <span className="tiny">{first.currency}</span></p><p className="reserved-caption">Held funds remain in your account.<br />Available funds can be transferred internally.</p></div><p className="ledger-projection">These figures are balance projections returned by the ledger API. They are not calculated in this client.</p></section> : <State label="ACCOUNTS / EMPTY" title="A clean ledger."><p>Open your first currency account below. New accounts begin without funds.</p></State>}
      {error && <ErrorNotice code={error}>Previous balances remain visible. Their freshness is unconfirmed.</ErrorNotice>}
      <section className="section"><div className="section-heading"><div><h2>Currency accounts</h2><p className="ledger-caption">Available and reserved are separate ledger projections.</p></div><span className="eyebrow">{String(accounts.length).padStart(2, '0')} OPENED</span></div>{accounts.length > 0 && <div className="account-list">{accounts.map(account => <div className="account-row" key={account.id}><div className="account-currency"><span className="currency-tile">{account.currency.slice(0, 1)}</span><div><strong>{account.currency}</strong><div className="tiny">{currencies.find(c => c.code === account.currency)?.name ?? account.currency}</div></div></div><div className="account-available"><span className="eyebrow">AVAILABLE</span><Money amount={account.availableMinor} currency={account.currency} /></div><div className="account-reserved"><span className="eyebrow">RESERVED</span><Money amount={account.reservedMinor} currency={account.currency} /></div><div className="account-row-end"><span className="status">{account.status}</span><button className="text-button tiny" onClick={() => void copyText(account.id).catch(() => setCreateError('CLIPBOARD_UNAVAILABLE'))} aria-label={`Copy ${account.currency} account ID`}>Copy account ID ↗</button></div></div>)}</div>}
      {available.length > 0 && <div className="open-account"><label htmlFor="new-currency" className="eyebrow">ADD A CURRENCY ACCOUNT</label><div><select id="new-currency" value={selectedCurrency || available[0]?.code} disabled={creating || !!createKey} onChange={e => setSelectedCurrency(e.target.value)}>{available.map(c => <option value={c.code} key={c.code}>{c.code} — {c.name}</option>)}</select><button className="secondary" disabled={creating} onClick={create}>{creating ? 'Opening account…' : createKey ? 'Retry opening account ↗' : 'Open account ↗'}</button></div></div>}{createError && <ErrorNotice code={createError}>If the outcome is uncertain, retry this account request with its original key.</ErrorNotice>}</section>
      {first && <section className="section"><div className="section-heading"><h2>Recent activity <span className="inline-meta">/ {first.currency}</span></h2><Link className="text-button tiny" href="/activity">View all activity ↗</Link></div><History account={first.id} compact /></section>}
    </>}</>;
}
export default function Page() { return <Shell><Overview /></Shell>; }
