#!/usr/bin/env bash
# Disposable WAL archive, base backup, and recovery. Own containers only.
# Evidence goes to docs/evidence/phase6-wal.json. Phase 5 evidence is not overwritten.
# Local scratch disks are not an off-site copy, and this does not claim a production RPO or RTO.
set -euo pipefail
cd "$(dirname "$0")/.."
node --input-type=module -e 'import { refuseEvidenceOverwrite } from "./scripts/lib/evidence-output.mjs"; refuseEvidenceOverwrite("docs/evidence/phase6-wal.json");'
container="freehold-wal6-$$"
restore_container="${container}-restore"
bad_container="${container}-bad"
redis_container="${container}-redis"
worker_pid=""
scratch=$(mktemp -d)
mkdir -p "$scratch/wal" "$scratch/backup" "$scratch/restore" "$scratch/bad" "$scratch/retain"
chmod 777 "$scratch/wal" "$scratch/backup" "$scratch/restore" "$scratch/bad" "$scratch/retain"
cleanup() {
  if [ -n "$worker_pid" ]; then kill -9 "$worker_pid" >/dev/null 2>&1 || true; fi
  docker rm -f -v "$container" "$restore_container" "$bad_container" "$redis_container" >/dev/null 2>&1 || true
  if [ -d "$scratch" ]; then
    docker run --rm -v "$scratch:/scratch" postgres:16 rm -rf /scratch/restore /scratch/bad /scratch/backup /scratch/wal /scratch/retain >/dev/null 2>&1 || true
    rm -rf "$scratch" || true
  fi
}
trap cleanup EXIT
started=$(date +%s%3N)
pg_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
api_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
worker_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
verifier_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
auth_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
scheduler_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
backup_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
docker run --name "$container" -d -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD="$pg_password" -e POSTGRES_DB=freehold_wal6_disposable \
  -v "$scratch/wal:/wal" -v "$scratch/backup:/backup" \
  postgres:16 \
  -c wal_level=replica -c archive_mode=on \
  -c archive_timeout=60 -c max_wal_senders=4 >/dev/null
docker run --name "$redis_container" -d -p 127.0.0.1::6379 redis:7-alpine >/dev/null
for attempt in $(seq 1 100); do
  if docker exec "$container" psql -h 127.0.0.1 -U postgres -d freehold_wal6_disposable -X -Atc 'SELECT 1' >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 100 ]; then echo 'WAL drill database failed to start' >&2; docker logs "$container" >&2; exit 1; fi
  sleep 0.2
done
address=$(docker port "$container" 5432/tcp)
# archive_command is SIGHUP. A command-line -c value would outrank ALTER SYSTEM, so the
# drill sets it here and can later point it at a missing directory without a restart.
docker exec "$container" psql -U postgres -d freehold_wal6_disposable -X -c "ALTER SYSTEM SET archive_command = 'test ! -f /wal/%f && cp %p /wal/%f'" >/dev/null
docker exec "$container" psql -U postgres -d freehold_wal6_disposable -X -c 'SELECT pg_reload_conf()' >/dev/null
export API_DATABASE_PASSWORD="$api_password" WORKER_DATABASE_PASSWORD="$worker_password"
export VERIFIER_DATABASE_PASSWORD="$verifier_password" AUTH_DATABASE_PASSWORD="$auth_password"
export SCHEDULER_DATABASE_PASSWORD="$scheduler_password" BACKUP_DATABASE_PASSWORD="$backup_password"
export MIGRATION_DATABASE_URL="postgresql://postgres:${pg_password}@${address}/freehold_wal6_disposable"
export DEMO_MODE=false DEMO_BOOTSTRAP_TOKEN=''
node scripts/migrate.mjs
export PITR_STATE="$scratch/state.json" PITR_ADMIN_URL="$MIGRATION_DATABASE_URL"
node scripts/pitr-drill.mjs setup
# Kill the database session after the transfer statement and before commit.
node --input-type=module <<'EOF'
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const state = JSON.parse(readFileSync(process.env.PITR_STATE, 'utf8'));
const admin = new pg.Client({ connectionString: process.env.PITR_ADMIN_URL });
const holder = new pg.Client({ connectionString: process.env.PITR_ADMIN_URL });
await admin.connect();
await holder.connect();
const key = `wal6-interrupt-${randomUUID()}`;
await holder.query('BEGIN');
await holder.query('SELECT freehold.execute_internal_transfer($1,$2,$3,$4,2,$5,$6)', [state.actor, state.source, state.destination, 'USD', key, randomUUID()]);
const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
const sleeping = holder.query('SELECT pg_sleep(30)');
sleeping.catch(() => {});
await admin.query('SELECT pg_terminate_backend($1::int)', [pid]);
await sleeping.catch(() => {});
await holder.end().catch(() => {});
const retry = (await admin.query('SELECT freehold.execute_internal_transfer($1,$2,$3,$4,2,$5,$6) AS result', [state.actor, state.source, state.destination, 'USD', key, randomUUID()])).rows[0].result;
const journals = (await admin.query('SELECT count(*)::int AS n FROM freehold.ledger_journals j JOIN freehold.idempotency_requests r ON r.operation_id=j.operation_id WHERE r.key=$1', [key])).rows[0].n;
await admin.end();
if (retry.state !== 'COMPLETED' || journals !== 1) {
  process.stderr.write(`session interrupt retry ${retry.state} journals ${journals}\n`);
  process.exit(1);
}
process.stdout.write('PASS session interrupted before commit and retried once\n');
EOF
if BACKUP_CONTAINER="$container" BACKUP_DEST_IN_CONTAINER=/var/lib/postgresql/data BACKUP_DATABASE_PASSWORD="$backup_password" bash scripts/backup-base.sh >/dev/null 2>&1; then
  echo 'backup-base accepted the data directory' >&2
  exit 1
