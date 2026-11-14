'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useSession } from './session';
import { BankProvider, useBank } from './data';
import { Brand, State } from './ui';
import { post } from '@/lib/api';
function Frame({ children }: { children: React.ReactNode }) {
  const { session, refresh: refreshSession } = useSession(); const { refreshedAt, error } = useBank();
  const path = usePathname(); const router = useRouter(); const [logoutError, setLogoutError] = useState<string | null>(null);
  const items = [['/', 'Overview', '01'], ['/transfer', 'Transfer', '02'], ['/activity', 'Activity', '03'], ['/statement', 'Statement', '04'], ['/schedule', 'Schedule', '05'], ['/controls', 'Controls', '06'], ['/money', 'Money', '07'], ['/developers', 'Developers', '13'], ...(session?.user.role === 'ADMIN' ? [['/admin', 'Account control', '08'], ['/admin/ledger', 'Ledger', '09'], ['/admin/reserves', 'Reserves', '10'], ['/admin/evidence', 'Evidence', '11'], ['/admin/partners', 'Partners', '12'], ['/admin/platform', 'Platform', '14'], ['/admin/network', 'Network', '15'], ['/admin/program', 'Program', '16']] : [])];
  async function logout() { try { await post('/v1/auth/logout', {}, session!.csrfToken); await refreshSession(); router.push('/login'); } catch (e) { setLogoutError(e instanceof Error ? e.message : 'LOGOUT_UNCONFIRMED'); } }
  return <div className="app-frame"><aside className="rail"><Brand /><div className="rail-caption">INDEPENDENT BY DESIGN</div><nav aria-label="Primary">{items.map(([href, name, index]) => <Link key={href} href={href} className={path === href ? 'active' : ''} aria-current={path === href ? 'page' : undefined}><span>{index}</span>{name}<span className="nav-tick">↗</span></Link>)}</nav><div className="rail-bottom"><div className="eyebrow">SIGNED IN</div><div className="user-email">{session?.user.email}</div><div className="user-role">{session?.user.role === 'ADMIN' ? 'Institution administrator' : 'Personal account'}</div><button className="text-button logout" onClick={logout}>Sign out <span>↗</span></button>{logoutError && <p className="tiny code">{logoutError}</p>}<div className="rail-folio">FREEHOLD / ACCOUNT SERVICES<br />LEDGER V.01</div></div></aside><div className="workspace"><div className="utility"><span className="eyebrow">{session?.demoMode ? 'SANDBOX / SIMULATED FUNDS' : 'FREEHOLD / ACCOUNT SERVICES'}</span><div className="sync"><span className="sync-dot" />{error ? 'Read unavailable · previous snapshot' : refreshedAt ? `Updated ${refreshedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · 15s refresh` : 'Reading ledger'}</div></div><main>{children}</main><footer className="workspace-footer"><span>Balances are recorded in the institution’s ledger.</span><span>No external settlement required.</span></footer></div></div>;
}
export function Shell({ children }: { children: React.ReactNode }) {
  const { session, loading, error, refresh } = useSession();
  if (loading) return <div className="standalone"><Brand /><State label="SESSION / READING" title="Establishing your session."><p>Checking authorization with the institution.</p></State></div>;
  if (!session) return <div className="standalone"><Brand /><State label={error ? 'SESSION / ERROR' : 'SESSION / REQUIRED'} title={error ? 'The session service is unavailable.' : 'Your session needs attention.'} action={error ? <button onClick={() => void refresh()}>Check again</button> : <Link className="button" href="/login">Sign in securely <span>↗</span></Link>}><p>{error ? <span className="code">{error}</span> : 'Sign in to read balances or initiate a transfer. No unconfirmed changes have been discarded.'}</p></State></div>;
  return <BankProvider><Frame>{children}</Frame></BankProvider>;
}
