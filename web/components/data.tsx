'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Account, Currency } from '@/lib/types';
type Data = { accounts: Account[]; currencies: Currency[]; loading: boolean; error: string | null; refreshedAt: Date | null; refresh: () => Promise<void> };
const Context = createContext<Data | null>(null);
export function BankProvider({ children }: { children: React.ReactNode }) {
  const [accounts, setAccounts] = useState<Account[]>([]); const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null); const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const active = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    try {
      const [a, c] = await Promise.all([api<Account[]>('/v1/accounts', { signal: controller.signal }), api<Currency[]>('/v1/currencies', { signal: controller.signal })]);
      if (!controller.signal.aborted) { setAccounts(a); setCurrencies(c); setError(null); setRefreshedAt(new Date()); }
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'ACCOUNT_READ_UNAVAILABLE'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh(); const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
    const visible = () => { if (!document.hidden) void refresh(); }; document.addEventListener('visibilitychange', visible);
    return () => { clearInterval(timer); active.current?.abort(); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);
  return <Context.Provider value={{ accounts, currencies, loading, error, refreshedAt, refresh }}>{children}</Context.Provider>;
}
export function useBank() { const data = useContext(Context); if (!data) throw new Error('Bank provider required'); return data; }
