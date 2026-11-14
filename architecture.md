# Freehold MVP Technical Architecture

## 1. System overview and non-goals

Freehold is a self-controlled account and accounting system. The institution defines account ownership, maintains its authoritative ledger, authorizes transfers, and determines when obligations are settled. Internal transfers require only Freehold’s application and PostgreSQL database.

External banks, payment networks, and stablecoins are optional settlement mechanisms behind adapters. Their availability must never determine whether the core ledger can record an internal transfer.

Build a **modular monolith** with one API deployment, one background worker deployment, and one shared PostgreSQL database. Services described below are application modules, not independently deployed microservices.

### MVP capabilities

- User authentication and institution-controlled account ownership.
- Multiple currency accounts per user.
- Available and reserved balances.
- Immediate, same-currency internal transfers.
- Immutable double-entry bookkeeping.
- Account freezing, administrative controls, and auditable reversals.
- Durable hooks for future settlement integrations.

### Non-goals

The MVP will not provide:

- A full KYC/AML engine, sanctions screening, transaction monitoring, or regulatory reporting.
- Fiat custody license simulation or claims that ledger balances constitute insured deposits.
- Real-time external bank connectivity.
- Production fiat deposits, withdrawals, or stablecoin minting/burning.
- Currency conversion, credit, overdrafts, interest, cards, or lending.
- Joint accounts, delegated spending, or ownership transfers.
- Distributed consensus or active-active ledger writes across regions.

Initial funding uses an explicitly labeled **sandbox funding operation**, balanced against an institution-controlled sandbox equity account. It does not imply receipt or custody of external assets. Real funds require a separate operational and accounting design before activation.

## 2. Recommended technology stack

| Component | Recommendation | Justification |
|---|---|---|
| Runtime | Supported Node.js LTS + TypeScript | One language across API and workers; typed domain boundaries. |
| API framework | NestJS with Fastify adapter | NestJS provides module boundaries and authorization guards; Fastify handles HTTP transport. |
| Database | PostgreSQL | Transactions, row locks, constraints, and restricted database functions protect financial invariants. |
| Database access | `node-postgres` with parameterized SQL and versioned SQL migrations | Keeps locking, posting functions, and constraint behavior explicit. |
| Ephemeral state | Redis | Sessions, rate limits, short-lived authentication challenges, and optional idempotency response caching. |
| Jobs | BullMQ | Simple workers for notifications, reconciliation scheduling, audit export, and future settlement dispatch. |
| API contract | REST + OpenAPI | Straightforward clients, validation, and integration testing. |
| Deployment | Containers; one primary database with standby and backups | Small operational footprint and a single authoritative writer. |

PostgreSQL is authoritative for balances, transfers, idempotency, and pending work. Redis is never the only copy of financial state.

