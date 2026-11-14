#!/usr/bin/env bash
# Disposable load drill. Creates and removes only its own containers.
set -euo pipefail
node --input-type=module -e 'import { refuseEvidenceOverwrite } from "./scripts/lib/evidence-output.mjs"; refuseEvidenceOverwrite("docs/evidence/phase5-load.json");'
container="freehold-load-$$"
redis_container="${container}-redis"
scratch=$(mktemp -d)
cleanup() { docker rm -f -v "$container" "$redis_container" >/dev/null 2>&1 || true; rm -rf "$scratch"; }
trap cleanup EXIT
pg_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
api_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
worker_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
verifier_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
auth_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
scheduler_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
docker run --name "$container" -d -p 127.0.0.1::5432 -e POSTGRES_PASSWORD="$pg_password" -e POSTGRES_DB=freehold_load_disposable postgres:16 >/dev/null
docker run --name "$redis_container" -d -p 127.0.0.1::6379 redis:7-alpine >/dev/null
for attempt in $(seq 1 100); do
  if docker exec "$container" psql -h 127.0.0.1 -U postgres -d freehold_load_disposable -X -Atc 'SELECT 1' >/dev/null 2>&1 \
    && docker exec "$redis_container" redis-cli ping >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 100 ]; then echo 'Disposable load infrastructure failed to start' >&2; exit 1; fi
  sleep 0.2
done
address=$(docker port "$container" 5432/tcp)
export API_DATABASE_PASSWORD="$api_password" WORKER_DATABASE_PASSWORD="$worker_password" VERIFIER_DATABASE_PASSWORD="$verifier_password" AUTH_DATABASE_PASSWORD="$auth_password" SCHEDULER_DATABASE_PASSWORD="$scheduler_password"
export MIGRATION_DATABASE_URL="postgresql://postgres:${pg_password}@${address}/freehold_load_disposable"
export DEMO_MODE=false DEMO_BOOTSTRAP_TOKEN=''
node scripts/migrate.mjs
export LOAD_TEST_DISPOSABLE=1
export LOAD_ADMIN_URL="$MIGRATION_DATABASE_URL"
export VERIFY_DATABASE_URL="postgresql://freehold_verifier:${verifier_password}@${address}/freehold_load_disposable"
export LOAD_RESULT_PATH="$scratch/load-result.json"
export LOAD_PROFILE="${LOAD_PROFILE:-auto}"
set +e
node scripts/load-test.mjs run
run_status=$?
set -e
if [ -f "$LOAD_RESULT_PATH" ]; then
  mkdir -p docs/evidence
  cp "$LOAD_RESULT_PATH" docs/evidence/phase5-load.json
fi
if [ "$run_status" -ne 0 ]; then exit "$run_status"; fi
restart_started=$(date +%s%3N)
docker restart "$container" >/dev/null
address=$(docker port "$container" 5432/tcp)
export LOAD_ADMIN_URL="postgresql://postgres:${pg_password}@${address}/freehold_load_disposable"
export VERIFY_DATABASE_URL="postgresql://freehold_verifier:${verifier_password}@${address}/freehold_load_disposable"
for attempt in $(seq 1 100); do
  if node --input-type=module -e 'import pg from "pg"; const c=new pg.Client({connectionString:process.env.LOAD_ADMIN_URL,connectionTimeoutMillis:1000}); await c.connect(); await c.query("SELECT 1"); await c.end();' >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 100 ]; then echo 'PostgreSQL did not accept host connections after restart' >&2; exit 1; fi
  sleep 0.2
done
node -e 'const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); r.postgresRestartMs=Number(process.argv[2]); fs.writeFileSync(process.argv[1], JSON.stringify(r,null,2)+"\n");' "$LOAD_RESULT_PATH" "$(( $(date +%s%3N) - restart_started ))"
node scripts/load-test.mjs reconnect
docker restart "$redis_container" >/dev/null
for attempt in $(seq 1 50); do
  if docker exec "$redis_container" redis-cli ping >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 50 ]; then echo 'Redis did not return after restart' >&2; exit 1; fi
  sleep 0.2
done
node scripts/load-test.mjs redis
mkdir -p docs/evidence
cp "$LOAD_RESULT_PATH" docs/evidence/phase5-load.json
node --input-type=module -e 'import { copyFileSync, readFileSync } from "node:fs"; import { refuseEvidenceOverwrite } from "./scripts/lib/evidence-output.mjs"; const r=JSON.parse(readFileSync("docs/evidence/phase5-load.json","utf8")); const profileOut=`docs/evidence/phase5-load-${r.profile}.json`; refuseEvidenceOverwrite(profileOut); copyFileSync("docs/evidence/phase5-load.json", profileOut); const s=r.scenarios.find(x=>x.name==="independentTransfers"); console.log(`PASS load profile ${r.profile} verification ${r.finalVerification.outcome} independent completed ${s.completed} in ${s.elapsedMs} ms p95 ${s.latencyMs.p95} ms p99 ${s.latencyMs.p99} ms verifier ${r.finalVerification.elapsedMs} ms`);'
