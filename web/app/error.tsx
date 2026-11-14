'use client';
import { Brand, State } from '@/components/ui';
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) { return <div className="standalone"><Brand /><State label="CLIENT / DISPLAY ERROR" title="This view could not be prepared." action={<button onClick={reset}>Read this view again ↗</button>}><p>Account and transfer status must be confirmed with the API. If a transfer was in progress, retain its request key and retry the original request after reloading.</p></State></div>; }