fi
echo 'PASS backup-base refused the data directory'
backup_started=$(date +%s%3N)
BACKUP_CONTAINER="$container" BACKUP_DEST_IN_CONTAINER=/backup BACKUP_DATABASE_PASSWORD="$backup_password" bash scripts/backup-base.sh
docker exec "$container" chmod -R a+rX /backup
backup_ms=$(( $(date +%s%3N) - backup_started ))
test -s "$scratch/backup/base.tar.gz"
verify_line=$(bash scripts/backup-verify.sh "$scratch/backup/base.tar.gz")
echo "$verify_line"
node scripts/pitr-drill.mjs mark
sleep 1
node scripts/pitr-drill.mjs post-b
for attempt in $(seq 1 50); do
  if find "$scratch/wal" -type f | grep -q .; then break; fi
  if [ "$attempt" -eq 50 ]; then echo 'No WAL segment was archived' >&2; exit 1; fi
  sleep 0.2
done
activity_pid=''
node -e 'const {Client}=require("pg"); const fs=require("node:fs"); const {randomUUID}=require("node:crypto"); const s=JSON.parse(fs.readFileSync(process.env.PITR_STATE,"utf8")); const c=new Client({connectionString:process.env.PITR_ADMIN_URL}); c.on("error",()=>{}); (async()=>{await c.connect(); for(let i=0;i<200;i+=1){ try { await c.query("SELECT freehold.execute_internal_transfer($1,$2,$3,$4,1,$5,$6)",[s.actor,s.source,s.destination,"USD","wal6-crash-"+randomUUID(),randomUUID()]); } catch { break; } }})().catch(()=>{});' &
activity_pid=$!
sleep 0.5
docker kill --signal KILL "$container" >/dev/null
wait "$activity_pid" || true
crash_started=$(date +%s%3N)
docker start "$container" >/dev/null
for attempt in $(seq 1 100); do
  if docker exec "$container" psql -h 127.0.0.1 -U postgres -d freehold_wal6_disposable -X -Atc 'SELECT 1' >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 100 ]; then echo 'PostgreSQL did not recover after kill' >&2; docker logs "$container" >&2; exit 1; fi
  sleep 0.2
done
address=$(docker port "$container" 5432/tcp)
export PITR_ADMIN_URL="postgresql://postgres:${pg_password}@${address}/freehold_wal6_disposable"
export VERIFY_DATABASE_URL="postgresql://freehold_verifier:${verifier_password}@${address}/freehold_wal6_disposable"
for attempt in $(seq 1 100); do
  if node --input-type=module -e 'import pg from "pg"; const c=new pg.Client({connectionString:process.env.PITR_ADMIN_URL,connectionTimeoutMillis:1000}); await c.connect(); await c.query("SELECT 1"); await c.end();' >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 100 ]; then echo 'PostgreSQL did not accept host connections after crash recovery' >&2; exit 1; fi
  sleep 0.2
