import type { Metadata } from 'next';
import '@fontsource/public-sans/400.css';
import '@fontsource/public-sans/500.css';
import '@fontsource/public-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import './globals.css';
import { SessionProvider } from '@/components/session';
export const metadata: Metadata = { title: { default: 'Freehold — Your ledger', template: '%s · Freehold' }, description: 'Account services from a self-controlled ledger. Precise balances. Deliberate transfers.' };
export default function Layout({ children }: { children: React.ReactNode }) { return <html lang="en"><body><SessionProvider>{children}</SessionProvider></body></html>; }
