'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Session } from '@/lib/types';
type Value = { session: Session | null; loading: boolean; error: string | null; refresh: () => Promise<void> };
const Context = createContext<Value | null>(null);
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setError(null);
    try { setSession(await api<Session>('/v1/auth/session')); }
    catch (e) { setSession(null); if (!(e instanceof ApiError && e.status === 401)) setError(e instanceof Error ? e.message : 'SESSION_UNAVAILABLE'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh(); const expired = () => setSession(null); window.addEventListener('freehold:expired', expired);
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
    return () => { clearInterval(timer); window.removeEventListener('freehold:expired', expired); };
  }, [refresh]);
  return <Context.Provider value={{ session, loading, error, refresh }}>{children}</Context.Provider>;
}
export function useSession() { const value = useContext(Context); if (!value) throw new Error('Session provider required'); return value; }
