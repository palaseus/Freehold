#!/usr/bin/env bash
# Disposable chaos experiments. Never names the Compose project.
set -euo pipefail
cd "$(dirname "$0")/.."
pg_container="freehold-chaos-pg-$$"
redis_container="freehold-chaos-redis-$$"
cleanup() { docker rm -f -v "$pg_container" "$redis_container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
pg_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
api_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
worker_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
verifier_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
auth_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
scheduler_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
docker run --name "$pg_container" -d -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD="$pg_password" -e POSTGRES_DB=freehold_chaos_disposable postgres:16 >/dev/null
docker run --name "$redis_container" -d -p 127.0.0.1::6379 redis:7-alpine >/dev/null
for attempt in $(seq 1 100); do
  if docker exec "$pg_container" psql -h 127.0.0.1 -U postgres -d freehold_chaos_disposable -X -Atc 'SELECT 1' >/dev/null 2>&1 \
    && docker exec "$redis_container" redis-cli ping >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 100 ]; then echo 'Chaos infrastructure failed to start' >&2; exit 1; fi
  sleep 0.2
done
pg_address=$(docker port "$pg_container" 5432/tcp)
redis_address=$(docker port "$redis_container" 6379/tcp)
export API_DATABASE_PASSWORD="$api_password" WORKER_DATABASE_PASSWORD="$worker_password"
export VERIFIER_DATABASE_PASSWORD="$verifier_password" AUTH_DATABASE_PASSWORD="$auth_password"
export SCHEDULER_DATABASE_PASSWORD="$scheduler_password"
export MIGRATION_DATABASE_URL="postgresql://postgres:${pg_password}@${pg_address}/freehold_chaos_disposable"
export NODE_ENV=test DEMO_MODE=false DEMO_BOOTSTRAP_TOKEN=''
node scripts/migrate.mjs >/dev/null
npx tsc -p tsconfig.json --pretty false --noEmit false
export PHASE8_ADMIN_URL="$MIGRATION_DATABASE_URL"
export SCHEDULER_DATABASE_URL="postgresql://freehold_scheduler:${scheduler_password}@${pg_address}/freehold_chaos_disposable"
export WORKER_DATABASE_URL="postgresql://freehold_worker:${worker_password}@${pg_address}/freehold_chaos_disposable"
export VERIFY_DATABASE_URL="postgresql://freehold_verifier:${verifier_password}@${pg_address}/freehold_chaos_disposable"
export PHASE8_PG_CONTAINER="$pg_container" PHASE8_REDIS_CONTAINER="$redis_container"
export PHASE8_REDIS_URL="redis://${redis_address}"
export PHASE8_API_DATABASE_URL="postgresql://freehold_api:${api_password}@${pg_address}/freehold_chaos_disposable"
export PHASE8_AUTH_DATABASE_URL="postgresql://freehold_auth:${auth_password}@${pg_address}/freehold_chaos_disposable"
export PHASE8_CHAOS_OUT="${PHASE8_CHAOS_OUT:-docs/evidence/phase8-chaos.json}"
node scripts/phase8-chaos.mjs
