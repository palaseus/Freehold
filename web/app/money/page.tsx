'use client';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { useBank } from '@/components/data';
import { useSession } from '@/components/session';
import { ErrorNotice, Money, PageHeading, State } from '@/components/ui';
import { api, post } from '@/lib/api';

type Book = {
  code: string; unit: string; product: string; entity: string;
  outstanding: string; pendingIssuance: string; pendingRedemption: string;
  customerUnits: string; treasuryUnits: string; frozenUnits: string;
  issuedLifetime: string; redeemedLifetime: string;
  authorizedMaxOutstanding: string; issuanceSuspended: boolean; redemptionSuspended: boolean;
  simulatedEligibleReserves: string;
};
type Disclosure = { product: string; version: string; body: string; reviewStatus?: string; current?: boolean };
type Overview = {
  simulationOnly: boolean; liveIssuanceEnabled: boolean;
  institutionStatus: string; fusdStatus: string; fhuStatus: string;
  externalReserveEvidence: string; conversionAvailable: boolean; conversionReason: string;
  disclosures: Disclosure[];
  acknowledgments?: Array<{ product: string; version: string }>;
  books: Book[];
  customerUnits: Array<{ book: string; units: string; kind: string }>;
  bankAccounts: Array<{ id: string; state: string; simulationOnly: boolean }>;
};
type Activity = {
  simulationOnly: boolean;
  redemptionPolicy: string;
  fees: { conversionFeeMinor: string; redemptionFeeMinor: string; charged: boolean };
  holdings: Array<{ book: string; unit: string; kind: string; units: string }>;
  issuance: Array<{ issuanceId: string; book: string; state: string; amountMinor: string }>;
  redemptions: Array<{ redemptionId: string; book: string; state: string; amountMinor: string; externalSettlement: boolean }>;
};
type ConversionResult = { state: string; reason: string; availableMinor: string; fusdCredited: string };

function heldUnits(activity: Activity | null, book: string): string | null {
  if (!activity) return null;
  return activity.holdings
    .filter(row => row.book === book && row.kind === 'CUSTOMER')
    .reduce((sum, row) => sum + BigInt(row.units), 0n)
    .toString();
}

