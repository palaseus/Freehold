'use client';
import { Shell } from '@/components/shell';
import { PageHeading } from '@/components/ui';

const states = ['CREATED', 'VALIDATING', 'PENDING_APPROVAL', 'READY_TO_SUBMIT', 'SUBMITTED', 'ACKNOWLEDGED', 'PENDING_SETTLEMENT', 'SETTLED', 'RETURNED', 'REJECTED', 'FAILED', 'UNKNOWN', 'CANCELLED'];

export default function DevelopersPage() {
  return <Shell>
    <PageHeading index="13" title="Sandbox API" />
    <div className="page-intro"><p>This page describes the simulated institutional API. It is not a production environment. The sample credential below is not a secret and cannot open a tenant.</p><span className="eyebrow">SANDBOX</span></div>
    <section className="section">
      <div className="section-heading"><h2>Sample credential</h2></div>
      <p className="ledger-caption">Key <span className="mono">fh_sandbox_000000000000000000000000</span></p>
      <p className="ledger-caption">Secret <span className="mono">not-a-real-secret</span></p>
      <p className="tiny">A real sandbox secret is shown once when a member issues it, then stored only as a SHA-256 hash. Do not paste a secret into a ticket, a log, or sample code.</p>
    </section>
    <section className="section">
      <div className="section-heading"><h2>Calling the sandbox</h2></div>
      <p className="tiny">Send <span className="mono">Authorization: Bearer keyId.secret</span>, <span className="mono">X-Institution-Id</span>, and a new <span className="mono">X-Institution-Nonce</span> of 8 to 80 characters. Reusing a nonce returns INSTITUTION_REPLAY. An expired key returns INSTITUTION_EXPIRED. A revoked key returns INSTITUTION_REVOKED. A wrong secret returns INSTITUTION_CREDENTIAL. A key from another tenant returns INSTITUTION_FORBIDDEN.</p>
      <p className="tiny">Put the durable idempotency key in the request body. Repeating that key returns the original payment or transfer and does not post a second one. A lost acknowledgment is not a reason to create a new payment.</p>
      <p className="tiny">The default sandbox limit is 1000 requests in a minute for one credential. INSTITUTION_RATE means the next request in that minute was refused.</p>
      <p className="tiny">Send <span className="mono">X-Correlation-Id</span> when you have one. The response echoes a correlation identifier.</p>
    </section>
    <section className="section">
      <div className="section-heading"><h2>Payment states</h2></div>
      <p className="tiny">{states.join(' · ')}</p>
      <p className="tiny">SUBMITTED means the instruction was accepted in the simulator. ACKNOWLEDGED is a provider acknowledgment. PENDING_SETTLEMENT is not final. SETTLED requires a signed simulated confirmation and posts one clearing journal. SETTLED_SIMULATED is not network finality. UNKNOWN is not success. RETURNED after settlement posts a new compensating journal on the institutional ledger. No state reverses the customer ledger.</p>
      <p className="tiny">Rails named by the API are ACH, FEDWIRE, BANK_INTERNAL, RTP, and STABLECOIN_NETWORK. None of those networks is connected.</p>
    </section>
    <section className="section">
      <div className="section-heading"><h2>Webhooks</h2></div>
      <p className="ledger-caption">Delivery guarantee <span className="mono">AT_LEAST_ONCE_ATTEMPT_NOT_EXACTLY_ONCE</span></p>
      <p className="tiny">Events are written in the same transaction as the committed state. A receiver can see a duplicate. Three failed or timed-out attempts become a dead letter. Signing uses the endpoint secret, which is shown once and can be rotated. Rotation discards the previous secret.</p>
    </section>
    <section className="section">
      <div className="section-heading"><h2>Simulated network</h2></div>
      <p className="tiny">Routes under <span className="mono">/v1/institution/network</span> simulate membership, routing, clearing, and settlement among fictional tenants. A routing acknowledgment is not settlement. A simulated confirmation is not finality at a bank. Messages stay on this host. This page does not hold a signing key, and it does not connect to a payment system.</p>
    </section>
    <section className="section">
      <div className="section-heading"><h2>Programmable sandbox</h2></div>
      <p className="tiny">Routes under <span className="mono">/v1/institution/program</span> accept a declarative workflow. They do not accept SQL, JavaScript, or shell. A preview is not execution. Simulated escrow is not legal custody. A simulated quote is not a market quote. Live issuance stays off.</p>
    </section>
    <section className="section">
      <div className="section-heading"><h2>Error codes</h2></div>
      <p className="tiny">INSTITUTION_FORBIDDEN, INSTITUTION_CREDENTIAL, INSTITUTION_EXPIRED, INSTITUTION_REVOKED, INSTITUTION_SCOPE, INSTITUTION_REPLAY, INSTITUTION_RATE, INSTITUTION_STATE, INSTITUTION_APPROVAL, INSTITUTION_SIGNATURE, INSTITUTION_INSUFFICIENT, INSTITUTION_BILLING, INSTITUTION_DEAD_LETTER, LIVE_MONETARY_ACTIVATION_REFUSED.</p>
      <p className="tiny">Amounts are decimal strings of minor units. The service does not accept a JSON number for money. Software invoices are simulated drafts and are not customer balances or reserve assets.</p>
    </section>
  </Shell>;
}
