# Scheduled transfers

Customers can schedule same-currency internal transfers. Every execution calls `execute_internal_transfer`. The scheduler does not write balances and does not reserve funds. No reserve feature exists. Available balance is tested at execution, under the same account lock as an immediate transfer.

## Data and role

Migration `012_phase6_operations.sql` stores the instruction and one execution row per due slot. The unique key is `(instruction_id, scheduled_for)`. A concurrent runner hits `ON CONFLICT DO NOTHING` and does not post twice.

`freehold_scheduler` may execute `scheduler_run_due(integer)` and `scheduler_record_heartbeat(uuid)`. Both reject any other `SESSION_USER` with `SCHEDULER_ROLE_REQUIRED` (`42501`). Inside the due-run the owner-defined transfer path runs as the ledger owner. The customer API cannot call either function. The worker cannot call them. A lock timeout, deadlock, serialization failure, or canceled query aborts that due-run. It does not push the instruction forward. Other errors still record `last_error` and delay the next attempt.

The idempotency key for a slot is `sched:{instruction_id}:{scheduled_for}`. A retry of the same slot returns the stored operation. The create path uses the caller's `Idempotency-Key` header for the instruction itself.

`src/scheduler.ts` polls `scheduler_run_due(25)` every `SCHEDULER_POLL_MS` (default 5000). It writes `scheduler_heartbeats` every 15 seconds. The pool sets `client_connection_check_interval` to 2 seconds so a dead client is noticed during a lock wait. It refuses to start when `DATABASE_URL` or `AUTH_DATABASE_URL` is set. Shutdown uses Nest's `useProcessExit: true` and a 20-second force exit. The Phase 7 process drill is preserved. A later drill is in `docs/phase7-worker-scheduler-reliability.md`.

## Calendar

All timestamps are UTC. The instruction timezone column must be `UTC`.

| Cadence | Rule |
|---|---|
| `ONCE` | One slot. On failure the slot retries up to 3 times, one hour apart, then `FAILED`. |
| `DAILY` | Next slot is plus one day. |
| `WEEKLY` | Next slot is plus seven days. |
| `MONTHLY` | Plus one calendar month. The day clamps to the last day of the short month and stays clamped. |

A failure on a recurring instruction advances the cadence. It does not burst-catch-up missed slots after downtime. The next slot is the first future slot, with a cap of 36 advances in one call.

Create requires the first slot to be more than 30 seconds ahead and less than two years ahead.

The Phase 6 controls test, run on a machine whose UTC date was 2026-11-12, started a monthly instruction at `2026-01-31T15:00:00Z` and observed the next future slot `2026-11-28T15:00:00.000Z`.

## Safety checks at execution

- The source account belongs to the instruction owner.
- Insufficient funds fail the slot. They do not create a negative available balance.
- Account freeze and `FINANCIAL_WRITES_SUSPENDED` apply. Suspension is raised when the idempotency row is claimed, before later control checks.
- Institutional and account transfer limits apply, including the customer controls in the same migration.
- A step-up requirement fails closed with `LIMIT_STEP_UP_REQUIRED` when the scheduler has no fresh second factor. The scheduler does not invent one.
- Cancellation is an update of the instruction in the same transaction that would claim the slot. A cancelled instruction does not post.

## Interface

The customer page is `/schedule`. Playwright confirmed the heading "Scheduled transfers" on the disposable stack. The test did not create or fire an instruction in the browser. Creation, cancellation, and the duplicate-runner case were exercised in `test/phase6-controls.mjs`, which passed.

## Out of scope

No external payment. No cross-currency instruction. No hold or reserve. No daylight-saving rule, because the only legal timezone is UTC.