function MoneyPage() {
  const { accounts, loading, error } = useBank();
  const { session } = useSession();
  const usd = accounts.find(account => account.currency === 'USD') ?? null;
  const [overview, setOverview] = useState<Overview | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [amount, setAmount] = useState('100');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConversionResult | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);
  const [ackBusy, setAckBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [overviewResult, activityResult] = await Promise.allSettled([
      api<Overview>('/v1/monetary/overview'),
      api<Activity>('/v1/monetary/activity'),
    ]);
    if (overviewResult.status === 'fulfilled') {
      setOverview(overviewResult.value);
      setReadError(null);
    } else {
      const reason = overviewResult.reason;
      setReadError(reason instanceof Error ? reason.message : 'MONETARY_OVERVIEW_UNAVAILABLE');
    }
    if (activityResult.status === 'fulfilled') {
      setActivity(activityResult.value);
      setActivityError(null);
    } else {
      const reason = activityResult.reason;
      setActivityError(reason instanceof Error ? reason.message : 'MONETARY_ACTIVITY_UNAVAILABLE');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function convert(event: FormEvent) {
    event.preventDefault();
    if (!usd || !session || busy) return;
    setBusy(true); setSubmitError(null);
    try {
      const body = await post<ConversionResult>('/v1/monetary/conversions', { accountId: usd.id, amountMinor: amount }, session.csrfToken, crypto.randomUUID());
      setResult(body);
      await load();
    } catch (e) { setSubmitError(e instanceof Error ? e.message : 'CONVERSION_UNCONFIRMED'); }
    finally { setBusy(false); }
  }
  async function acknowledge(product: string, version: string) {
    if (!session || ackBusy) return;
    setAckBusy(product); setAckError(null);
    try {
      await post('/v1/monetary/disclosures/acknowledge', { product, version }, session.csrfToken);
      await load();
    } catch (e) { setAckError(e instanceof Error ? e.message : 'ACKNOWLEDGMENT_UNCONFIRMED'); }
    finally { setAckBusy(null); }
  }
  const fusd = overview?.books.find(book => book.code === 'FUSD_SIM') ?? null;
  const fhu = overview?.books.find(book => book.code === 'FHU_SIM') ?? null;
  const fusdHeld = heldUnits(activity, 'FUSD_SIM');
  const fhuHeld = heldUnits(activity, 'FHU_SIM');
  const fusdIssuance = activity?.issuance.filter(row => row.book === 'FUSD_SIM') ?? [];
  const fusdRedemptions = activity?.redemptions.filter(row => row.book === 'FUSD_SIM') ?? [];
  return <>
    <PageHeading index="07" title="USD and simulated FUSD" />
    <section className="section">
      <div className="section-heading"><h2>Product distinction</h2></div>
      <div className="notice">
        <p>Freehold is not a bank.</p>
        <p>Simulated FUSD is not a GENIUS Act payment stablecoin. It is not FDIC insured, not a United States government obligation, and not legal tender.</p>
        <p>A USD ledger balance, a bank deposit at a partner that has not been appointed, and simulated FUSD are different claims.</p>
        <p>Requesting a conversion does not credit FUSD because a USD balance was debited. This build refuses that conversion.</p>
      </div>
    </section>
    {loading ? <State label="USD / READING" title="Reading the USD ledger balance." /> : error && !usd ? <ErrorNotice code={error}>The USD balance could not be read.</ErrorNotice> : usd ? <section className="section">
      <div className="section-heading"><h2>USD ledger balance</h2><span className="eyebrow">NOT A BANK DEPOSIT</span></div>
      <p className="hero-amount"><Money amount={usd.availableMinor} currency="USD" /> <span>USD</span></p>
      <p className="ledger-caption">Partner status: no banking partner is appointed. A simulated bank event would not increase this balance.</p>
      {overview?.bankAccounts.length ? <p className="tiny">Simulated bank record {overview.bankAccounts[0].state}. Funds received: no.</p> : <p className="tiny">No simulated bank account is open for this USD account.</p>}
    </section> : <State label="USD / NONE" title="No USD account is open." />}
    {readError && <ErrorNotice code={readError}>Simulated FUSD figures are unavailable. The USD balance above is separate.</ErrorNotice>}
    {activityError && <ErrorNotice code={activityError}>Your simulated holdings could not be read. The USD balance above is separate.</ErrorNotice>}
    {fusd && <section className="section">
      <div className="section-heading"><h2>Simulated FUSD</h2><span className="eyebrow">{overview?.fusdStatus}</span></div>
      <p className="ledger-caption">You hold {fusdHeld ?? 'unavailable'} simulated FUSD.</p>
      <p className="ledger-caption">Issuance from this page: no. Issuance suspended: {fusd.issuanceSuspended ? 'yes' : 'no'}. Redemption suspended: {fusd.redemptionSuspended ? 'yes' : 'no'}.</p>
      <p className="ledger-caption">Outstanding {fusd.outstanding} minor units. Issued lifetime {fusd.issuedLifetime}. Redeemed lifetime {fusd.redeemedLifetime}. Pending issuance {fusd.pendingIssuance}. Pending redemption {fusd.pendingRedemption}.</p>
      <p className="ledger-caption">Customer-held {fusd.customerUnits}. Treasury-held {fusd.treasuryUnits}. Frozen {fusd.frozenUnits}.</p>
      <p className="ledger-caption">Simulated eligible reserves {fusd.simulatedEligibleReserves}. External reserve evidence {overview?.externalReserveEvidence}. Cap basis is outstanding units, maximum {fusd.authorizedMaxOutstanding}.</p>
      <p className="tiny">Entity {fusd.entity}. Live issuance enabled: {overview?.liveIssuanceEnabled ? 'yes' : 'no'}. This figure is not a reserve attestation.</p>
    </section>}
    <section className="section">
      <div className="section-heading"><h2>Redemption</h2></div>
      <p className="ledger-caption">Redemption is not offered. A simulated redemption recorded by the issuer stays a claim until settlement evidence exists. This page cannot redeem, and it cannot pay dollars.</p>
      <p className="tiny">Policy {activity?.redemptionPolicy ?? 'NOT_OFFERED'}.</p>
      {fusdRedemptions.length === 0 ? <p className="ledger-caption">No simulated redemption is pending or complete.</p> : fusdRedemptions.map(row => <p className="ledger-caption" key={row.redemptionId}>Redemption {row.state}. Amount {row.amountMinor} minor units. External settlement: {row.externalSettlement ? 'yes' : 'no'}.</p>)}
    </section>
    <section className="section">
      <div className="section-heading"><h2>Fees</h2></div>
      <p className="ledger-caption">No fee is charged. Conversion, issuance, and redemption on this page do not move a balance.</p>
      <p className="tiny">Conversion fee {activity?.fees.conversionFeeMinor ?? '0'} minor units. Redemption fee {activity?.fees.redemptionFeeMinor ?? '0'} minor units. Charged: {activity?.fees.charged ? 'yes' : 'no'}.</p>
    </section>
    <section className="section">
      <div className="section-heading"><h2>Your simulated FUSD records</h2></div>
      {fusdIssuance.length === 0 ? <p className="ledger-caption">No simulated FUSD has been issued to this account.</p> : fusdIssuance.map(row => <p className="ledger-caption" key={row.issuanceId}>Issuance {row.state}. Amount {row.amountMinor} minor units.</p>)}
    </section>
    {fhu && <section className="section">
      <div className="section-heading"><h2>FHU sandbox</h2><span className="eyebrow">{overview?.fhuStatus}</span></div>
      <p className="ledger-caption">You hold {fhuHeld ?? 'unavailable'} FHU. Outstanding {fhu.outstanding}. FHU is not a payment stablecoin, not a USD claim, and not evidence that issuance created value.</p>
    </section>}
    {overview?.disclosures?.length ? <section className="section">
      <div className="section-heading"><h2>Recorded disclosures</h2><span className="eyebrow">DRAFT / LEGAL REVIEW REQUIRED</span></div>
      <p className="ledger-caption">A draft acknowledgment is not a final disclosure, not legal acceptance, and not authorization to issue.</p>
      {overview.disclosures.map(item => {
        const recorded = overview.acknowledgments?.some(row => row.product === item.product && row.version === item.version) ?? false;
        return <div key={`${item.product}-${item.version}`}>
          <p className="ledger-caption">{item.product} {item.version}. Review {item.reviewStatus ?? 'LEGAL_REVIEW_REQUIRED'}. Current draft: {item.current ? 'yes' : 'no'}. {item.body}</p>
          {item.current && recorded && <p className="ledger-caption">Draft acknowledgment recorded for {item.product}. This is not a final disclosure and does not authorize issuance.</p>}
          {item.current && !recorded && <button type="button" disabled={ackBusy === item.product} onClick={() => void acknowledge(item.product, item.version)}>{ackBusy === item.product ? 'Recording…' : `Record draft acknowledgment for ${item.product}`}</button>}
        </div>;
      })}
      {ackError && <ErrorNotice code={ackError}>The draft acknowledgment was not recorded.</ErrorNotice>}
    </section> : null}
    {usd && <section className="section">
      <div className="section-heading"><h2>Conversion</h2></div>
      <form className="transfer-layout" onSubmit={convert}>
        <label htmlFor="convert-amount">Amount in minor units</label>
        <input id="convert-amount" inputMode="numeric" pattern="[1-9][0-9]{0,18}" value={amount} onChange={event => setAmount(event.target.value)} required />
        <button type="submit" disabled={busy}>{busy ? 'Submitting…' : 'Request conversion'}</button>
      </form>
      {result && <div className="notice" role="status"><p className="code">{result.reason}</p><p>State {result.state}. FUSD credited {result.fusdCredited}. USD available minor units remain {result.availableMinor}.</p></div>}
      {submitError && <ErrorNotice code={submitError}>The conversion was not accepted.</ErrorNotice>}
    </section>}
  </>;
}

export default function Page() {
  return <Shell><MoneyPage /></Shell>;
}
