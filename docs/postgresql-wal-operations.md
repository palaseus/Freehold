# PostgreSQL WAL operations

Measurement file: `docs/evidence/phase6-wal.json`.

Generated `2026-11-12T13:51:37.786Z`. Content SHA-256 `677d92bed377767d38441973683d1f6ac0eb46a2e6482a6ee14cfd80a62ae924`. The hash covers every field except `contentSha256`. `signature` is null. `sourceRevision` is `unknown`.

`offsiteCopy` is false. `automaticFailover` is false. `localMeasurement` is true. `productionRpoRto` is `not claimed`. These timings are a disposable drill on one machine. They are not a production recovery objective.

The running Compose database still has `archive_mode` off and a single `postgres-data` volume. `compose.wal.yaml` is a definition for a later approved deploy. It was not applied. Do not point a backup at the only data volume.

## Topology that was actually tested

Disposable PostgreSQL 16. `archive_mode` on, `archive_timeout` 60 seconds, `max_wal_senders` 4. `archive_command` was not passed on the postmaster command line, because that setting outranks `ALTER SYSTEM`. After the server accepted connections, the drill set:

```text
archive_command = 'test ! -f /wal/%f && cp %p /wal/%f'
```

and reloaded. An empty `archive_command` with `archive_mode` on pauses archiving. A command that fails increments `pg_stat_archiver.failed_count` after `pg_switch_wal()`.

`/wal` and `/backup` were separate host directories, mounted into the container, not the data directory. `scripts/backup-base.sh` refuses a destination of `/var/lib/postgresql/data` or `/`. The backup role was `freehold_backup`. Archive files are created as the postgres user, mode 0600. The drill ran `chmod a+rX` on `/backup` and `/wal` before the host read them. That permission change is part of this local drill. It is not a production archive ACL.

## Measured results

| Step | Result |
|---|---|
| Base backup | 51868 ms, SHA-256 `23ebf2c1ef3339124e3a697562b58955cd5afdf8f2102a1bba0621d0fd349280`, `backupVerified` true |
| Crash recovery of the killed primary | 3041 ms |
| Point-in-time restore | 2959 ms |
| Full drill | 80934 ms |
| Data-directory backup | Refused |
| Copy of a WAL segment, corrupted | `pg_waldump` failed. The good archive file was not overwritten. |
| Truncated base backup | Rejected |
| Invalid recovery target LSN | Rejected |
| Archive destination removed | `failed_count` moved from 0 to 1 |
| Retention | A 10-day-old file was removed. The newest file was kept. |
| Disk check | Passed at a 1-byte minimum on the scratch WAL path (80874340352 bytes free). Exited 1 when the minimum was impossible. The scratch path is gone. |
| Uncommitted transfer, backend terminated | Rolled back. Retry of the same key completed once. |
| Worker killed during a lease, second worker | Pending drained to 0. Duplicate journals 0. |
| Redis restart | Journal count unchanged at 4 |

Recovery boundary: `2026-11-12T13:51:16.975Z`, LSN `0/4000000`. Journals before B: 3. Journals after B: 5.

| Database | Verification | Journals | Notes |
|---|---|---|---|
| Restarted primary after crash | VERIFIED in 86 ms | 82 | Includes crash-loop commits. Not the PITR target. Unbalanced journals 0. |
| Promoted PITR target | VERIFIED in 84 ms | 4 | Transfer A present (`countA` 1). Transfer B absent (`countB` 0). Governance status `EXECUTED`. Replay status `EXECUTED`. |
| Same target after a deliberate projection edit | MISMATCH | — | `projectionDiscrepancies` 2. Phase 5's PITR mismatch recorded 1. Do not collapse these. |

B is absent because it committed after the boundary. Inclusive time recovery stops before the first commit strictly after the target. `recovery_target_time` rejects a trailing `Z`. Write `YYYY-MM-DD HH:MM:SS.mmm+00`. The restored server's `postgresql.auto.conf` turns `archive_mode` off so a restored copy does not archive into the original directory.

## Restore outline

Use this only on a new data directory. Do not restore over `freehold-postgres-1`.

1. Stop the server that owns the target data directory.
2. Unpack the verified base backup into an empty directory. Confirm the backup SHA-256 before unpacking.
3. Place only the WAL segments needed for the target into the restore directory. Do not delete the only good copy while testing a corrupt file.
4. Set `restore_command` to copy from that directory. Set `recovery_target_time` or `recovery_target_lsn` in the timestamp form above. Set `recovery_target_action` to `promote` when the drill should open the server for reads.
5. Start PostgreSQL. Confirm transfer presence with SQL, then run `scripts/verify-ledger.mjs` as `freehold_verifier`.
6. Treat governance replay as a read of the stored `EXECUTED` result. Do not submit a second approval to "finish" an already executed request.
7. Application sessions in Redis are not inside the base backup. After a restore, discard Redis session state or accept that a session secret may not match the restored session row. The drill restarted Redis and the journal count stayed 4.

Backup failure is visible as a rising `pg_stat_archiver.failed_count` and as a non-zero exit from the base-backup script. The operations console does not read this file. It shows backup health as `UNAVAILABLE` until a future store records it. That display is correct for the database that was asked.

## Still true after this drill

There is no off-site copy. Disk loss on this machine loses the primary and the local archive together. There is no automatic failover. The live Compose volume was not archived. Phase 5 PITR (`docs/evidence/phase5-pitr.json`, backup 47850 ms, algorithm 1.2.0) is an earlier drill, not this one.
