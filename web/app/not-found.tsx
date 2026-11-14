import Link from 'next/link';
import { Brand, State } from '@/components/ui';
export default function NotFound() { return <div className="standalone"><Brand /><State label="ROUTE / 404" title="This address has no record." action={<Link className="button" href="/">Return to accounts ↗</Link>}><p>Choose an account service from the navigation. No financial operation was initiated by this page.</p></State></div>; }
