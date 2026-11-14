#!/usr/bin/env bash
# Disposable WAL archive, base backup, and point-in-time recovery.
# Removes only its own containers and scratch directory. No automatic failover.
set -euo pipefail
out="${PITR_DRILL_OUT:-docs/evidence/phase5-pitr.json}"
export PITR_DRILL_OUT="$out"
node --input-type=module -e 'import { refuseEvidenceOverwrite } from "./scripts/lib/evidence-output.mjs"; refuseEvidenceOverwrite(process.env.PITR_DRILL_OUT);'
container="freehold-pitr-$$"
restore_container="${container}-restore"
bad_container="${container}-bad"
redis_container="${container}-redis"
scratch=$(mktemp -d)
mkdir -p "$scratch/wal" "$scratch/backup" "$scratch/restore" "$scratch/bad"
chmod 777 "$scratch/wal" "$scratch/backup" "$scratch/restore" "$scratch/bad"
cleanup() {
  docker rm -f -v "$container" "$restore_container" "$bad_container" "$redis_container" >/dev/null 2>&1 || true
  if [ -d "$scratch" ]; then
    docker run --rm -v "$scratch:/scratch" postgres:16 rm -rf /scratch/restore /scratch/bad /scratch/backup /scratch/wal >/dev/null 2>&1 || true
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
docker run --name "$container" -d -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD="$pg_password" -e POSTGRES_DB=freehold_pitr_disposable \
  -v "$scratch/wal:/wal" -v "$scratch/backup:/backup" \
  postgres:16 \
  -c wal_level=replica -c archive_mode=on \
  -c archive_command='test ! -f /wal/%f && cp %p /wal/%f' \
  -c archive_timeout=60 -c max_wal_senders=4 >/dev/null
docker run --name "$redis_container" -d -p 127.0.0.1::6379 redis:7-alpine >/dev/null
for attempt in $(seq 1 100); do
  if docker exec "$container" psql -h 127.0.0.1 -U postgres -d freehold_pitr_disposable -X -Atc 'SELECT 1' >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 100 ]; then echo 'PITR database failed to start' >&2; docker logs "$container" >&2; exit 1; fi
  sleep 0.2
done
address=$(docker port "$container" 5432/tcp)
export API_DATABASE_PASSWORD="$api_password" WORKER_DATABASE_PASSWORD="$worker_password" VERIFIER_DATABASE_PASSWORD="$verifier_password" AUTH_DATABASE_PASSWORD="$auth_password" SCHEDULER_DATABASE_PASSWORD="$scheduler_password"
export MIGRATION_DATABASE_URL="postgresql://postgres:${pg_password}@${address}/freehold_pitr_disposable"
export DEMO_MODE=false DEMO_BOOTSTRAP_TOKEN=''
node scripts/migrate.mjs
export PITR_STATE="$scratch/state.json" PITR_ADMIN_URL="$MIGRATION_DATABASE_URL"
node scripts/pitr-drill.mjs setup
backup_started=$(date +%s%3N)
docker exec -u postgres "$container" pg_basebackup -D /backup -Ft -z -X fetch --no-sync
backup_ms=$(( $(date +%s%3N) - backup_started ))
test -s "$scratch/backup/base.tar.gz"
node scripts/pitr-drill.mjs mark
sleep 1
node scripts/pitr-drill.mjs post-b
# Crash the primary after B is durable, then let PostgreSQL recover its own data directory.
activity_pid=''
node -e 'const {Client}=require("pg"); const fs=require("node:fs"); const {randomUUID}=require("node:crypto"); const s=JSON.parse(fs.readFileSync(process.env.PITR_STATE,"utf8")); const c=new Client({connectionString:process.env.PITR_ADMIN_URL}); c.on("error",()=>{}); (async()=>{await c.connect(); for(let i=0;i<200;i+=1){ try { await c.query("SELECT freehold.execute_internal_transfer($1,$2,$3,$4,1,$5,$6)",[s.actor,s.source,s.destination,"USD","pitr-crash-"+randomUUID(),randomUUID()]); } catch { break; } }})().catch(()=>{});' &
activity_pid=$!
sleep 0.5
docker kill --signal KILL "$container" >/dev/null
wait "$activity_pid" || true
crash_started=$(date +%s%3N)
docker start "$container" >/dev/null
for attempt in $(seq 1 100); do
  if docker exec "$container" psql -h 127.0.0.1 -U postgres -d freehold_pitr_disposable -X -Atc 'SELECT 1' >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 100 ]; then echo 'PostgreSQL did not recover after kill' >&2; docker logs "$container" >&2; exit 1; fi
  sleep 0.2
