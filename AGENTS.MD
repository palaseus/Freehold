# Freehold — Codex Project Instructions

## Mission
Build Freehold as a secure, independently verifiable, PostgreSQL-authoritative digital financial ledger. Prioritize financial correctness, security, reliability, maintainability, and operational resilience over feature velocity.

## Architecture
- Backend: NestJS, Fastify, TypeScript.
- Frontend: Next.js App Router.
- Database: PostgreSQL, immutable double-entry ledger.
- Authentication: Argon2id, Redis sessions, TOTP.
- Background processing: durable outbox/inbox worker.
- Financial arithmetic: integer minor units only.
- PostgreSQL is the sole authority for financial state.

## Non-Negotiable Rules
1. Never calculate or modify authoritative balances in application code.
2. Never bypass restricted PostgreSQL posting functions.
3. Preserve atomicity, double-entry invariants, idempotency, and immutable journal records.
4. Never use floating-point arithmetic for money.
5. Keep API, worker, and migration database privileges separated.
6. Never trust browser-provided identity, permissions, or financial outcomes.
7. Treat unknown transaction outcomes as UNKNOWN until authoritatively resolved.
8. Never alter existing financial semantics silently.
9. Use forward-only migrations; preserve existing data.
10. Never weaken security controls simply to make tests pass.

## Engineering Standards
- Inspect existing implementation before modifying it.
- Prefer focused, maintainable changes over broad rewrites.
- Follow established project conventions.
- Avoid unnecessary dependencies or infrastructure.
- Validate inputs at trust boundaries.
- Make failure states explicit and observable.
- Preserve compatibility unless changes are justified.
- Write regression tests for every bug and security fix.
- Independently verify financial invariants wherever practical.

## Testing
Run relevant checks after changes:

- `npm test`
- `npm run build`
- `npm --prefix web test`
- `npm --prefix web run build`
- PostgreSQL invariant and integration tests where applicable.

Use disposable databases for destructive, corruption, and adversarial tests. Never corrupt persistent application data.

Report actual test outcomes. Never claim tests passed unless executed successfully.

## Security
- Follow least-privilege principles.
- Never expose secrets or credentials.
- Assume API credentials remain a sensitive trust boundary.
- Preserve authorization checks independently of frontend controls.
- Treat fabricated reconciliation results, identity forgery, ledger corruption, and duplicate financial operations as critical risks.

## Autonomous Execution
- Complete assigned tasks end-to-end where practical.
- Make routine implementation decisions independently.
- Investigate and resolve encountered defects.
- Do not stop after planning when implementation was requested.
- Do not invent results or conceal failures.
- Ask before performing destructive operations on persistent data.
- Document unresolved risks and blockers.

## Documentation
Maintain accurate README and architecture documentation. Update relevant files in `docs/` when behavior, guarantees, or security assumptions change.

## Final Reporting
After completing a task, summarize:
- Changes implemented.
- Files modified.
- Tests executed and results.
- Remaining risks or limitations.
- Recommended next milestone.

**Core principle:** Financial correctness must be enforced by architecture, demonstrated by tests, and independently verifiable. A passing build is not proof of financial integrity.
