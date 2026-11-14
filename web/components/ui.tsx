'use client';
import Link from 'next/link';
import { formatMinor } from '@/lib/money.mjs';
import { useBank } from './data';
export function Brand() { return <Link href="/" className="brand" aria-label="Freehold home"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>FREEHOLD<span className="brand-period">.</span></Link>; }
export function State({ label, title, children, action }: { label: string; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return <section className="state" role={label.includes('ERROR') ? 'alert' : 'status'}><span className="eyebrow">{label}</span><h2>{title}</h2>{children && <div className="state-copy">{children}</div>}{action && <div className="state-action">{action}</div>}</section>;
}
export function Money({ amount, currency, className = '' }: { amount: string; currency: string; className?: string }) {
  const { currencies } = useBank(); const meta = currencies.find(c => c.code === currency);
  return <span className={`money ${className}`}>{meta ? formatMinor(amount, meta.minorUnitExponent) : 'Precision unavailable'}</span>;
}
export function ErrorNotice({ code, children }: { code: string; children?: React.ReactNode }) { return <div className="notice" role="alert"><span className="eyebrow">REQUEST NOT COMPLETED</span><p className="code">{code}</p>{children && <p>{children}</p>}</div>; }
export function PageHeading({ index, title, children }: { index: string; title: string; children?: React.ReactNode }) {
  return <header className="page-heading"><div><div className="eyebrow">{index} / PERSONAL LEDGER</div><h1>{title}</h1></div>{children}</header>;
}
