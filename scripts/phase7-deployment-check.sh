#!/usr/bin/env bash
# Read-only deployment check against a disposable database.
# Does not migrate, restart, or query the persistent Compose database.
# A NOT_READY result is recorded. This script does not turn archive_mode on
# or insert a heartbeat to force READY.
set -euo pipefail
cd "$(dirname "$0")/.."
container="freehold-deploy-check-$$"
cleanup() { docker rm -f -v "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
pg_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
api_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
worker_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
verifier_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
auth_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
scheduler_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
docker run --name "$container" -d -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD="$pg_password" -e POSTGRES_DB=freehold_deploy_check_disposable postgres:16 >/dev/null
for attempt in $(seq 1 100); do
  if docker exec "$container" psql -h 127.0.0.1 -U postgres -d freehold_deploy_check_disposable -X -Atc 'SELECT 1' >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 100 ]; then echo 'Deployment-check database failed to start' >&2; exit 1; fi
  sleep 0.2
done
pg_address=$(docker port "$container" 5432/tcp)
export API_DATABASE_PASSWORD="$api_password" WORKER_DATABASE_PASSWORD="$worker_password"
export VERIFIER_DATABASE_PASSWORD="$verifier_password" AUTH_DATABASE_PASSWORD="$auth_password"
export SCHEDULER_DATABASE_PASSWORD="$scheduler_password"
export MIGRATION_DATABASE_URL="postgresql://postgres:${pg_password}@${pg_address}/freehold_deploy_check_disposable"
export DEMO_MODE=false DEMO_BOOTSTRAP_TOKEN=''
node scripts/migrate.mjs >/tmp/freehold-phase7-deploy-check-migrate.log
out="${PHASE7_DEPLOY_OUT:-docs/evidence/deployment-check-latest.json}"
set +e
env -u DATABASE_URL -u AUTH_DATABASE_URL \
  CHECK_DATABASE_URL="postgresql://postgres:${pg_password}@${pg_address}/freehold_deploy_check_disposable" \
  VERIFY_DATABASE_URL="postgresql://freehold_verifier:${verifier_password}@${pg_address}/freehold_deploy_check_disposable" \
  node scripts/deployment-check.mjs --json --out "$out" >/tmp/freehold-phase7-deploy-check.out
code=$?
set -e
node --input-type=module - "$code" "$out" <<'EOF'
import { readFileSync } from 'node:fs';
const code = Number(process.argv[2]);
const report = JSON.parse(readFileSync(process.argv[3], 'utf8'));
if (report.migrationsApplied !== false || report.balancesChanged !== false || report.readOnly !== true) {
  console.error('Deployment check reported a mutation');
  process.exit(1);
}
const expected = report.result === 'READY' ? 0 : report.result === 'NOT_READY' ? 2 : report.result === 'INCOMPLETE' ? 3 : -1;
if (code !== expected) {
  console.error(`Exit ${code} does not match result ${report.result}`);
  process.exit(1);
}
const byId = Object.fromEntries(report.checks.map(check => [check.id, check.status]));
console.log(`PASS deployment check result ${report.result} exit ${code} schema ${byId.schema_version} wal ${byId.wal_archive} heartbeat ${byId.worker_heartbeat} verifier ${byId.independent_verifier} frontend ${byId.frontend_build}`);
EOF