done
address=$(docker port "$container" 5432/tcp)
export PITR_ADMIN_URL="postgresql://postgres:${pg_password}@${address}/freehold_pitr_disposable"
export VERIFY_DATABASE_URL="postgresql://freehold_verifier:${verifier_password}@${address}/freehold_pitr_disposable"
for attempt in $(seq 1 100); do
  if node --input-type=module -e 'import pg from "pg"; const c=new pg.Client({connectionString:process.env.PITR_ADMIN_URL,connectionTimeoutMillis:1000}); await c.connect(); await c.query("SELECT 1"); await c.end();' >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 100 ]; then echo 'PostgreSQL did not accept host connections after crash recovery' >&2; exit 1; fi
  sleep 0.2
done
crash_ms=$(( $(date +%s%3N) - crash_started ))
node scripts/pitr-drill.mjs assert-crash
# Point-in-time restore of the base backup to the boundary recorded before B.
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
  if docker exec "$restore_container" psql -h 127.0.0.1 -U postgres -d freehold_pitr_disposable -X -Atc 'SELECT NOT pg_is_in_recovery()' 2>/dev/null | grep -qx t; then break; fi
  if [ "$attempt" -eq 150 ]; then echo 'PITR target did not promote' >&2; docker logs "$restore_container" >&2; exit 1; fi
  sleep 0.4
done
restore_ms=$(( $(date +%s%3N) - restore_started ))
restore_address=$(docker port "$restore_container" 5432/tcp)
export PITR_ADMIN_URL="postgresql://postgres:${pg_password}@${restore_address}/freehold_pitr_disposable"
export VERIFY_DATABASE_URL="postgresql://freehold_verifier:${verifier_password}@${restore_address}/freehold_pitr_disposable"
node scripts/pitr-drill.mjs assert-target
# Damaged backup and an invalid recovery target must not come up as a healthy primary.
docker run --rm -v "$scratch/backup:/backup:ro" -v "$scratch:/out" postgres:16 \
  bash -c 'head -c 64 /backup/base.tar.gz > /out/damaged.tar.gz && chmod a+r /out/damaged.tar.gz'
if tar -tzf "$scratch/damaged.tar.gz" >/dev/null 2>&1; then echo 'Truncated base backup was accepted' >&2; exit 1; fi
echo 'PASS: truncated base backup rejected'
rm -rf "$scratch/bad" && mkdir -p "$scratch/bad"
docker run --rm -v "$scratch/backup:/backup:ro" -v "$scratch/bad:/restore" postgres:16 \
  bash -c 'tar -xzf /backup/base.tar.gz -C /restore && if [ -f /backup/pg_wal.tar.gz ]; then mkdir -p /restore/pg_wal && tar -xzf /backup/pg_wal.tar.gz -C /restore/pg_wal; fi && rm -f /restore/postmaster.pid && chown -R postgres:postgres /restore && chmod 700 /restore'
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
echo 'PASS: invalid recovery target rejected'
node scripts/pitr-drill.mjs inconsistent
journals_before_redis=$(docker exec "$restore_container" psql -U postgres -d freehold_pitr_disposable -X -Atc 'SELECT count(*) FROM freehold.ledger_journals')
docker restart "$redis_container" >/dev/null
for attempt in $(seq 1 40); do
  if docker exec "$redis_container" redis-cli ping >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 40 ]; then echo 'Redis did not return' >&2; exit 1; fi
  sleep 0.2
done
journals_after_redis=$(docker exec "$restore_container" psql -U postgres -d freehold_pitr_disposable -X -Atc 'SELECT count(*) FROM freehold.ledger_journals')
if [ "$journals_before_redis" != "$journals_after_redis" ]; then echo 'Redis restart changed the journal count' >&2; exit 1; fi
echo "PASS: redis restart left ${journals_after_redis} journals"
finished=$(date +%s%3N)
node -e 'const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const extra=JSON.parse(process.argv[2]); const out={generatedAt:new Date().toISOString(), automaticFailover:false, localMeasurement:true, productionRpoRto:"not claimed", ...extra, ...s}; fs.mkdirSync("docs/evidence",{recursive:true}); fs.writeFileSync(process.env.PITR_DRILL_OUT, JSON.stringify(out,null,2)+"\n"); console.log("PASS pitr backupMs "+extra.backupMs+" crashRecoveryMs "+extra.crashRecoveryMs+" restoreMs "+extra.restoreMs);' \
  "$PITR_STATE" "{\"backupMs\":${backup_ms},\"crashRecoveryMs\":${crash_ms},\"restoreMs\":${restore_ms},\"drillMs\":$((finished-started)),\"redisJournalsUnchanged\":${journals_after_redis},\"truncatedBackupRejected\":true,\"invalidRecoveryTargetRejected\":true}"
