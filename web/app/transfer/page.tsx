'use client';
import Link from 'next/link';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { Shell } from '@/components/shell';
import { useBank } from '@/components/data';
import { useSession } from '@/components/session';
import { ErrorNotice, Money, PageHeading, State } from '@/components/ui';
import { api, ApiError, errorCode, post } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { formatMinor } from '@/lib/money.mjs';
import type { Operation } from '@/lib/types';
import { classifyTransferOutcome } from '@/lib/transfer-outcome.mjs';
import type { TransferOutcome } from '@/lib/transfer-outcome.mjs';

type Draft = { sourceAccountId: string; destinationAccountId: string; currency: string; amountMinor: string; key: string };
type Saved = { draft: Draft; outcome: TransferOutcome; result?: Operation; error?: string; errorMessage?: string; httpStatus?: number };

function responseMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const message = (body as Record<string, unknown>).message;
  return typeof message === 'string' ? message : Array.isArray(message) ? message.join(' · ') : undefined;
}

function Transfer() {
  const { accounts, currencies, loading, error, refresh } = useBank();
  const { session } = useSession();
  const [source, setSource] = useState('');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [key, setKey] = useState('');
  const [saved, setSaved] = useState<Saved | null>(null);
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const busyRef = useRef(false);
  const storageKey = `freehold:transfer:${session!.user.id}`;

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) { setKey(crypto.randomUUID()); }
      else {
        const old = JSON.parse(raw) as Omit<Saved, 'outcome'> & { outcome: TransferOutcome | 'COMPLETED' };
        if (old.draft?.key && old.draft?.sourceAccountId && old.outcome) {
          const outcome: TransferOutcome = old.outcome === 'COMPLETED' ? 'COMMITTED' :
            old.outcome === 'REJECTED' && !(old.result?.operationId && old.result.state === 'REJECTED') ? 'UNKNOWN' : old.outcome;
          setSaved({ ...old, outcome });
          setSource(old.draft.sourceAccountId);
          setDestination(old.draft.destinationAccountId);
          setAmount(old.draft.amountMinor);
          setKey(old.draft.key);
        } else setKey(crypto.randomUUID());
      }
    } catch { setKey(crypto.randomUUID()); setNotice('DRAFT_STORAGE_UNAVAILABLE'); }
    setRestored(true);
  }, [storageKey]);

  const account = accounts.find(a => a.id === (source || accounts[0]?.id));
  const currency = account?.currency ?? saved?.draft.currency;
  const meta = currencies.find(c => c.code === currency);
  function remember(value: Saved) {
    setSaved(value);
    try { sessionStorage.setItem(storageKey, JSON.stringify(value)); }
    catch { setNotice('DRAFT_STORAGE_UNAVAILABLE — keep the visible key before leaving this page.'); }
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (busyRef.current || !account || !restored) return;
    const draft = saved?.outcome === 'UNKNOWN' ? saved.draft :
      { sourceAccountId: account.id, destinationAccountId: destination, currency: account.currency, amountMinor: amount, key };
    if (!/^[1-9][0-9]{0,18}$/.test(draft.amountMinor)) { setNotice('INVALID_AMOUNT — enter positive integer minor units.'); return; }
    busyRef.current = true; setBusy(true); setNotice(null);
    remember({ draft, outcome: 'UNKNOWN' });
    try {
      const { key: idempotency, ...body } = draft;
      const result = await post<Operation>('/v1/transfers', body, session!.csrfToken, idempotency);
      remember({ draft, outcome: classifyTransferOutcome(200, result), result });
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status > 0) {
        const body = e.body as Partial<Operation>;
        const outcome = classifyTransferOutcome(e.status, body);
        let existingResult: Operation | undefined;
        if (outcome === 'CONFLICT') {
          try {
            const resolved = await api<{ found: boolean; result?: Operation }>('/v1/transfers/resolve', { headers: { 'Idempotency-Key': draft.key } });
            if (resolved.found) existingResult = resolved.result;
          } catch { /* Preserve the conflict and allow another explicit status lookup. */ }
        }
        remember({ draft, outcome, ...(existingResult ? { result: existingResult } : body.operationId ? { result: body as Operation } : {}),
          error: errorCode(e.body), errorMessage: responseMessage(e.body), httpStatus: e.status });
      } else remember({ draft, outcome: 'UNKNOWN', error: e instanceof Error ? e.message : 'UNCONFIRMED_RESPONSE' });
    } finally { busyRef.current = false; setBusy(false); }
  }

  function newDraft() {
    if ((saved?.outcome === 'UNKNOWN' || saved?.outcome === 'CONFLICT') &&
      !window.confirm('The previous key has not confirmed this draft. An earlier request with this key may already have committed. Resolve the stored result before starting another transfer. Start a different draft anyway?')) return;
    setSaved(null); setDestination(''); setAmount(''); setKey(crypto.randomUUID()); setNotice(null);
    try { sessionStorage.removeItem(storageKey); }
    catch { setNotice('DRAFT_STORAGE_UNAVAILABLE — the previous draft may reappear after reloading.'); }
  }

  async function resolveConflict() {
    if (!saved || saved.outcome !== 'CONFLICT') return;
    try {
      const resolved = await api<{ found: boolean; result?: Operation }>('/v1/transfers/resolve',
        { headers: { 'Idempotency-Key': saved.draft.key } });
      if (resolved.found && resolved.result) remember({ ...saved, result: resolved.result });
      else setNotice('NO COMMITTED RESULT FOUND YET — keep this key and check again.');
    } catch (e) { setNotice(e instanceof Error ? e.message : 'TRANSFER_STATUS_UNAVAILABLE'); }
  }

  const locked = !!saved || busy;
  const outcome = saved?.outcome;
  const title = outcome === 'COMMITTED' ? 'Transfer recorded.' : outcome === 'REJECTED' ? 'Request rejected.' :
    outcome === 'UNKNOWN' ? 'Outcome unknown.' : outcome === 'CONFLICT' ? 'Key conflict.' : 'Every movement leaves a record.';
  const explanation = outcome === 'COMMITTED' ? 'The institution committed this transfer. Balances are read again from the API.' :
    outcome === 'REJECTED' ? 'The API returned a durable rejection for this exact request.' :
    outcome === 'UNKNOWN' ? 'Do not assume the transfer failed. Retry the unchanged request with this key to resolve its outcome.' :
    outcome === 'CONFLICT' ? 'This key belongs to a different payload. The earlier request may have committed; check its stored result before starting another transfer.' :
    'Review the source, destination and amount. A submitted transfer cannot be edited.';

  return <><PageHeading index="02" title="Internal transfer" /><div className="page-intro"><p>Move funds between accounts on the same ledger, in the same currency.</p><span className="eyebrow">NO EXTERNAL RAIL</span></div>
    {loading || !restored ? <State label="TRANSFER / PREPARING" title="Reading account availability." /> : error ?
      <State label="TRANSFER / ERROR" title="Source accounts are unavailable." action={<button onClick={() => void refresh()}>Read again</button>}><p className="code">{error}</p></State> : !accounts.length ?
      <State label="TRANSFER / NO SOURCE" title="Open an account first." action={<Link href="/" className="button">Go to accounts ↗</Link>}><p>A transfer needs an owned source account. No funds are inferred or created here.</p></State> :
      <div className="transfer-layout"><form onSubmit={submit} className="transfer-form">
        <div className="form-section-number">01 / SOURCE</div><label htmlFor="source">From account</label>
        <select id="source" value={source || accounts[0]?.id} onChange={e => setSource(e.target.value)} disabled={locked}>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.currency} · {a.id.slice(0, 8)} · {a.status}</option>)}
        </select>
        {account && <p className="source-balance">Available <Money amount={account.availableMinor} currency={account.currency} /> {account.currency}<span className="status">{account.status}</span></p>}
        <div className="form-section-number">02 / DESTINATION</div><label htmlFor="destination">Destination account ID</label>
        <input id="destination" required pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" value={destination} onChange={e => setDestination(e.target.value)} disabled={locked} placeholder="Full account UUID" className="mono" autoComplete="off" />
        <p className="field-help">Use the recipient’s {currency ?? 'same-currency'} account ID. Ownership and eligibility are verified by the API.</p>
        <div className="form-section-number">03 / AMOUNT</div><label htmlFor="amount">Amount <span className="label-note">Integer minor units</span></label>
        <div className="amount-input"><input id="amount" required inputMode="numeric" pattern="[1-9][0-9]{0,18}" value={amount} onChange={e => setAmount(e.target.value)} disabled={locked} placeholder="2500" autoComplete="off" /><span>{currency}</span></div>
        <p className="amount-preview">{amount && meta && /^[1-9][0-9]{0,18}$/.test(amount) ? `${formatMinor(amount, meta.minorUnitExponent)} ${currency}` : meta ? `1 ${currency} = ${'1' + '0'.repeat(meta.minorUnitExponent)} minor units` : 'Currency precision is not yet available.'}</p>
        <div className="idempotency"><div className="field-heading"><label htmlFor="idempotency">Idempotency-Key</label><button type="button" className="text-button tiny" onClick={() => void copyText(key).then(() => setNotice('KEY_COPIED')).catch(() => setNotice('CLIPBOARD_UNAVAILABLE'))}>Copy ↗</button></div>
          <input id="idempotency" className="mono key-input" required pattern="[!-~]{1,200}" maxLength={200} value={key} onChange={e => setKey(e.target.value)} disabled={locked} />
          <p className="field-help">This identifies one request. Retrying its exact details returns the original result.</p></div>
        {notice && <div className="inline-notice mono" role="status">{notice}</div>}
        {!saved ? <button className="transfer-submit" disabled={busy || !key || !meta} type="submit">{busy ? 'Awaiting ledger commit…' : 'Submit transfer'}<span>↗</span></button> :
          <div className="transfer-actions">{saved.outcome === 'UNKNOWN' && <button type="submit" disabled={busy}>{busy ? 'Confirming original request…' : 'Retry identical request ↗'}</button>}
            {saved.outcome === 'CONFLICT' && <button type="button" disabled={busy} onClick={() => void resolveConflict()}>Read stored result ↗</button>}
            <button className="secondary" type="button" disabled={busy} onClick={newDraft}>New transfer draft</button></div>}
      </form><aside className="transfer-aside"><div className="eyebrow">REQUEST / {busy ? 'AWAITING COMMIT' : outcome ?? 'DRAFT'}</div><h2>{busy ? 'Awaiting confirmation.' : title}</h2><p>{busy ? 'The API is checking eligibility and committing the ledger transaction.' : explanation}</p>
        {saved?.error && <ErrorNotice code={saved.error}>{saved.httpStatus ? `HTTP ${saved.httpStatus}${saved.errorMessage ? ` — ${saved.errorMessage}` : ''}` : saved.errorMessage}</ErrorNotice>}
        <dl className="receipt">{saved && <><dt>STATE</dt><dd>{saved.outcome}</dd><dt>Idempotency-Key / RETRY WITH THIS VALUE</dt><dd className="receipt-key">{saved.draft.key}</dd></>}
          {saved?.error && <><dt>API ERROR CODE</dt><dd>{saved.error}</dd>{saved.errorMessage && <><dt>API ERROR MESSAGE</dt><dd>{saved.errorMessage}</dd></>}</>}
          {saved?.result?.operationId && <><dt>STORED OPERATION</dt><dd>{saved.result.operationId}</dd></>}
          {saved?.result?.correlationId && <><dt>CORRELATION</dt><dd>{saved.result.correlationId}</dd></>}
          {saved?.result?.transferId && <><dt>TRANSFER</dt><dd>{saved.result.transferId}</dd></>}</dl>
        <div className="transfer-fineprint"><span className="eyebrow">POSTING RULES</span><p>Same currency only.<br />Available funds only.<br />No overdrafts.<br />One durable result per request key.</p></div>
      </aside></div>}
  </>;
}

export default function Page() { return <Shell><Transfer /></Shell>; }
