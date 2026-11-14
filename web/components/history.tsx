'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { History as HistoryResponse, Transaction } from '@/lib/types';
import { Money, State } from './ui';
export function History({ account, compact = false }: { account: string; compact?: boolean }) {
  const [items, setItems] = useState<Transaction[]>([]); const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true); const [older, setOlder] = useState(false); const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null); const generation = useRef(0);
  const olderPages = useRef(false); const [viewingOlder, setViewingOlder] = useState(false);
  const load = useCallback(async (next?: string) => {
    active.current?.abort(); const controller = new AbortController(); active.current = controller; const current = ++generation.current;
    if (next) setOlder(true);
    try {
      const result = await api<HistoryResponse>(`/v1/accounts/${account}/transactions?limit=${compact ? 5 : 20}${next ? `&cursor=${encodeURIComponent(next)}` : ''}`, { signal: controller.signal });
      if (current === generation.current) { setItems(previous => next ? [...previous, ...result.items] : result.items); setCursor(result.nextCursor); setError(null); olderPages.current = !!next; setViewingOlder(!!next); }
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'HISTORY_UNAVAILABLE'); }
    finally { if (!controller.signal.aborted) { setLoading(false); setOlder(false); } }
  }, [account, compact]);
  useEffect(() => {
    setLoading(true); setItems([]); setCursor(null); olderPages.current = false; setViewingOlder(false); void load();
    const timer = setInterval(() => { if (!document.hidden && !olderPages.current && !active.current?.signal.aborted) void load(); }, 15000);
    return () => { clearInterval(timer); active.current?.abort(); generation.current++; };
  }, [load]);
  if (loading) return <State label="POSTINGS / READING" title="Reading recorded activity."><p>Entries appear only after a ledger commit.</p></State>;
  if (error) return <State label="POSTINGS / ERROR" title="Activity could not be refreshed." action={<button className="secondary" onClick={() => void load()}>Read again</button>}><p className="code">{error}</p></State>;
  if (!items.length) return <State label="POSTINGS / EMPTY" title="No recorded activity."><p>This account has no postings yet. Completed transfers will appear here.</p></State>;
  return <div className="history">{viewingOlder && <div className="history-reading"><span className="tiny mono">VIEWING OLDER ENTRIES / REFRESH PAUSED</span><button className="text-button tiny" onClick={() => void load()}>Refresh newest ↗</button></div>}<div className="table-scroll"><table><thead><tr><th>Entry / Recorded</th><th>Details</th><th className="align-right">Amount</th><th className="align-right">State</th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td><div className="entry-date">{new Date(item.recordedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</div><div className="tiny mono">{new Date(item.recordedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div></td><td><div className="entry-kind"><span className="direction-mark">{item.direction === 'CREDIT' ? '↙' : '↗'}</span>{item.kind === 'SANDBOX_FUND' ? 'Sandbox funding' : item.kind === 'RESERVE' ? 'Funds reserved' : item.kind === 'RELEASE' ? 'Hold released' : item.direction === 'CREDIT' ? 'Internal transfer received' : 'Internal transfer sent'}</div><div className="tiny mono transaction-reference" title={item.correlationId}>REF {item.correlationId.slice(0, 16)}</div></td><td className={`align-right transaction-amount ${item.direction === 'CREDIT' ? 'credit' : ''}`}>{item.direction === 'CREDIT' ? '+' : '−'}<Money amount={item.amountMinor} currency={item.currency} /><span className="tiny currency-code">{item.currency}</span></td><td className="align-right"><span className="status">POSTED</span></td></tr>)}</tbody></table></div>{!compact && <div className="history-footer"><span className="tiny mono">{items.length} RECORDED {items.length === 1 ? 'ENTRY' : 'ENTRIES'}</span>{cursor ? <button className="secondary" disabled={older} onClick={() => void load(cursor)}>{older ? 'Reading older entries…' : 'Load older entries ↓'}</button> : <span className="tiny">Beginning of account history</span>}</div>}</div>;
}