done
crash_ms=$(( $(date +%s%3N) - crash_started ))
node scripts/pitr-drill.mjs assert-crash
rm -rf "$scratch/restore" && mkdir -p "$scratch/restore" && chmod 777 "$scratch/restore"
docker run --rm -v "$scratch/backup:/backup:ro" -v "$scratch/restore:/restore" postgres:16 \
  bash -c 'tar -xzf /backup/base.tar.gz -C /restore && if [ -f /backup/pg_wal.tar.gz ]; then mkdir -p /restore/pg_wal && tar -xzf /backup/pg_wal.tar.gz -C /restore/pg_wal; fi && rm -f /restore/postmaster.pid && chown -R postgres:postgres /restore && chmod 700 /restore'
boundary_time=$(node -e 'const s=require(process.argv[1]); process.stdout.write(s.boundaryTime.replace("T"," ").replace(/Z$/,"+00"))' "$PITR_STATE")
docker run --rm -e BOUNDARY_TIME="$boundary_time" -v "$scratch/restore:/restore" postgres:16 \
  bash -c 'cat >> /restore/postgresql.auto.conf <<EOF
restore_command = '\''cp /wal/%f %p'\''
recovery_target_time = '\''${BOUNDARY_TIME}'\''
recovery_target_action = '\''promote'\''
archive_mode = off
EOF
touch /restore/recovery.signal && chown postgres:postgres /restore/recovery.signal /restore/postgresql.auto.conf'
restore_started=$(date +%s%3N)
docker run --name "$restore_container" -d -p 127.0.0.1::5432 \
  -v "$scratch/restore:/var/lib/postgresql/data" -v "$scratch/wal:/wal:ro" postgres:16 >/dev/null
for attempt in $(seq 1 150); do
  if docker exec "$restore_container" psql -h 127.0.0.1 -U postgres -d freehold_wal6_disposable -X -Atc 'SELECT NOT pg_is_in_recovery()' 2>/dev/null | grep -qx t; then break; fi
  if [ "$attempt" -eq 150 ]; then echo 'PITR target did not promote' >&2; docker logs "$restore_container" >&2; exit 1; fi
  sleep 0.4
done
restore_ms=$(( $(date +%s%3N) - restore_started ))
restore_address=$(docker port "$restore_container" 5432/tcp)
export PITR_ADMIN_URL="postgresql://postgres:${pg_password}@${restore_address}/freehold_wal6_disposable"
export VERIFY_DATABASE_URL="postgresql://freehold_verifier:${verifier_password}@${restore_address}/freehold_wal6_disposable"
node scripts/pitr-drill.mjs assert-target
# Archive files are created by the postgres user inside the container. The host copy needs to read them.
docker exec "$container" chmod -R a+rX /wal
wal_file=$(find "$scratch/wal" -type f -size +1k | head -1)
corrupt="$scratch/corrupt-segment"
cp "$wal_file" "$corrupt"
dd if=/dev/zero of="$corrupt" bs=64 count=1 conv=notrunc status=none
if docker run --rm -v "$scratch:/scratch" postgres:16 pg_waldump /scratch/corrupt-segment >/dev/null 2>&1; then
  echo 'Corrupted WAL segment was accepted by pg_waldump' >&2
  exit 1
fi
echo 'PASS corrupted WAL segment rejected'
docker run --rm -v "$scratch/backup:/backup:ro" -v "$scratch:/out" postgres:16 \
  bash -c 'head -c 64 /backup/base.tar.gz > /out/damaged.tar.gz && chmod a+r /out/damaged.tar.gz'
if tar -tzf "$scratch/damaged.tar.gz" >/dev/null 2>&1; then echo 'Truncated base backup was accepted' >&2; exit 1; fi
echo 'PASS truncated base backup rejected'
rm -rf "$scratch/bad" && mkdir -p "$scratch/bad"
docker run --rm -v "$scratch/backup:/backup:ro" -v "$scratch/bad:/restore" postgres:16 \
  bash -c 'tar -xzf /backup/base.tar.gz -C /restore && rm -f /restore/postmaster.pid && chown -R postgres:postgres /restore && chmod 700 /restore'
docker run --rm -v "$scratch/bad:/restore" postgres:16 \
  bash -c 'printf "%s\n" "recovery_target_lsn = '\''not-an-lsn'\''" "recovery_target_action = '\''promote'\''" >> /restore/postgresql.auto.conf && touch /restore/recovery.signal && chown postgres:postgres /restore/recovery.signal /restore/postgresql.auto.conf'
