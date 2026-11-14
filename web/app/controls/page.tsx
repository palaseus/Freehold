'use client';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { useBank } from '@/components/data';
import { useSession } from '@/components/session';
import { ErrorNotice, PageHeading, State } from '@/components/ui';
import { api, post } from '@/lib/api';

type Controls = {
  accountId: string; currency: string; outgoingEnabled: boolean;
  perTransferLimitMinor: string | null; dailyLimitMinor: string | null; monthlyLimitMinor: string | null;
  newDestinationReviewSeconds: number | null; stepUpThresholdMinor: string | null;
  institutionalSingleTransferMinor: string | null; institutionalDailyMinor: string | null; institutionalStepUpMinor: string | null;
  institutionalTransferBlocked: boolean;
  trustedDestinations: Array<{ destinationAccountId: string; trustedAt: string }>;
};

function blank(value: string | number | null | undefined) { return value === null || value === undefined ? '' : String(value); }

function ControlsPage() {
  const { accounts, loading, error } = useBank();
  const { session } = useSession();
  const [accountId, setAccountId] = useState('');
  const [controls, setControls] = useState<Controls | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [outgoing, setOutgoing] = useState(true);
  const [per, setPer] = useState('');
  const [daily, setDaily] = useState('');
  const [monthly, setMonthly] = useState('');
  const [review, setReview] = useState('');
  const [step, setStep] = useState('');
  const [destination, setDestination] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const selected = accounts.find(item => item.id === accountId) ?? accounts[0];
  const load = useCallback(async (id: string) => {
    try {
      const next = await api<Controls>(`/v1/accounts/${id}/controls`);
      setControls(next); setReadError(null);
      setOutgoing(next.outgoingEnabled);
      setPer(blank(next.perTransferLimitMinor));
      setDaily(blank(next.dailyLimitMinor));
      setMonthly(blank(next.monthlyLimitMinor));
      setReview(blank(next.newDestinationReviewSeconds));
      setStep(blank(next.stepUpThresholdMinor));
    } catch (e) { setControls(null); setReadError(e instanceof Error ? e.message : 'CONTROLS_UNAVAILABLE'); }
  }, []);
  useEffect(() => { if (selected) void load(selected.id); }, [selected, load]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!selected || busy) return;
    setBusy(true); setNotice(null);
    try {
      const saved = await post<Controls>(`/v1/accounts/${selected.id}/controls`, {
        outgoingEnabled: outgoing,
        perTransferLimitMinor: per.trim() || null,
        dailyLimitMinor: daily.trim() || null,
        monthlyLimitMinor: monthly.trim() || null,
        newDestinationReviewSeconds: review.trim() ? Number(review) : null,
        stepUpThresholdMinor: step.trim() || null,
      }, session!.csrfToken);
      setControls(saved);
    } catch (e) { setNotice(e instanceof Error ? e.message : 'CONTROLS_UNCONFIRMED'); }
    finally { setBusy(false); }
  }
  async function trust() {
    if (!selected || !destination || busy) return;
    setBusy(true); setNotice(null);
    try { setControls(await post<Controls>(`/v1/accounts/${selected.id}/trusted-destinations`, { destinationAccountId: destination }, session!.csrfToken)); setDestination(''); }
    catch (e) { setNotice(e instanceof Error ? e.message : 'TRUST_UNCONFIRMED'); }
    finally { setBusy(false); }
  }
  return <><PageHeading index="06" title="Transfer controls" />
    <div className="page-intro"><p>Personal limits can only be tighter than an institutional cap. A blank personal limit removes your cap. It does not raise or remove an institutional restriction.</p><span className="eyebrow">INSTITUTION FIRST</span></div>
    {loading ? <State label="ACCOUNTS / READING" title="Reading your accounts." /> : error && !accounts.length ? <State label="ACCOUNTS / ERROR" title="Accounts are unavailable."><p className="code">{error}</p></State> : !accounts.length ? <State label="ACCOUNTS / EMPTY" title="Open an account before setting controls." /> : <>
      <label htmlFor="control-account">Account</label>
      <select id="control-account" value={selected.id} onChange={e => setAccountId(e.target.value)}>{accounts.map(item => <option key={item.id} value={item.id}>{item.currency} · {item.id}</option>)}</select>
      {readError ? <State label="CONTROLS / ERROR" title="Controls are unavailable." action={<button onClick={() => void load(selected.id)}>Read again</button>}><p className="code">{readError}</p></State> : !controls ? <p className="tiny">Reading controls.</p> : <form className="transfer-form" onSubmit={save}>
        <p className="ledger-watch-line mono">INSTITUTIONAL SINGLE / {controls.institutionalSingleTransferMinor ?? 'NONE'} · DAILY / {controls.institutionalDailyMinor ?? 'NONE'} · STEP-UP / {controls.institutionalStepUpMinor ?? 'NONE'}</p>
        {controls.institutionalTransferBlocked && <div className="notice" role="status"><span className="eyebrow">INSTITUTIONAL BLOCK</span><p>This account is blocked by an institutional policy. Enabling outgoing transfers here does not lift that block.</p></div>}
        <label className="checkbox-label" htmlFor="outgoing"><input id="outgoing" type="checkbox" checked={outgoing} onChange={e => setOutgoing(e.target.checked)} /> Outgoing transfers enabled for this account</label>
        <label htmlFor="per">Personal per-transfer limit, minor units</label><input id="per" inputMode="numeric" value={per} onChange={e => setPer(e.target.value)} />
        <label htmlFor="daily">Personal daily limit, UTC day, minor units</label><input id="daily" inputMode="numeric" value={daily} onChange={e => setDaily(e.target.value)} />
        <label htmlFor="monthly">Personal monthly limit, UTC month, minor units</label><input id="monthly" inputMode="numeric" value={monthly} onChange={e => setMonthly(e.target.value)} />
        <label htmlFor="review">New destination review, seconds</label><input id="review" inputMode="numeric" value={review} onChange={e => setReview(e.target.value)} />
        <label htmlFor="step">Personal step-up threshold, minor units</label><input id="step" inputMode="numeric" value={step} onChange={e => setStep(e.target.value)} />
        <p className="field-help">Leave a box empty to clear that personal cap. The scheduler cannot complete step-up and will reject a transfer that requires it.</p>
        {notice && <ErrorNotice code={notice}>The previous controls remain in effect until a save is confirmed.</ErrorNotice>}
        <button className="transfer-submit" disabled={busy}>{busy ? 'Saving…' : 'Save controls ↗'}</button>
        <div className="form-section-number">TRUSTED DESTINATIONS</div>
        {!controls.trustedDestinations.length ? <p className="tiny">No trusted destinations.</p> : <ul>{controls.trustedDestinations.map(row => <li className="tiny mono" key={row.destinationAccountId}>{row.destinationAccountId} · {row.trustedAt}</li>)}</ul>}
        <label htmlFor="trust-dest">Destination account ID</label>
        <input id="trust-dest" value={destination} onChange={e => setDestination(e.target.value)} />
        <button className="secondary" type="button" disabled={busy || !destination} onClick={() => void trust()}>Trust destination ↗</button>
      </form>}
    </>}
  </>;
}

export default function Page() { return <Shell><ControlsPage /></Shell>; }
