'use client';
import { useState } from 'react';
import { Shell } from '@/components/shell';
import { useBank } from '@/components/data';
import { History } from '@/components/history';
import { PageHeading, State } from '@/components/ui';
import Link from 'next/link';
function Activity() {
  const { accounts, loading, error } = useBank(); const [selected, setSelected] = useState(''); const account = selected || accounts[0]?.id;
  return <><PageHeading index="03" title="Recorded activity" /><div className="page-intro"><p>A record of posted movements, in the order they were recorded.</p><span className="eyebrow">15s REFRESH / NEWEST FIRST</span></div>{loading ? <State label="ACCOUNTS / READING" title="Locating your accounts." /> : error ? <State label="ACCOUNTS / ERROR" title="The account list is unavailable."><p className="code">{error}</p></State> : !account ? <State label="ACTIVITY / EMPTY" title="No accounts, no entries yet." action={<Link className="button" href="/">Open a currency account ↗</Link>} /> : <><div className="filter-row"><label htmlFor="history-account" className="eyebrow">ACCOUNT</label><select id="history-account" value={account} onChange={e => setSelected(e.target.value)}>{accounts.map(a => <option value={a.id} key={a.id}>{a.currency} · {a.id.slice(0, 8)}</option>)}</select><span className="tiny">Refresh pauses while reading older entries.</span></div><History key={account} account={account} /></>}</>;
}
export default function Page() { return <Shell><Activity /></Shell>; }
