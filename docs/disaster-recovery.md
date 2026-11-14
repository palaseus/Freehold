# Freehold backup and disaster recovery

## Durable state and reconstruction

The PostgreSQL database is the durable system of record. A recovery backup must include:

- Immutable journal and entry records, seals, ledger account chart, account identity/status, currencies, and holds.
- Transfers, idempotency request keys/payload hashes/durable responses, admin actions, and audit log.
- Outbox events and worker inbox/lease/attempt/acknowledgment state.
- Authentication and user records required for ownership and authorization (protect the backup as sensitive data).
- Schema objects and `freehold_deploy.migrations` checksums/version metadata.

Account `available_minor` and `reserved_minor` are reconstructible projections of journal lines and holds, but they must be restored as found and independently verified. Freehold does not auto-repair a discrepancy. A discrepancy stops reopening writes pending an authorized investigation. Redis sessions and throttling state are ephemeral; after recovery, require reauthentication and treat old sessions as revoked. The database migration runner, API/worker/verifier passwords, TOTP encryption key, demo flags, cookie/origin configuration, and deployment settings are not safely recovered from SQL data: re-provision them from the secret/configuration manager. Never place plaintext runtime secrets in an unencrypted database dump.

## Demonstrated backup/restore exercise

Run the fully disposable drill:

```bash
./scripts/recovery-drill.sh
```

It creates a source PostgreSQL 16 container and a separate fresh restore cluster, applies migrations, creates only synthetic accounts and posting-function transactions, tests process/worker/reconciliation interruptions, dumps the source database with `pg_dump -Fc`, damages a copy and confirms `pg_restore --list` rejects it, bootstraps passwordless role definitions, restores into a new database, injects independent runtime secrets, verifies the restored ledger, and retries a committed transfer with its original key and payload. It destroys only containers it created and its temporary dump directory. Do not adapt this test command to a persistent database.

The equivalent low-level dump and restore steps, only for disposable databases, are:

```bash
docker exec <source-container> pg_dump -U postgres -d <disposable-source-db> -Fc > ledger.pgdump
docker exec -i <fresh-restore-container> pg_restore -U postgres -d <disposable-restore-db> --exit-on-error < ledger.pgdump
```

Before restore in a genuinely fresh cluster, provision reviewed passwordless roles using `scripts/restore-runtime-roles.sql`, create the destination database, restore, then set independent API/worker/verifier credentials using the privileged deployment secret flow. The tested drill provisions these via `scripts/provision-restored-credentials.mjs`. The role SQL contains no passwords. For cross-cluster disaster recovery, also recreate deployment/admin roles and grants under change control; a database dump does not contain a complete secret-management or cluster configuration backup.

The verifier should run before any financial writes are reopened. Reauthenticate users after Redis loss. Restart the worker only after validating database state and network/dependency configuration; its durable lease semantics allow an expired PROCESSING event to be reclaimed. Duplicate deliveries must remain idempotent. Do not manually delete inbox/outbox rows to “clear” a backlog.

## Snapshot and WAL options

`pg_dump` produces a consistent logical snapshot of one database while ordinary transactions continue. It does not provide continuous recovery, cluster-wide role/password backup, WAL archiving, or PITR. Freehold's local Compose setup does not configure WAL archiving, synchronous replication, automated off-site backup, or measured production failover. A successful logical restore is not a zero-loss guarantee.

For a deployment requiring point-in-time recovery, configure PostgreSQL base backups plus continuous WAL archiving to a separate encrypted, access-controlled failure domain. Test recovery to explicit target timestamps/LSNs, including required role provisioning, migration metadata, retention, and key availability. If acknowledged commits must survive primary loss without loss, synchronous replication and its quorum/failure behavior must be selected and tested. Do not claim that guarantee from the current single-primary Compose deployment.

## Recovery targets and write reopening

No production RPO or RTO is currently established. Until backup cadence, WAL retention, replica/failover behavior, and restore performance are measured in the intended deployment, the operational RPO/RTO are **unknown**. The local Phase 4 drill observed a 2,058 ms `pg_restore` command and a 17,454 ms complete synthetic exercise; neither is a production target.

Before reopening writes, operators must verify:

1. Correct database/cluster and target recovery time; no split-brain writer remains.
2. Required schema migration version/checksums and runtime roles/grants.
3. Independent verifier outcome is VERIFIED; MISMATCH, INCOMPLETE, or ERROR keeps writes closed pending investigation.
4. Idempotency and outbox/inbox state are present and worker recovery is understood; replay the same key/payload for ambiguous client operations.
5. Redis/session policy, API/worker/verifier secrets, TLS/ingress, and monitoring are re-established.
6. Authorized operations/accounting owners approve restart and record the decision externally.

No automatic balance repair is implemented. Migration 008 adds a durable PostgreSQL financial-write suspension control: an authorized `EMERGENCY_CONTROL` principal may suspend new writes, and resumption requires an independent `INSTITUTION_ADMIN` approval and execution. Its behavior and limitations are documented in [emergency-controls.md](emergency-controls.md). If the database control is unavailable, use approved deployment/network containment while preserving evidence. Resume only after independently verified recovery and explicit authorization. A stale/corrupt projection is not a reason to edit a balance by hand.

## Investigation procedure

Preserve the verifier JSON, database snapshot/recovery point, migration checksums, relevant journal/operation IDs, worker logs, and deployment events in restricted append-only storage. Re-run verification against the same restored point if needed. Compare each affected operation's idempotency record, journal, entry lines, ledger-account mapping, transfer/hold relationship, audit, and outbox event. Escalate unexplained missing/extra entries, unbalanced currency totals, altered immutable records, identity mismatch, or incomplete verification to the designated accounting and database owners. Do not discard unexplained records or write compensating entries without separately reviewed accounting authorization.