Use separate Redis instances for session/rate-limit data and BullMQ in production so cache eviction policy cannot remove queue state. Queue workers must tolerate duplicate execution; BullMQ explicitly documents reprocessing after worker failures. [BullMQ documentation](https://docs.bullmq.io/)

## 3. Core domain model and schema

### Monetary conventions

- Each account holds exactly one currency. A user holds multiple accounts to obtain multi-currency support.
- Store money as `BIGINT` integer minor units; never floating point.
- Currency definitions specify precision: USD uses 2 decimal places, for example.
- Serialize monetary amounts as decimal integer strings in JSON to avoid JavaScript integer precision loss.
- Use UUID identifiers and UTC `TIMESTAMPTZ` timestamps.
- Reject amounts outside configured limits before arithmetic; use PostgreSQL `NUMERIC` for aggregate validation.
- Currency precision becomes immutable once referenced by any account or posting.
- No journal exchanges value between currencies in the MVP.

### Entity outline

| Entity | Important columns and constraints |
|---|---|
| `users` | `id PK`, `email_normalized UNIQUE`, `password_hash`, `status`, `role`, encrypted `totp_secret`, `auth_version`, timestamps. Roles: `USER`, `ADMIN`. |
| `currencies` | `code PK`, `name`, `minor_unit_exponent`, `enabled`. Validate supported precision bounds. Codes are internal identifiers; not every code must represent sovereign fiat. |
| `accounts` | `id PK`, `owner_user_id FK`, `currency_code FK`, `status`, `available_minor BIGINT DEFAULT 0`, `reserved_minor BIGINT DEFAULT 0`, timestamps. `UNIQUE(owner_user_id, currency_code)`; both balances must be nonnegative. |
| `ledger_accounts` | `id PK`, `currency_code FK`, `customer_account_id FK NULL`, `bucket`, `accounting_class`, `normal_side`. Customer buckets are `AVAILABLE` and `RESERVED`; other rows represent institutional accounts. |
| `ledger_journals` | `id PK`, `operation_id UNIQUE`, `transfer_id FK NULL`, `kind`, `correlation_id`, `effective_at`, `recorded_at`, `reverses_journal_id FK NULL`, `created_by`. Insert-only. |
| `ledger_entries` | `id PK`, `journal_id FK`, `line_no`, `ledger_account_id`, `currency_code`, `side`, `amount_minor`. `side IN ('DEBIT','CREDIT')`, `amount_minor > 0`, `UNIQUE(journal_id,line_no)`. Insert-only. |
| `transfers` | `id PK`, `initiator_user_id FK`, source/destination account FKs, currency, positive amount, state, `idempotency_key`, `request_hash`, `correlation_id`, failure code, timestamps. `UNIQUE(initiator_user_id,idempotency_key)`; source differs from destination. |
| `idempotency_requests` | `actor_id`, `operation`, `key`, canonical `request_hash`, resource ID, terminal response status/body, timestamps. Composite primary key `(actor_id,operation,key)`. Covers transfers and other retryable mutations. |
| `admin_actions` | `id PK`, `actor_user_id FK`, action type, target ID, reason, request/correlation ID, before/after state, timestamp. Append-only; reason required. |
| `audit_log` | `id PK`, actor or service identity, event type, resource ID, correlation/request IDs, outcome, sanitized metadata, timestamp. Append-only. |
| `outbox_events` | `id PK`, aggregate ID, event type, versioned payload, timestamp, dispatch status, attempt count. Inserted with the business transaction. |
| `holds` | `id PK`, account FK, positive amount, state, purpose, expiry, creation/release/capture operation IDs. Supports explicitly attributable reservations. |
| `settlement_instructions` | Future-facing operation ID, transfer/hold references, adapter, external reference, status, attempts, timestamps. No real instructions dispatched in the MVP. |

Account owners and account currencies cannot be changed after creation. Account deletion is prohibited once referenced; closing an account preserves its history and requires zero balances and no active holds.

### Accounting model

Customer balances represent institutional liabilities and are credit-normal:

```text
Transfer 2,500 USD minor units from Alice to Bob:

DEBIT   Alice / USD / AVAILABLE    2,500
CREDIT  Bob   / USD / AVAILABLE    2,500
```

A reservation moves value between two liability buckets:

```text
DEBIT   Alice / USD / AVAILABLE    2,500
CREDIT  Alice / USD / RESERVED     2,500
```

A release reverses that movement. Reservations therefore cannot silently change spendability without an accounting record.

The account balance columns are transactionally maintained projections:

```text
available_minor = available-bucket credits − debits
reserved_minor  = reserved-bucket credits − debits
```

The entries remain the source of truth. A controlled reconciliation process can reconstruct both projections.

### Database enforcement

Ordinary `CHECK` constraints cannot enforce sums across multiple entry rows. Use a restricted posting function plus deferred constraint triggers.

1. **Currency consistency:** a composite FK from each entry’s `(ledger_account_id, currency_code)` to the corresponding ledger account prevents currency mismatches.
2. **Balanced journals:** deferred triggers on journal and entry insertion verify that every new journal has at least two entries, contains exactly one currency, and has equal debit and credit totals.
3. **No empty journals:** validate journal insertion as well as entry insertion; otherwise an empty journal could escape checks.
4. **No historical additions:** posting functions create journals and all their entries together. Callers cannot append entries to an existing journal.
5. **Immutability:** reject updates/deletes to journals and entries; use restrictive foreign keys rather than cascading deletion.
6. **No overdrafts:** customer balance columns have nonnegative constraints, backed by locked balance checks during posting.
7. **Projection consistency:** posting functions compute balance deltas from entries rather than accepting caller-supplied resulting balances. Deferred validation compares affected accounts against their ledger buckets.
8. **Business correspondence:** an internal transfer posting must match its transfer’s source, destination, currency, amount, and state. A transfer’s unique `operation_id` prevents posting twice.

PostgreSQL supports constraint triggers deferred until transaction end, allowing a debit and credit to be inserted before the journal is validated. Explicitly force deferred checks before returning from the transaction when useful; commit remains the final boundary. [PostgreSQL `CREATE TRIGGER`](https://www.postgresql.org/docs/current/sql-createtrigger.html)

The application role receives no direct write privileges on ledger tables or balance columns. It executes narrowly scoped functions such as `execute_internal_transfer`, `reserve_funds`, and `release_hold`. These functions use a non-login owner, fixed safe `search_path`, schema-qualified objects, and no public execution permission.

### Important indexes

- `accounts(owner_user_id, status)`.
- Unique customer ledger bucket: `(customer_account_id, bucket)` where the customer account is non-null.
- `ledger_entries(ledger_account_id, journal_id)` for reconstruction.
- `ledger_journals(effective_at, id)` and `(correlation_id)`.
- `transfers(source_account_id, created_at DESC, id)`.
- `transfers(destination_account_id, created_at DESC, id)`.
- `audit_log(resource_id, recorded_at, id)` and `(correlation_id)`.
- Partial index on undispatched outbox rows.
- Partial index on active holds by account and expiry.

Use a stable cursor based on recording time and ID for transaction history. Effective time is an accounting attribute, not a reliable insertion-order cursor.

## 4. Core services

| Service | Responsibilities and boundaries |
|---|---|
| **Auth** | Password authentication, optional user TOTP, mandatory admin 2FA, session issuance/revocation, password reset, and recovery codes. |
| **Account** | Create accounts and their ledger buckets atomically; enforce one account per owner/currency; return balances and status; verify ownership. Cannot change balances. |
| **Ledger** | Sole balance mutation authority. Own posting functions, journal validation, reservations, releases, reversals, and reconciliation. |
| **Transfer** | Validate transfer requests, ownership, limits, recipient eligibility, and idempotency; invoke the atomic database transfer operation. |
| **Admin** | Freeze/unfreeze accounts, inspect audit records, and request controlled corrective operations. No arbitrary balance edits. |
| **Settlement** | Translate durable internal instructions to optional external adapters and reconcile their outcomes. Stubbed in the MVP. |
| **Worker** | Dispatch outbox events, send notifications, run reconciliation, and export audit evidence. Duplicate-safe processing required. |

### Settlement adapter contract

```ts
interface SettlementAdapter {
  capabilities(): {
    currencies: string[];
    operations: Array<"PAYMENT" | "MINT" | "BURN">;
  };

  submit(instruction: {
    operationId: string;
    kind: "PAYMENT" | "MINT" | "BURN";
    currency: string;
    amountMinor: string;
    destinationReference: string;
  }): Promise<{
    externalReference?: string;
    status: "PENDING" | "CONFIRMED" | "REJECTED" | "UNKNOWN";
  }>;

  lookup(operationId: string): Promise<{
    externalReference?: string;
    status: "PENDING" | "CONFIRMED" | "REJECTED" | "UNKNOWN";
    evidenceReference?: string;
  }>;
}
```

Contract requirements:

- `operationId` is stable across retries.
- `CONFIRMED` means the adapter’s defined finality criterion has been met, not merely that a request was accepted.
- A timeout produces `UNKNOWN`; it does not prove rejection.
- External evidence is durably recorded and deduplicated.
- Adapters never write ledger tables directly.
- Future settlement uses purpose-specific clearing accounts and journals; it never edits an internal transfer’s original postings.
- The MVP stub returns `REJECTED` with `ADAPTER_DISABLED` and performs no network operation.

Mint/burn integration requires explicit rules connecting token supply, custody/control evidence, and ledger liabilities. The interface alone does not establish those rules.

## 5. Transaction and consistency model

### Internal transfer lifecycle

```text
RECEIVED → COMPLETED
         → REJECTED
```

`RECEIVED` is normally transient inside one database transaction. Do not commit an internal transfer in an ambiguous processing state.

A completed transfer remains completed permanently. A reversal is a new authorized operation with a journal referencing the original; it may fail if the recipient no longer has sufficient funds. The MVP does not permit a reversal to create an overdraft.

### Atomic execution

For `POST /transfers`:

1. Authenticate, validate input, and derive the initiating user from the session.
2. Begin a PostgreSQL transaction.
3. Insert the idempotency record. A unique conflict waits for the competing transaction, then returns its stored result or a key-reuse conflict.
4. Lock both account rows with `SELECT … FOR UPDATE` in ascending account ID order.
5. Recheck ownership, enabled currency, account status, amount, same-currency requirement, and available funds under those locks.
6. Create the transfer.
7. Invoke the Ledger posting routine:
   - Create one journal and its debit/credit entries.
   - Decrease source available balance and increase destination available balance.
   - Mark the transfer `COMPLETED`.
8. Insert the business audit record, outbox event, and terminal idempotency response.
9. Commit, then return success.

Expected business rejections are stored as `REJECTED` with the idempotency response and no journal. Unexpected database or application errors roll back the transaction.

### Concurrency and overdrafts

Use PostgreSQL `READ COMMITTED` with explicit row locks for these known-account operations.

- Concurrent debits from the same account serialize on its account row.
- Every posting path locks affected accounts in the same order.
- Freeze/unfreeze uses the same account locks.
- A freeze blocks new transfers both into and out of the account. Whichever operation acquires the lock first determines the order.
- Read balances from the primary; do not authorize spending using Redis or a lagging replica.
- Bound lock waits and transaction duration. Retry deadlocks or serialization failures a small number of times using the same idempotency key.

No database transaction remains open during external calls or job execution.

### Idempotency

PostgreSQL provides durable idempotency; Redis may cache committed responses.

- Require a client-generated key for every transfer.
- Scope the key to authenticated actor and operation.
- Hash canonical economic fields: source, destination, currency, and integer amount.
- Same key and same payload: return the original status and resource.
- Same key and different payload: return `409 IDEMPOTENCY_CONFLICT`.
- Preserve financial-operation keys for the retained lifetime of their transfer records.
- A previously rejected key continues to return its original rejection. A new intended attempt requires a new key.

Idempotency prevents duplicate execution of one identified request. Two distinct keys represent two requests and can both execute.

### Failure behavior

| Failure | Required behavior |
|---|---|
| Crash before commit | PostgreSQL rolls back all financial changes. |
| Commit succeeds, HTTP response is lost | Retry returns the stored result. |
| Connection drops during commit | Outcome is unknown to the caller; resolve by the original idempotency key. |
| Worker or Redis unavailable | Financial commit remains valid; outbox work accumulates in PostgreSQL. |
| Duplicate job delivery | Consumer deduplicates by event/operation ID. |
| Database unavailable | Reject financial writes; never accept provisional balance changes in memory. |
| Reconciliation mismatch | Alert, block affected posting paths, investigate; never silently overwrite ledger history. |

The outbox dispatcher may publish an event and crash before marking it dispatched, so delivery is at least once. Use a durable consumer inbox where effects require deduplication; a queue job ID alone is insufficient after job retention expires. [BullMQ idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs)

Future external settlement uses separate transactions for reservation, dispatch, and confirmation. Keep funds reserved while the outcome is unknown; release only after confirmed rejection or cancellation.

## 6. Security and operations

### Authentication and sessions

- Hash passwords with Argon2id and calibrated resource costs.
- Complete optional TOTP before issuing a fully authenticated session.
- Store opaque, high-entropy sessions in Redis; use `Secure`, `HttpOnly`, `SameSite` cookies and CSRF protection for browser mutations.
- Rotate sessions after login and privilege changes.
- Check the user’s PostgreSQL status and authentication version for financial mutations so revocation is not dependent on cache freshness.
- Use short-lived, single-use password reset tokens; store only token hashes.
- Encrypt TOTP secrets separately from the database; store recovery codes as hashes.
- Require recent authentication and 2FA for administrative actions.
- If session storage is unavailable, reject authenticated requests rather than bypassing session checks.

### Authorization

- Users may debit only accounts they own.
- Users may view only their own balances and transaction histories.
- Recipient lookup reveals only the minimum information needed to confirm a transfer.
- Admin status permits explicit administrative operations; it does not grant permission to spend customer funds.
- Freeze/unfreeze requires a reason and produces an atomic admin action and audit record.
- No public endpoint accepts arbitrary ledger entries, user roles, or resulting balances.
- Corrections use narrowly scoped reversal or sandbox-funding commands.

Authorization is checked in the API and repeated for financial ownership/status invariants inside the restricted database operation.

### Ledger integrity and threat model

| Threat | Concrete control |
|---|---|
| Account takeover | Login throttling, TOTP, session revocation, and per-transfer limits. |
| Cross-user access | Resource ownership checks on every account/history request. |
| Concurrent double spending | Account locks, nonnegative constraints, atomic posting. |
| Request replay | Durable idempotency and unique posting operation IDs. |
| Compromised application process | Restricted database roles and narrowly scoped posting functions limit arbitrary writes; valid-looking fraudulent requests remain a risk. |
| Malicious administrator | No balance editor; reasoned actions, restricted correction commands, independent audit export. |
| Database superuser compromise | Separate operational access, access logging, independent exports, and backups. SQL immutability controls cannot constrain a superuser. |
| Future forged settlement callback | Signature verification, replay protection, durable evidence, and reconciliation before ledger effects. |

Use parameterized SQL, schema validation, payload size limits, and allowlisted currencies and operation types.

### Audit requirements

Record successful financial changes, reversals, freezes, authentication security events, privileged reads, and configuration changes.

- Financial and administrative success records commit with their business change.
- Failed authentication and unauthorized requests use a separate security logging path.
- Include actor, request/correlation IDs, target, outcome, reason, recorded time, and relevant before/after values.
- Do not log passwords, tokens, TOTP secrets, or unrestricted request bodies.
- Export append-only records to separately administered storage with immutable retention and signed manifests.
- Keep `recorded_at` database-generated. Restrict effective-date backdating; MVP transfers use posting time.

### Operational controls

- Keep secrets in a managed secret store; use separate API, worker, migration, and backup credentials.
- The API login throttle uses normalized account identity because the Next.js proxy address is shared and forwarded client IP headers are untrusted. Add ingress-level IP/bot controls at the trusted edge; enforce financial amount limits in PostgreSQL as well.
- Enable encrypted backups and point-in-time recovery; practice restores.
- Define recovery targets before launch. If acknowledged transactions must survive failover with zero loss, use synchronous replication; otherwise document the actual recovery-point window.
- Alert on posting failures, lock contention, outbox age, failed jobs, unusual admin activity, and reconciliation discrepancies.
- Reconcile debit/credit totals, balance projections, active holds versus reserved balances, and completed transfers versus journals.
- Run reconciliation against one consistent database snapshot to avoid false mismatches during concurrent posting.
- Use additive migrations and restricted deployment credentials; run posting-invariant checks after changes.

## 7. API surface

All monetary values use minor-unit strings. Mutation requests carry a correlation ID and, where applicable, an `Idempotency-Key`.

| Method and route | Purpose | Main rules |
|---|---|---|
| `POST /v1/auth/register` | Create user | No caller-selected admin role. |
| `POST /v1/auth/login` | Authenticate | May return a pending 2FA challenge. |
| `POST /v1/auth/2fa/verify` | Complete authentication | Single-use challenge. |
| `POST /v1/auth/logout` | Revoke session | Current session invalidated. |
| `POST /v1/accounts` | Create currency account | Body: `{ "currency": "USD" }`; owner comes from session. |
| `GET /v1/accounts` | List owned accounts | Includes status and currency. |
| `GET /v1/accounts/{id}/balances` | Read available/reserved/total | Primary database read; ownership required. |
| `POST /v1/transfers` | Execute internal transfer | Requires idempotency key and source ownership. |
| `GET /v1/transfers/{id}` | Retrieve outcome | Accessible to transfer participants with appropriately scoped fields. |
| `GET /v1/accounts/{id}/transactions` | List posted activity | Cursor pagination; optional bounded filters. |
| `POST /v1/admin/accounts/{id}/freeze` | Freeze account | Admin + 2FA + reason. |
| `POST /v1/admin/accounts/{id}/unfreeze` | Unfreeze account | Same controls. |
| `GET /v1/admin/audit-events` | Inspect audit trail | Restricted, paginated, and access-logged. |

Transfer request:

```json
{
  "sourceAccountId": "uuid",
  "destinationAccountId": "uuid",
  "currency": "USD",
  "amountMinor": "2500"
}
```

Return the transfer ID, state, currency, amount, correlation ID, and posting timestamp after commit. A returned balance is a snapshot and may change immediately.

Use explicit error codes such as `INSUFFICIENT_FUNDS`, `ACCOUNT_FROZEN`, `CURRENCY_MISMATCH`, and `IDEMPOTENCY_CONFLICT`. Do not expose destination ownership or account existence to unauthorized callers.

## 8. Component diagram description

```text
Browser / API Client
        |
        | HTTPS
        v
Freehold API — modular monolith
  ├── Auth
  ├── Account
  ├── Transfer ───────────────┐
  ├── Admin ─────────────────┤
  └── Ledger <───────────────┘
        |
        | Restricted posting functions; one transaction
        v
PostgreSQL — authoritative
  Users / Accounts / Transfers / Holds
  Ledger accounts / Journals / Entries
  Idempotency / Admin actions / Audit / Outbox
        ^
        |
Background Worker
  ├── Outbox dispatcher
  ├── Reconciliation
  ├── Audit export ──────────> Independent immutable storage
  └── Settlement orchestrator
               |
               v
       Settlement adapter boundary
         ├── Disabled MVP stub
         ├── Future fiat rail
         └── Future stablecoin adapter

API ───────────> Redis: sessions, challenges, rate limits
Worker <───────> Redis + BullMQ: background delivery
API / Worker ──> Secret manager and observability
```

The synchronous internal-transfer path ends at PostgreSQL. It does not pass through BullMQ or an external adapter.

## 9. Implementation order and major risks

### Suggested implementation order

1. **Define accounting invariants.** Finalize currency precision, ownership rules, freeze behavior, account classes, and sandbox funding treatment.
2. **Build the database foundation.** Implement schema, restricted roles, posting functions, immutable entries, deferred checks, and reconstruction queries.
3. **Prove posting correctness.** Test concurrent overspending, reversed lock order attempts, duplicate requests, mismatched currencies, empty/unbalanced journals, unauthorized writes, and rollback behavior.
4. **Add authentication and accounts.** Implement sessions, ownership checks, currency-account creation, and primary balance reads.
5. **Implement internal transfers.** Add durable idempotency, atomic audit/outbox writes, and cursor-based history.
6. **Add administration.** Freeze/unfreeze, mandatory admin 2FA, audit inspection, and controlled reversals.
7. **Add operational workers.** Reconciliation, outbox dispatch, duplicate-safe notifications, and audit export.
8. **Validate recovery.** Exercise lost responses, Redis outages, worker crashes, backup restoration, and database failover.
9. **Expose the disabled settlement contract.** Verify that core flows work with every adapter disabled.

### Major risks

| Risk | Consequence and mitigation |
|---|---|
| Incorrect accounting semantics | Balanced entries can still represent the wrong economic event. Review posting templates and sandbox funding independently. |
| Privilege bypass | Direct balance writes defeat application checks. Test database grants using actual runtime credentials. |
| Ledger/projection divergence | Displayed spendable funds become unreliable. Update atomically and reconcile against entries. |
| Hot-account contention | Institutional or high-volume accounts serialize postings. Measure lock waits; keep transactions short and postpone architectural expansion until needed. |
| Idempotency defects | Retries create duplicate transfers. Test concurrent duplicates and lost commit acknowledgments. |
| Administrative abuse | A controlled ledger can still be misused by its operators. Restrict commands and export evidence independently. |
| Recovery data loss | An acknowledged transfer can disappear after failover. Match replication and restore procedures to explicit durability targets. |
| External outcome ambiguity | Blind retries can duplicate settlement. Require stable operation IDs, lookup, reservations, and reconciliation before enabling adapters. |
| Regulatory scope expansion | Real custody changes the product’s obligations. Treat production funding and settlement as a separate launch gate. |