docker run --name "$bad_container" -d -p 127.0.0.1::5432 -v "$scratch/bad:/var/lib/postgresql/data" postgres:16 >/dev/null
bad_rejected=0
for attempt in $(seq 1 40); do
  if ! docker inspect -f '{{.State.Running}}' "$bad_container" | grep -qx true; then bad_rejected=1; break; fi
  if docker logs "$bad_container" 2>&1 | grep -q 'not-an-lsn\|FATAL'; then bad_rejected=1; break; fi
  sleep 0.5
done
if [ "$bad_rejected" -ne 1 ]; then echo 'Invalid recovery target stayed up without an error' >&2; docker logs "$bad_container" >&2; exit 1; fi
echo 'PASS invalid recovery target rejected'
node scripts/pitr-drill.mjs inconsistent
journals_before_redis=$(docker exec "$restore_container" psql -U postgres -d freehold_wal6_disposable -X -Atc 'SELECT count(*) FROM freehold.ledger_journals')
docker restart "$redis_container" >/dev/null
for attempt in $(seq 1 40); do
  if docker exec "$redis_container" redis-cli ping >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 40 ]; then echo 'Redis did not return' >&2; exit 1; fi
  sleep 0.2
done
journals_after_redis=$(docker exec "$restore_container" psql -U postgres -d freehold_wal6_disposable -X -Atc 'SELECT count(*) FROM freehold.ledger_journals')
if [ "$journals_before_redis" != "$journals_after_redis" ]; then echo 'Redis restart changed the journal count' >&2; exit 1; fi
echo "PASS redis restart left ${journals_after_redis} journals"
failed_before=$(docker exec "$container" psql -U postgres -d freehold_wal6_disposable -X -Atc 'SELECT failed_count FROM pg_stat_archiver')
docker exec "$container" psql -U postgres -d freehold_wal6_disposable -X -c "ALTER SYSTEM SET archive_command = 'cp %p /no-such-freehold-archive/%f'" >/dev/null
docker exec "$container" psql -U postgres -d freehold_wal6_disposable -X -c 'SELECT pg_reload_conf()' >/dev/null
docker exec "$container" psql -U postgres -d freehold_wal6_disposable -X -c 'SELECT pg_switch_wal()' >/dev/null
archive_failed=0
for attempt in $(seq 1 80); do
  failed_after=$(docker exec "$container" psql -U postgres -d freehold_wal6_disposable -X -Atc 'SELECT failed_count FROM pg_stat_archiver')
  if [ "$failed_after" -gt "$failed_before" ]; then archive_failed=1; break; fi
  sleep 0.25
done
if [ "$archive_failed" -ne 1 ]; then echo 'Unavailable archive destination did not increment failed_count' >&2; exit 1; fi
echo "PASS unavailable archive destination failed_count ${failed_before} -> ${failed_after}"
touch -d '10 days ago' "$scratch/retain/old.tar.gz"
echo newer > "$scratch/retain/new.tar.gz"
bash scripts/backup-retain.sh "$scratch/retain" 7 >/dev/null
if [ -e "$scratch/retain/old.tar.gz" ] || [ ! -e "$scratch/retain/new.tar.gz" ]; then echo 'Retention kept the wrong file' >&2; exit 1; fi
echo 'PASS retention removed the expired file and kept the newest'
disk_ok=$(bash scripts/backup-disk-check.sh "$scratch/wal" 1)
if ! bash scripts/backup-disk-check.sh "$scratch/wal" 999999999999999 >/dev/null 2>&1; then disk_alert=1; else disk_alert=0; fi
if [ "$disk_alert" -ne 1 ]; then echo 'Disk check did not alert on an impossible minimum' >&2; exit 1; fi
echo 'PASS disk check alerts below the minimum'
test -f dist/src/worker.js
export WORKER_DATABASE_URL="postgresql://freehold_worker:${worker_password}@${address}/freehold_wal6_disposable"
export WORKER_POLL_MS=250 WORKER_RECONCILE_MS=3600000 WORKER_LEASE_SECONDS=5 WORKER_HOLD_LEASE_MS=8000
node dist/src/worker.js >"$scratch/worker-hold.log" 2>&1 &
worker_pid=$!
for attempt in $(seq 1 40); do
  processing=$(docker exec "$container" psql -U postgres -d freehold_wal6_disposable -X -Atc "SELECT count(*) FROM freehold.worker_inbox WHERE status='PROCESSING'")
  if [ "${processing:-0}" -gt 0 ]; then break; fi
  if [ "$attempt" -eq 40 ]; then echo 'Worker did not claim a batch' >&2; exit 1; fi
  sleep 0.25
