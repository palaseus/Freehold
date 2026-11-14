'use client';
import Link from 'next/link';
import { GeneralLedger } from '@/components/general-ledger';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { PageHeading, State } from '@/components/ui';

function Ledger() {
  const { session } = useSession();
  const fresh = !!session?.recentTwoFactorUntil && new Date(session.recentTwoFactorUntil).getTime() > Date.now();
  if (session?.user.role !== 'ADMIN') return <State label="ACCESS / RESTRICTED" title="Institution access required."><p>Your role does not permit ledger reports.</p></State>;
  if (!fresh) return <State label="AUTHORIZATION / 2FA EXPIRED" title="Verify your access again." action={<Link className="button" href="/login">Sign in with an authenticator ↗</Link>}><p>Ledger reports require authenticator verification within the last five minutes.</p></State>;
  return <><PageHeading index="08" title="General ledger" /><div className="page-intro"><p>Read-only presentation of recorded postings. Missing asset, revenue, and expense sources stay marked not available. This is not a regulatory filing.</p><span className="eyebrow">NOT A FILING</span></div><GeneralLedger /></>;
}

export default function Page() { return <Shell><Ledger /></Shell>; }
