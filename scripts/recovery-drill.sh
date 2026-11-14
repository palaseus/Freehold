#!/usr/bin/env bash
# Full destructive recovery exercise. Creates and removes only its own disposable container.
set -euo pipefail
node --input-type=module -e 'import { refuseEvidenceOverwrite } from "./scripts/lib/evidence-output.mjs"; refuseEvidenceOverwrite("docs/evidence/phase5-logical-restore.json"); refuseEvidenceOverwrite("docs/evidence/phase5-recovery/manifest.json"); refuseEvidenceOverwrite("docs/evidence/phase5-recovery/verification.json");'
drill_started=$(date +%s%3N)
container="freehold-dr-${$}"
restore_container="${container}-restore"
scratch=$(mktemp -d)
cleanup() { docker rm -f -v "$container" "$restore_container" >/dev/null 2>&1 || true; rm -rf "$scratch"; }
trap cleanup EXIT

source_db=freehold_dr_disposable_source
restore_db=freehold_dr_disposable_restore
pg_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
api_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
worker_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
verifier_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
auth_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
scheduler_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
docker run --name "$container" -d -p 127.0.0.1::5432 -e POSTGRES_PASSWORD="$pg_password" -e POSTGRES_DB="$source_db" postgres:16 >/dev/null
for attempt in $(seq 1 100); do
  if docker exec "$container" psql -h 127.0.0.1 -U postgres -d "$source_db" -X -Atc 'SELECT 1' >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 100 ]; then echo 'Disposable recovery database failed to start' >&2; exit 1; fi
  sleep 0.2
done
address=$(docker port "$container" 5432/tcp)
export API_DATABASE_PASSWORD="$api_password" WORKER_DATABASE_PASSWORD="$worker_password" VERIFIER_DATABASE_PASSWORD="$verifier_password" AUTH_DATABASE_PASSWORD="$auth_password" SCHEDULER_DATABASE_PASSWORD="$scheduler_password"
export MIGRATION_DATABASE_URL="postgresql://postgres:${pg_password}@${address}/${source_db}"
export DR_ADMIN_URL="$MIGRATION_DATABASE_URL"
export DR_API_URL="postgresql://freehold_api:${api_password}@${address}/${source_db}"
export DR_WORKER_URL="postgresql://freehold_worker:${worker_password}@${address}/${source_db}"
export VERIFY_DATABASE_URL="postgresql://freehold_verifier:${verifier_password}@${address}/${source_db}"
export DR_STATE_FILE="$scratch/replay-state.json"
export DEMO_MODE=false DEMO_BOOTSTRAP_TOKEN=''

node scripts/migrate.mjs
node scripts/recovery-drill.mjs
if ! node scripts/verify-ledger.mjs --out "$scratch/source-verification.json"; then cat "$scratch/source-verification.json"; exit 1; fi

backup="$scratch/freehold.pgdump"
docker exec "$container" pg_dump -U postgres -d "$source_db" -Fc > "$backup"
test -s "$backup"
damaged="$scratch/freehold-damaged.pgdump"
head -c 64 "$backup" > "$damaged"
if docker exec -i "$container" pg_restore --list - < "$damaged" >/dev/null 2>&1; then
  echo 'Corrupted backup unexpectedly passed pg_restore archive validation' >&2
  exit 1
fi
echo 'PASS: corrupted backup rejected during archive validation'

docker run --name "$restore_container" -d -p 127.0.0.1::5432 -e POSTGRES_PASSWORD="$pg_password" postgres:16 >/dev/null
for attempt in $(seq 1 100); do
  if docker exec "$restore_container" psql -h 127.0.0.1 -U postgres -d postgres -X -Atc 'SELECT 1' >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 100 ]; then echo 'Fresh restore cluster failed to start' >&2; exit 1; fi
  sleep 0.2
done
docker exec -i "$restore_container" psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 < scripts/restore-runtime-roles.sql
docker exec "$restore_container" createdb -U postgres "$restore_db"
restore_started=$(date +%s%3N)
docker exec -i "$restore_container" pg_restore -U postgres -d "$restore_db" --exit-on-error < "$backup"
restore_finished=$(date +%s%3N)
restore_elapsed_ms=$((restore_finished-restore_started))
echo "RESTORE_ELAPSED_MS=${restore_elapsed_ms}"
restore_address=$(docker port "$restore_container" 5432/tcp)
export RESTORED_ADMIN_URL="postgresql://postgres:${pg_password}@${restore_address}/postgres"
export DR_RESTORE_ADMIN_URL="postgresql://postgres:${pg_password}@${restore_address}/${restore_db}"
node scripts/provision-restored-credentials.mjs
export VERIFY_DATABASE_URL="postgresql://freehold_verifier:${verifier_password}@${restore_address}/${restore_db}"
node scripts/verify-ledger.mjs --out "$scratch/restored-verification.json"
export DR_RESTORE_API_URL="postgresql://freehold_api:${api_password}@${restore_address}/${restore_db}"
node scripts/replay-restored-operation.mjs
node -e 'const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(r.outcome!=="VERIFIED") process.exit(1); process.stdout.write(`PASS: restored verifier outcome ${r.outcome}; ${r.counts.journals} journals, ${r.counts.journalEntries} entries\n`)' "$scratch/restored-verification.json"
drill_finished=$(date +%s%3N)
drill_elapsed_ms=$((drill_finished-drill_started))
echo "DRILL_ELAPSED_MS=${drill_elapsed_ms}"
mkdir -p docs/evidence/phase5-recovery
node scripts/export-evidence.mjs "$scratch/restored-verification.json" docs/evidence/phase5-recovery
node -e 'const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const out={generatedAt:new Date().toISOString(), restoreElapsedMs:Number(process.argv[2]), drillElapsedMs:Number(process.argv[3]), outcome:r.outcome, journals:r.counts.journals, journalEntries:r.counts.journalEntries, verificationRunId:r.verificationRunId??null, algorithmVersion:r.algorithmVersion??null, automaticFailover:false, productionRpoRto:"not claimed", localMeasurement:true}; fs.writeFileSync("docs/evidence/phase5-logical-restore.json", JSON.stringify(out,null,2)+"\n");' \
  "$scratch/restored-verification.json" "$restore_elapsed_ms" "$drill_elapsed_ms"
