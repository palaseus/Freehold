'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Money } from './ui';

const kinds = [
  ['trial-balance', 'Trial balance'],
  ['customer-reconciliation', 'Customer liability reconciliation'],
  ['balance-sheet', 'Balance sheet'],
  ['income-statement', 'Income statement'],
  ['suspense', 'Suspense'],
  ['activity', 'Account activity'],
  ['journal-export', 'Journal export'],
] as const;

type Report = Record<string, unknown>;

function text(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'NOT AVAILABLE';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function StatusBlock({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return <p className="ledger-watch-line mono">{text(value)}</p>;
  const record = value as Record<string, unknown>;
  return <p className="ledger-watch-line mono">{text(record.status ?? record.reason ?? value)}{record.reason && record.status ? ` / ${text(record.reason)}` : ''}</p>;
}

export function GeneralLedger() {
  const [kind, setKind] = useState<(typeof kinds)[number][0]>('trial-balance');
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setReport(await api<Report>(`/v1/admin/gl/${kind}`)); setError(null); }
    catch (e) { setReport(null); setError(e instanceof Error ? e.message : 'GL_UNAVAILABLE'); }
  }, [kind]);
  useEffect(() => { void load(); }, [load]);
  const lines = Array.isArray(report?.lines) ? report.lines as Report[] : Array.isArray(report?.byCurrency) ? report.byCurrency as Report[] : Array.isArray(report?.entries) ? report.entries as Report[] : [];
  return <section className="ledger-watch"><div className="section-heading"><div><span className="eyebrow">GENERAL LEDGER / READ ONLY</span><h2>Institutional presentation</h2></div><button className="text-button tiny" onClick={() => void load()}>Read again ↗</button></div>
    <div className="filter-row"><label htmlFor="gl-kind">REPORT</label><select id="gl-kind" value={kind} onChange={e => setKind(e.target.value as (typeof kinds)[number][0])}>{kinds.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
    <p className="tiny">These figures come from the ledger API. This page is not a regulatory filing. Manual journals stay disabled.</p>
    {error ? <p className="ledger-watch-line mono">REPORT / UNAVAILABLE / {error}</p> : !report ? <p className="ledger-watch-line mono">REPORT / LOADING</p> : <>
      <p className="ledger-watch-line mono">{text(report.kind)} / {text(report.filingStatus)} / {text(report.generatedAt)}</p>
      {report.note ? <p className="tiny">{text(report.note)}</p> : null}
      {report.manualJournal ? <p className="ledger-watch-line mono">MANUAL JOURNAL / {text(report.manualJournal)}</p> : null}
      {report.assets ? <><p className="tiny">ASSETS</p><StatusBlock value={report.assets} /></> : null}
      {report.liabilities ? <><p className="tiny">LIABILITIES</p><StatusBlock value={report.liabilities} /></> : null}
      {report.equity ? <><p className="tiny">EQUITY</p><StatusBlock value={report.equity} /></> : null}
      {report.equation ? <p className="ledger-watch-line mono">EQUATION / {text(report.equation)}</p> : null}
      {report.revenue ? <><p className="tiny">REVENUE</p><StatusBlock value={report.revenue} /></> : null}
      {report.expenses ? <><p className="tiny">EXPENSES</p><StatusBlock value={report.expenses} /></> : null}
      {report.netIncome ? <><p className="tiny">NET INCOME</p><StatusBlock value={report.netIncome} /></> : null}
      {report.externalAssets ? <><p className="tiny">EXTERNAL ASSETS</p><StatusBlock value={report.externalAssets} /></> : null}
      {!lines.length ? <p className="tiny">No lines were returned for this report.</p> : <div className="table-scroll"><table><thead><tr>{Object.keys(lines[0] ?? {}).filter(key => key !== 'unavailable').map(key => <th key={key}>{key}</th>)}</tr></thead><tbody>{lines.map((line, index) => <tr key={index}>{Object.entries(line).filter(([key]) => key !== 'unavailable').map(([key, value]) => <td key={key} className="mono">{moneyCell(key, value, line)}</td>)}</tr>)}</tbody></table></div>}
    </>}
  </section>;
}

function moneyCell(key: string, value: unknown, line: Report) {
  const currency = typeof line.currency === 'string' ? line.currency : '';
  if (currency && typeof value === 'string' && /Minor$/.test(key)) return <Money amount={value} currency={currency} />;
  if (value && typeof value === 'object') return text(value);
  return text(value);
}
