# Freehold

A PostgreSQL-authoritative financial ledger with a NestJS/Fastify API and a Next.js interface. PostgreSQL enforces double-entry posting, immutable journals, account ownership, and durable idempotency. Financial amounts use integer minor units.

**Status:** initial development release, suitable for local evaluation. Production acceptance is incomplete. Demo funding and institutional/network features are simulations; no external settlement, custody, deposit insurance, or live token issuance is provided.

## Run locally

Requirements: Node.js 22 or newer, Docker Engine, and the current Docker Compose plugin (`docker compose`).

```sh
git clone <your-repository-url>
cd Freehold
bash scripts/local-deploy.sh
```

Open **http://localhost:3100**. The isolated `freehold-local` project builds both images, applies migrations to a new persistent database, starts auth/API/worker/scheduler/web services, and seeds demo accounts through the API. It generates unique local credentials in the gitignored `tmp/local-deployment/` directory.

Sign in as `alex@freehold.demo` or `sam@freehold.demo` using the password in `tmp/local-deployment/accounts.json`. The operator account requires the authenticator secret in that same private file. Never commit or share these files. The local stack uses HTTP and development settings.

See [local deployment](docs/local-deployment.md) for ports, persistent volumes, and stop/restart commands. Avoid applying the base Compose definition to an existing database without a backup and migration plan.

## Development and verification

```sh
npm ci
npm ci --prefix web
npm run check:release
npm run check:migrations
npm test
npm test --prefix web
npm run build --prefix web
```

`npm test` builds the backend and creates disposable PostgreSQL/Redis containers for invariant, authorization, idempotency, verifier, and migration tests. It requires a running Docker daemon. Web tests run without a database. CI also runs browser, encrypted backup, scheduler lifecycle, production boot, and point-in-time recovery rehearsals. A workflow definition is not a hosted CI result.

## Architecture

```text
Browser → Next.js HTTP proxy → NestJS authorization/validation
                                      ↓
                          Restricted PostgreSQL functions
                                      ↓
                  Journals, projections, idempotency, audit, outbox

Auth → Redis sessions, Argon2id, TOTP
Worker → durable outbox/inbox and reconciliation
Scheduler → restricted scheduled-transfer functions
Verifier → independently recomputes accounting invariants
```

The browser and Next.js process have no database credentials. Runtime API, auth, worker, scheduler, migration, and verifier identities have separate database privileges. Application code orchestrates posting; PostgreSQL decides and commits financial outcomes. Do not edit applied migrations or repair balances with application-side arithmetic.

| Path | Contents |
| --- | --- |
| `src/` | API, authentication, worker, scheduler, and database integration |
| `web/` | Next.js interface, HTTP proxy, and browser tests |
| `db/migrations/` | Forward-only schema and financial functions |
| `scripts/` | Migration, verification, recovery, and deployment tooling |
| `test/` | Backend regression and integration tests |
| `docs/` | Current operational and security documentation |

See [architecture](architecture.md), [database boundaries](docs/database-trust-boundaries.md), [authentication boundaries](docs/authentication-trust-boundaries.md), and [frontend architecture](web/ARCHITECTURE.md).

## Production and security

Follow the [production release gate](docs/production-release-gate.md) before deployment. `npm run check:production` requires target-environment measurements, HTTPS readiness, encrypted independent backups, and reviewed evidence for secrets, recovery, monitoring, and staging. Local success does not certify production readiness.

Read [SECURITY.md](SECURITY.md) before reporting vulnerabilities. Generated reports, local secrets, development drafts, and historical evidence are excluded from this initial publication. Tests regenerate their own evidence; no historical report is represented as a current acceptance result.

## Rights

Copyright © 2026 Freehold. **All rights reserved.** This is proprietary source, not an open-source license. See [LICENSE](LICENSE). Both npm packages are private and marked `UNLICENSED`. Third-party dependencies retain their own licenses.
