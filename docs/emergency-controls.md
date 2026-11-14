# Emergency financial-write controls

## Suspend

An active `ADMIN` with recent TOTP and `EMERGENCY_CONTROL` may call `POST /v1/admin/governance/suspend-writes` with a non-empty reason. The API calls a restricted PostgreSQL security-definer function. PostgreSQL serializes the change on `institutional_control` and records actor, reason, timestamp, and outcome.

All ordinary financial posting functions create their durable idempotency request before changing the ledger. The migration adds a `BEFORE INSERT` trigger on that table. A new operation obtains `FOR SHARE` on the control row and is rejected while suspension is active. The suspender's row update takes an exclusive lock, so it waits for transactions already past the gate to finish. Once the suspension transaction commits, later new operations fail. This provides a database-local linearization point without blocking ordinary transfers except briefly while control status is read.

An already committed idempotency key may still be replayed to retrieve its durable result during suspension. No committed ledger operation is reversed. Operations that were still in progress before suspension either commit fully before suspension takes effect or roll back under the original transaction rules.

## Resume

Resume is not a toggle. An `EMERGENCY_CONTROL` principal creates an immutable `RESUME_WRITES` approval request with recovery evidence as its reason. A separate active `INSTITUTION_ADMIN` approves and an `INSTITUTION_ADMIN` executes. The approval, initiating capability, executor capability, status, expiry, and control row are checked/changed atomically. Rejected, cancelled, expired, or revoked requests cannot resume writes.

The UI displays the last authoritative suspension state. If its API response is lost, operators must reload governance status and inspect durable request/audit state before attempting a new request.

## Verification after an incident

1. Keep financial writes suspended when a material ledger integrity issue or unexplained privileged action is suspected.
2. Preserve PostgreSQL logs, WAL, backups, migration metadata, and governance audit records before intervention.
3. Run the independent ledger verifier against a consistent read-only snapshot and export its machine-readable report.
4. Identify affected operation IDs, journal IDs, account IDs, idempotency keys, and related audit/outbox events. Avoid copying personal data unnecessarily.
5. Compare application and database logs, privilege changes, capability grants/revocations, backup/restore history, and independent external evidence where available.
6. Do not edit balances, delete unexplained journal rows, or rewrite a committed operation. Escalate anomalies to the designated accounting and security reviewers.
7. Resume only after evidence is reviewed, affected access is contained, the ledger verifier passes, any mismatch is explained through authorized immutable compensating accounting, and the independent institutional approval is recorded.

## Limits

The control is not a defense against PostgreSQL superusers, database owners, compromised migration credentials, or operators who can disable triggers or modify the schema. It does not stop non-ledger activity such as worker acknowledgments or reads. It does not cancel an already-running transaction; the exclusive control-row update waits for such transactions. A stuck transaction can delay suspension, and the configured database lock timeout can cause the suspension request to fail visibly rather than claim success.
