# Production posture

For current production acceptance requirements and the environment-bound gate, see [Production release gate](production-release-gate.md). Historical measurements below describe their original runs.

Freehold is not a bank and this workspace is not a production deployment. `NODE_ENV=production` is a boot gate. It is not a charter, a license, or a `READY` result.

## What the process refuses

`src/config/production-posture.ts` runs in the API, auth, worker, and scheduler processes when `NODE_ENV=production`:

- `DEMO_MODE`, `DEMO_BOOTSTRAP_TOKEN`, and `DEMO_USER_PASSWORD` are refused.
- The process may hold only its own database URL. The API holds `DATABASE_URL` as `freehold_api`. Auth holds `AUTH_DATABASE_URL` as `freehold_auth`. The worker and scheduler follow the same rule.
- The database URL must include a password of at least 16 characters and `sslmode=verify-full`.
- The API and auth process require a Redis password of at least 16 characters.
- The API still requires an `https://` origin and secure cookies.
- After the privilege check, the process calls `freehold.runtime_posture()`. Startup fails if `sandboxEnabled` or `demoEnabled` is anything other than false.

`/health` returns `live` when the process can answer. `/ready` returns `accepting` when PostgreSQL answers and, in production, the posture flags are false. Both responses use `unavailable` or an HTTP error when they cannot. Neither response is a deployment certificate. Worker and scheduler logs say `STARTED`.

The auth login limiter and the API login limiter both stop at 10 attempts in five minutes. They use different Redis keys.

## Deployment checks

Run `npm run check:production` from the release tree using the target environment inputs described in [Production release gate](production-release-gate.md). It requires actual readiness content over HTTPS, a valid recent encrypted offsite backup manifest, independent ledger verification, and reviewed operational evidence bound to the environment and clean commit. Missing evidence stays incomplete.

`scripts/production-rehearsal.sh` creates disposable TLS PostgreSQL and password-protected Redis instances, applies the current migration inventory, and boots the application services with production settings. Its local-only backup deliberately prevents production acceptance. This does not connect to a persistent Compose project.

## Local sandbox

Use [local deployment](local-deployment.md) for isolated development. Demo funding is a simulation. It is not an external asset, deposit, or custody. Local credentials are generated into private ignored files. The local stack does not configure production TLS, independent backup storage, or monitoring.
