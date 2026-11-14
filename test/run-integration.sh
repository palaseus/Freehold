#!/usr/bin/env bash
# Ephemeral infrastructure only. The test process migrates and seeds it.
set -euo pipefail
postgres_container="freehold-api-pg-$$"
redis_container="freehold-api-redis-$$"
fresh_container="freehold-api-fresh-pg-$$"
cleanup() {
  docker rm -f -v "$postgres_container" "$redis_container" "$fresh_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# Localhost-only random ports avoid exposing test credentials on the network.
docker run --name "$postgres_container" -d -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD=freehold-test-only -e POSTGRES_DB=freehold_test postgres:16 >/dev/null
docker run --name "$redis_container" -d -p 127.0.0.1::6379 redis:7-alpine >/dev/null
for attempt in $(seq 1 50); do
  if docker exec "$postgres_container" psql -h 127.0.0.1 -U postgres -d freehold_test -X -Atc 'SELECT 1' >/dev/null 2>&1 \
    && docker exec "$redis_container" redis-cli ping >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 50 ]; then echo 'Test infrastructure failed to start' >&2; exit 1; fi
  sleep 0.2
done
postgres_address=$(docker port "$postgres_container" 5432/tcp)
redis_address=$(docker port "$redis_container" 6379/tcp)
export TEST_DATABASE_ADMIN_URL="postgresql://postgres:freehold-test-only@${postgres_address}/freehold_test"
export API_DATABASE_PASSWORD=freehold-api-test-password-01234567890123456789
export WORKER_DATABASE_PASSWORD=freehold-worker-test-password-01234567890123456789
export VERIFIER_DATABASE_PASSWORD=freehold-verifier-test-password-01234567890123456789
export AUTH_DATABASE_PASSWORD=freehold-auth-test-password-01234567890123456789
export SCHEDULER_DATABASE_PASSWORD=freehold-scheduler-test-password-01234567890123456789
export DATABASE_URL="postgresql://freehold_api:${API_DATABASE_PASSWORD}@${postgres_address}/freehold_test"
export AUTH_DATABASE_URL="postgresql://freehold_auth:${AUTH_DATABASE_PASSWORD}@${postgres_address}/freehold_test"
export WORKER_DATABASE_URL="postgresql://freehold_worker:${WORKER_DATABASE_PASSWORD}@${postgres_address}/freehold_test"
export VERIFY_DATABASE_URL="postgresql://freehold_verifier:${VERIFIER_DATABASE_PASSWORD}@${postgres_address}/freehold_test"
export SCHEDULER_DATABASE_URL="postgresql://freehold_scheduler:${SCHEDULER_DATABASE_PASSWORD}@${postgres_address}/freehold_test"
export REDIS_URL="redis://${redis_address}"
export TOTP_ENCRYPTION_KEY
TOTP_ENCRYPTION_KEY=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')
export DEMO_MODE=true DEMO_BOOTSTRAP_TOKEN=freehold-integration-demo-token-2026
export COOKIE_SECURE=false NODE_ENV=test APP_ORIGIN=http://localhost:3000
export MIGRATION_DATABASE_URL="$TEST_DATABASE_ADMIN_URL"
export API_DATABASE_PASSWORD WORKER_DATABASE_PASSWORD VERIFIER_DATABASE_PASSWORD AUTH_DATABASE_PASSWORD SCHEDULER_DATABASE_PASSWORD
MIGRATION_TEST_STOP_AFTER=005 node scripts/migrate.mjs
node -e 'const {Client}=require("pg"); (async()=>{const c=new Client({connectionString:process.env.TEST_DATABASE_ADMIN_URL}); await c.connect(); try { await c.query("CREATE ROLE freehold_runtime LOGIN IN ROLE freehold_app"); } finally { await c.end(); }})().catch(e=>{process.stderr.write(`legacy role setup failed (${e.code ?? "internal"})\n`); process.exitCode=1;});'
node scripts/migrate.mjs
export AUTH_INTERNAL_TOKEN=freehold-auth-internal-token-012345678901234
auth_log=$(mktemp)
env -u DATABASE_URL \
  AUTH_DATABASE_URL="$AUTH_DATABASE_URL" \
  REDIS_URL="$REDIS_URL" \
  TOTP_ENCRYPTION_KEY="$TOTP_ENCRYPTION_KEY" \
  AUTH_INTERNAL_TOKEN="$AUTH_INTERNAL_TOKEN" \
  AUTH_PORT=0 AUTH_BIND_HOST=127.0.0.1 \
  node dist/src/auth-server.js >"$auth_log" 2>&1 &
