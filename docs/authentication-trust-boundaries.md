# Authentication trust boundaries

Phase 6 separates the process that creates a session from the process that posts financial operations. This is an engineering boundary on one machine. It is not an external identity provider, and it is not a claim that a compromised host is safe.

`sourceRevision` is `unknown`. This directory is not a git repository.

## Identities

| Identity | Holds | Must not hold | Database rights that matter |
|---|---|---|---|
| Auth process (`src/auth-server.ts`) | `AUTH_DATABASE_URL` as `freehold_auth` | `DATABASE_URL` | `auth_find_credentials`, `auth_bind_session`, `auth_revoke_session`, `register_user` |
| Financial API | `DATABASE_URL` as `freehold_api`, plus `AUTH_SERVICE_URL` and `AUTH_INTERNAL_TOKEN` | `AUTH_DATABASE_URL` | Financial functions and reads. Not `auth_bind_session` or `register_user`. |
| Worker | Worker database URL as `freehold_worker` | API and auth URLs | Outbox claim, complete, defer, heartbeat, reconcile. Not `execute_internal_transfer`. |
| Scheduler | `SCHEDULER_DATABASE_URL` as `freehold_scheduler` | `DATABASE_URL` and `AUTH_DATABASE_URL` | `scheduler_run_due` and `scheduler_record_heartbeat`. The due-run posts through the owner-defined transfer function. |
| Verifier | Verifier URL as `freehold_verifier` | Write credentials | Column-level `SELECT`. No function execute. |
| Migration | `MIGRATION_DATABASE_URL` | Not used by the API process | Applies checksummed SQL and sets the five runtime passwords. |
| Backup | `freehold_backup` when `BACKUP_DATABASE_PASSWORD` is set | API credential | Base backup in the WAL drill. Not a customer-transfer role. |

The financial API process refuses to start when `AUTH_DATABASE_URL` is set. The auth process refuses to start when `DATABASE_URL` is set. The scheduler process refuses to start when either of those is set. Startup checks require the exact grant list. An extra grant fails boot.

`freehold_api` must set the transaction-local GUC `freehold.session_secret` to the 64-hex secret the auth role stored. The check runs only when `SESSION_USER` is `freehold_api`. A missing or wrong secret is `SESSION_NOT_BOUND` (SQLSTATE `42501`, HTTP 403). Superuser sessions skip that check. `SET ROLE` does not change `SESSION_USER`. Migration 018 requires that secret for `auth_user_email` and for the two governance-failure audit functions. `auth_get_user` and `auth_lock_user` still return status, role, auth version, and whether TOTP is enrolled.

## What the split changes

The API can no longer open a database session as `freehold_auth` and insert a session proof for an arbitrary user. Login, registration, and revocation go to the auth process over HTTP. The auth process requires header `x-freehold-auth-token`. After a successful login the API still receives the session secret and stores it in Redis. Later financial calls present that secret.

Adversarial coverage is in `test/phase6-controls.mjs`. That file passed before the login rate-limit response was changed to a JSON body `{ "code": "LOGIN_RATE_LIMITED" }`. The suite re-run after that change is recorded in `docs/phase6-readiness.md`.

## What the split does not change

- A person who can read both environment files on the host can still use both credentials. The split is between processes, not between machines.
- Redis holds the session secret after login. Theft of that store lets the thief act as the bound user until revocation.
- The API role can `SELECT` across institutional rows. Row-level security was not enabled. Enabling it would make the verifier, which uses the same snapshot as a different role, see zero rows and report a mismatch. That is the wrong fix.
- A PostgreSQL superuser bypasses the session gate.
- The internal token does not replace the password. Anyone who has the token and a user's password can still call the auth service.
- The evidence content hash sits next to the data. It is not a signature. `signature` is null and custody is `REQUIRES_EXTERNAL_REVIEW`.
- Login throttling is 10 attempts per email hash in 300 seconds, counted in Redis, including the registration that first touches the key. The HTTP body is now JSON so the browser can show `LOGIN_RATE_LIMITED`. The auth server has a separate 100-attempt window.
- Session revocation is a database update plus deletion of the Redis key. A replica or a cache that has not observed the update is not a second source of truth. Financial calls re-check the bound secret inside the transaction.
- Capability provisioning (`governance_provision_capability`) is not dual-controlled. An operator who can update a user to `ADMIN` and call that function can grant institutional capabilities.
- The step-up window used by high-value transfers is a fixed recent-TOTP interval in the API. It is not a second factor evaluated inside PostgreSQL.

## Credential rotation

`scripts/migrate.mjs` sets the five runtime passwords only after the roles exist, and it sets `freehold_backup` only when `BACKUP_DATABASE_PASSWORD` is at least 32 characters. Rotation means generating new passwords outside the repository, applying them with the migration role, and restarting the matching process. The live Compose project was not rotated and was not migrated. Do not print the passwords. Examples in `.env.example`, `.env.auth.example`, `.env.scheduler.example`, and `.env.compose.example` are placeholders.

## Customer and operator sessions

Cookies are `freehold_session`, `SameSite=Strict`, path `/`. `COOKIE_SECURE` must be false only for the local HTTP drill. Production configuration requires an HTTPS origin and secure cookies. The Next.js proxy strips `x-forwarded-for`, `x-real-ip`, `x-freehold-client`, and `authorization`. The browser is not an authority for identity or for a transfer result. A lost response stays `UNKNOWN` until the same idempotency key returns a stored body.