done
kill -9 "$worker_pid" >/dev/null 2>&1 || true
wait "$worker_pid" >/dev/null 2>&1 || true
worker_pid=""
export WORKER_HOLD_LEASE_MS=0
node dist/src/worker.js >"$scratch/worker-recover.log" 2>&1 &
worker_pid=$!
for attempt in $(seq 1 80); do
  pending=$(docker exec "$container" psql -U postgres -d freehold_wal6_disposable -X -Atc "SELECT count(*) FROM freehold.outbox_events WHERE dispatched_at IS NULL AND quarantined_at IS NULL")
  if [ "$pending" = 0 ]; then break; fi
  if [ "$attempt" -eq 80 ]; then echo "Worker did not drain after crash; pending ${pending}" >&2; exit 1; fi
  sleep 0.5
done
kill -9 "$worker_pid" >/dev/null 2>&1 || true
wait "$worker_pid" >/dev/null 2>&1 || true
worker_pid=""
duplicate_journals=$(docker exec "$container" psql -U postgres -d freehold_wal6_disposable -X -Atc "SELECT count(*) FROM (SELECT operation_id FROM freehold.ledger_journals GROUP BY operation_id HAVING count(*)>1) d")
if [ "$duplicate_journals" != 0 ]; then echo 'Worker recovery duplicated a journal' >&2; exit 1; fi
echo 'PASS worker killed during a lease and the replacement drained without a duplicate journal'
finished=$(date +%s%3N)
node --input-type=module - "$started" "$finished" "$backup_ms" "$crash_ms" "$restore_ms" "$journals_after_redis" "$failed_before" "$failed_after" "$verify_line" "$disk_ok" <<'EOF'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [started, finished, backupMs, crashMs, restoreMs, redisJournals, failedBefore, failedAfter, verifyLine, diskOk] = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.PITR_STATE, 'utf8'));
const sha = (verifyLine.match(/sha256 ([0-9a-f]+)/) ?? [])[1] ?? null;
const report = {
  generatedAt: new Date().toISOString(),
  reportType: 'freehold.phase6-wal-recovery',
  sourceRevision: 'unknown',
  signature: null,
  signatureCustody: 'REQUIRES_EXTERNAL_REVIEW',
  automaticFailover: false,
  offsiteCopy: false,
  localMeasurement: true,
  productionRpoRto: 'not claimed',
  backupRole: 'freehold_backup',
  archiveDestination: 'separate host directory mounted at /wal, not the PostgreSQL data volume',
  baseBackupDestination: 'separate host directory mounted at /backup, not the PostgreSQL data volume',
  backupMs: Number(backupMs),
  crashRecoveryMs: Number(crashMs),
  restoreMs: Number(restoreMs),
  drillMs: Number(finished) - Number(started),
  backupSha256: sha,
  backupVerified: verifyLine.startsWith('PASS'),
  dataDirectoryBackupRefused: true,
  corruptedWalRejected: true,
  truncatedBackupRejected: true,
  invalidRecoveryTargetRejected: true,
  unavailableArchive: { failedCountBefore: Number(failedBefore), failedCountAfter: Number(failedAfter) },
  sessionInterruptedBeforeCommit: true,
  workerKilledDuringLeaseThenDrained: true,
  duplicateJournalsAfterWorkerRecovery: 0,
  redisRestartJournalsUnchanged: Number(redisJournals),
  retentionRemovedExpiredFile: true,
  diskCheck: JSON.parse(diskOk),
  diskAlertOnImpossibleMinimum: true,
  state,
};
const hashBody = { ...report };
report.contentSha256 = createHash('sha256').update(JSON.stringify(hashBody)).digest('hex');
report.contentHashCovers = 'every field except contentSha256';
mkdirSync('docs/evidence', { recursive: true });
writeFileSync('docs/evidence/phase6-wal.json', `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`PASS wal drill backupMs ${report.backupMs} crashRecoveryMs ${report.crashRecoveryMs} restoreMs ${report.restoreMs} target ${state.target?.verification ?? 'missing'}\n`);
EOF
