# Database trust boundaries

## Runtime identities

| Identity | Intended holder | Allowed authority | Explicitly excluded |
|---|---|---|---|
| `freehold_api` | NestJS API process only | Execute the allowlisted functions. Direct table `SELECT` is `currencies` only after migration 014. Customer and institutional reads go through those functions. | Worker inbox/outbox operations, reconciliation writes, direct table/sequence mutation, schema ownership, other customers' rows without a bound owner or an institutional capability |
| `freehold_worker` | Worker process only | Claim and acknowledge durable events; invoke database-computed reconciliation | Account creation, funding, transfers, hold changes, admin mutations, arbitrary report input, direct table/sequence mutation |
| `freehold_verifier` | Standalone verification command only | Read reviewed journal, operation, projection, hold, event, and migration metadata; no function execution | All table mutation, sequence use, financial/worker function execution, password/TOTP fields, report writes |
| Deployment identity | One-off migration process/operator | Own/apply schema migrations and provision runtime passwords | Runtime API, worker, or verifier process |

Migration 006 revokes legacy runtime grants, removes the runtime login's membership in the old function role, applies restrictive default privileges, and applies explicit function/table grants. Startup assertions check the connected login, role attributes and memberships, table rights, sequences, and executable function allowlist. These checks fail closed when the catalog differs from the reviewed matrix.

## Actor identity trust

Migration 011 requires `freehold_api` to set the transaction-local GUC `freehold.session_secret` before a gated function runs. `freehold_auth` stores the hash of that secret. `_require_bound_session` checks that `SESSION_USER` is `freehold_api`, that the secret matches the actor, and that the user is active at the current auth version. A superuser skips the check. `SET ROLE` does not change `SESSION_USER`.

Migration 018 applies that check to three functions that were still executable by `freehold_api` with only a caller-supplied UUID:

- `auth_user_email` returns an email only for the user bound to the secret.
- `governance_record_authorization_failure` and `governance_record_execution_failure` insert audit rows only for that bound actor.

The session endpoint and the admin-denial audit path set the secret in their own transaction. A financial transaction that rolls back sets it again before writing the failure audit.

`auth_get_user` and `auth_lock_user` still return status, role, auth version, and whether TOTP is enrolled, without the secret. The session guard uses them to load the principal before the financial transaction. They do not return email, password, or TOTP material.

Migration 019 adds `runtime_posture()`, which returns `sandboxEnabled` and `demoEnabled` and nothing else. `freehold_api`, `freehold_worker`, `freehold_auth`, and `freehold_scheduler` can execute it. The verifier cannot. A process started with `NODE_ENV=production` reads it after the privilege check and exits if either flag is true. Sandbox funding remains a ledger liability and sandbox equity, not an external asset.

The remaining trust is:

1. Browser input is untrusted. The browser cannot choose an actor ID for financial operations.
2. The API pairs the Redis session's user ID with the secret created by `freehold_auth`. A mismatched pair is `SESSION_NOT_BOUND`.
3. Theft of the Redis session secret lets the thief act as that user until revocation.
4. `freehold_worker` can run event lifecycle functions and cannot execute customer posting functions.
5. The deployment identity and a PostgreSQL superuser remain outside the session gate.
6. Row-level security is off. Institutional functions that already checked the bound session can read across customers when the caller holds the required capability.

## Reconciliation provenance

Only `freehold_worker` can execute `worker_reconcile_and_record()`. It supplies no outcome, counts, timestamp, or execution identifier. The database computes the current reconciliation result and writes its durable report in the same function transaction, generating the execution ID and timestamp. The API can read authorized report data but cannot create/update reports. A mismatch is recorded and does not mutate account projections or ledger entries.

## Deployment operations

Compose starts the migration job with the deployment URL and independent API/worker/verifier passwords. The API container receives only `DATABASE_URL` for `freehold_api`; the worker receives only `WORKER_DATABASE_URL` for `freehold_worker`; `VERIFY_DATABASE_URL` is provided only for an explicit verifier run. The migration service alone receives the deployment URL. Do not put the deployment URL in runtime services. Runtime passwords must be independently generated and rotated through the deployment process. Migrations 006 and 007 have no automatic down migration: security grants should not be silently restored during rollback.

Run the disposable integration suite and independent verifier to validate these boundaries; see [production release gate](production-release-gate.md) for deployment acceptance requirements.