auth_pid=$!
cleanup() {
  if [ -n "${auth_pid:-}" ]; then kill "$auth_pid" >/dev/null 2>&1 || true; fi
  docker rm -f -v "$postgres_container" "$redis_container" "$fresh_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
for attempt in $(seq 1 50); do
  if grep -q '^AUTH_LISTENING ' "$auth_log"; then break; fi
  if ! kill -0 "$auth_pid" >/dev/null 2>&1; then echo 'Auth process exited before listening' >&2; cat "$auth_log" >&2; exit 1; fi
  if [ "$attempt" -eq 50 ]; then echo 'Auth process did not listen' >&2; cat "$auth_log" >&2; exit 1; fi
  sleep 0.1
done
auth_port=$(sed -n 's/^AUTH_LISTENING //p' "$auth_log" | head -1)
export AUTH_SERVICE_URL="http://127.0.0.1:${auth_port}"
env -u AUTH_DATABASE_URL npm run test:integration
node --test test/verification.test.mjs
node --test test/phase5-controls.mjs
node --test test/phase6-controls.mjs
node --test test/phase7-controls.mjs
node --test test/statement-document.test.mjs
node --test test/evidence-output.test.mjs
node --test test/production-posture.test.mjs
node --test test/deployment-status.test.mjs
node --test test/deployment-evidence.test.mjs
node --test test/backup-set.test.mjs
node --test test/evidence-signature.test.mjs
node --test test/release-verify.test.mjs
node --test test/phase9a-lease.mjs
node --test test/phase10-monetary.mjs
node --test test/phase11-monetary.mjs
node --test test/phase12-institutional.mjs
node --test test/phase13-network.mjs
node --test test/phase14-programmable.mjs

# A second independent cluster proves the no-legacy-role fresh-install path.
docker run --name "$fresh_container" -d -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD=freehold-fresh-test-only -e POSTGRES_DB=freehold_fresh postgres:16 >/dev/null
for attempt in $(seq 1 50); do
  if docker exec "$fresh_container" psql -h 127.0.0.1 -U postgres -d freehold_fresh -X -Atc 'SELECT 1' >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 50 ]; then echo 'Fresh migration database failed to start' >&2; exit 1; fi
  sleep 0.2
done
fresh_address=$(docker port "$fresh_container" 5432/tcp)
MIGRATION_DATABASE_URL="postgresql://postgres:freehold-fresh-test-only@${fresh_address}/freehold_fresh" \
  DEMO_MODE=false DEMO_BOOTSTRAP_TOKEN='' node scripts/migrate.mjs
fresh_roles_ok=$(docker exec "$fresh_container" psql -U postgres -d freehold_fresh -X -Atc \
  "SELECT (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit FROM pg_roles WHERE rolname='freehold_api') AND (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit FROM pg_roles WHERE rolname='freehold_worker') AND (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit FROM pg_roles WHERE rolname='freehold_verifier') AND (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit FROM pg_roles WHERE rolname='freehold_auth') AND (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit FROM pg_roles WHERE rolname='freehold_scheduler') AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='freehold_runtime')")
if [ "$fresh_roles_ok" != t ]; then echo 'Fresh-install runtime roles are not correctly provisioned' >&2; exit 1; fi
echo 'PASS: fresh-install migration and runtime role provisioning'
