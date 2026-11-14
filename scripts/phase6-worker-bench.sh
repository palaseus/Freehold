#!/usr/bin/env bash
# Disposable API + PostgreSQL + worker throughput drill.
# Does not attach to the Compose project and does not write Phase 5 evidence.
set -euo pipefail
cd "$(dirname "$0")/.."
container="freehold-wbench-$$"
redis_container="${container}-redis"
bench_pid=""
cleanup() {
  if [ -n "$bench_pid" ]; then kill "$bench_pid" >/dev/null 2>&1 || true; wait "$bench_pid" >/dev/null 2>&1 || true; fi
  docker rm -f -v "$container" "$redis_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
pg_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
api_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
worker_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
verifier_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
auth_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
scheduler_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
auth_token=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
totp_key=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')
docker run --name "$container" -d -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD="$pg_password" -e POSTGRES_DB=freehold_worker_bench_disposable postgres:16 >/dev/null
docker run --name "$redis_container" -d -p 127.0.0.1::6379 redis:7-alpine >/dev/null
for attempt in $(seq 1 100); do
  if docker exec "$container" psql -h 127.0.0.1 -U postgres -d freehold_worker_bench_disposable -X -Atc 'SELECT 1' >/dev/null 2>&1 \
    && docker exec "$redis_container" redis-cli ping >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 100 ]; then echo 'Worker bench infrastructure failed to start' >&2; exit 1; fi
  sleep 0.2
done
pg_address=$(docker port "$container" 5432/tcp)
redis_address=$(docker port "$redis_container" 6379/tcp)
export API_DATABASE_PASSWORD="$api_password" WORKER_DATABASE_PASSWORD="$worker_password"
export VERIFIER_DATABASE_PASSWORD="$verifier_password" AUTH_DATABASE_PASSWORD="$auth_password"
export SCHEDULER_DATABASE_PASSWORD="$scheduler_password"
export MIGRATION_DATABASE_URL="postgresql://postgres:${pg_password}@${pg_address}/freehold_worker_bench_disposable"
export DEMO_MODE=false DEMO_BOOTSTRAP_TOKEN=''
node scripts/migrate.mjs
npx tsc -p tsconfig.json --pretty false --noEmit false
export PHASE6_PG_HOST="${pg_address%%:*}" PHASE6_PG_PORT="${pg_address##*:}"
export PHASE6_DB=freehold_worker_bench_disposable
export PHASE6_PG_PASSWORD="$pg_password" PHASE6_API_PASSWORD="$api_password"
export PHASE6_WORKER_PASSWORD="$worker_password" PHASE6_VERIFIER_PASSWORD="$verifier_password"
export PHASE6_AUTH_PASSWORD="$auth_password" PHASE6_SCHEDULER_PASSWORD="$scheduler_password"
export PHASE6_REDIS_URL="redis://${redis_address}"
export PHASE6_AUTH_TOKEN="$auth_token" PHASE6_TOTP_KEY="$totp_key"
export PHASE6_HTTP_OPS="${PHASE6_HTTP_OPS:-1000}" PHASE6_BURST_OPS="${PHASE6_BURST_OPS:-400}"
node scripts/phase6-worker-bench.mjs
