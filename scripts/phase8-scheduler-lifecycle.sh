#!/usr/bin/env bash
# Disposable scheduler lifecycle. Does not attach to the Compose project.
set -euo pipefail
cd "$(dirname "$0")/.."
container="freehold-sched-life-$$"
cleanup() { docker rm -f -v "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
pg_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
api_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
worker_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
verifier_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
auth_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
scheduler_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
docker run --name "$container" -d -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD="$pg_password" -e POSTGRES_DB=freehold_scheduler_lifecycle_disposable postgres:16 >/dev/null
for attempt in $(seq 1 100); do
  if docker exec "$container" psql -h 127.0.0.1 -U postgres -d freehold_scheduler_lifecycle_disposable -X -Atc 'SELECT 1' >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 100 ]; then echo 'Scheduler lifecycle database failed to start' >&2; exit 1; fi
  sleep 0.2
done
pg_address=$(docker port "$container" 5432/tcp)
export API_DATABASE_PASSWORD="$api_password" WORKER_DATABASE_PASSWORD="$worker_password"
export VERIFIER_DATABASE_PASSWORD="$verifier_password" AUTH_DATABASE_PASSWORD="$auth_password"
export SCHEDULER_DATABASE_PASSWORD="$scheduler_password"
export MIGRATION_DATABASE_URL="postgresql://postgres:${pg_password}@${pg_address}/freehold_scheduler_lifecycle_disposable"
export NODE_ENV=test DEMO_MODE=false DEMO_BOOTSTRAP_TOKEN=''
node scripts/migrate.mjs
npx tsc -p tsconfig.json --pretty false --noEmit false
export PHASE8_ADMIN_URL="$MIGRATION_DATABASE_URL"
export SCHEDULER_DATABASE_URL="postgresql://freehold_scheduler:${scheduler_password}@${pg_address}/freehold_scheduler_lifecycle_disposable"
export PHASE8_SCHEDULER_OUT="${PHASE8_SCHEDULER_OUT:-docs/evidence/phase8-scheduler-lifecycle.json}"
node scripts/phase8-scheduler-lifecycle.mjs
