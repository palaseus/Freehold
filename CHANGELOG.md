# Changelog

## 0.1.0 — Initial development release

Prepared for first GitHub publication. This is not a production acceptance or authorization for live financial services.

- PostgreSQL-authoritative double-entry ledger with immutable journals and integer minor-unit accounting.
- Authenticated NestJS/Fastify API, Redis sessions, Argon2id, TOTP, ownership checks, and separate runtime roles.
- Next.js account, transfer, activity, statement, administrative, and simulated institutional interfaces.
- Durable outbox/inbox processing, scheduled transfers, reconciliation, and an independent ledger verifier.
- Forward-only migrations through 034, disposable integration/browser testing, encrypted backup and PITR rehearsals.
- Isolated local sandbox deployment with generated private credentials and persistent volumes.
- Environment-bound production checks; actual production readiness remains incomplete.

All rights reserved. No license to use or redistribute this source is granted.
