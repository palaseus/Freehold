#!/usr/bin/env bash
# Read-only copy of the persistent Compose database, restored into a disposable
# cluster, then migrated through the current schema. Does not migrate Compose.
set -euo pipefail
cd "$(dirname "$0")/.."
out="${PHASE8_REHEARSAL_OUT:-docs/evidence/phase8-migration-rehearsal.json}"
if [ "$out" = "docs/evidence/phase7-migration-rehearsal.json" ]; then
  echo 'Refusing to write the preserved Phase 7 rehearsal report' >&2
  exit 1
fi
node --input-type=module -e 'import { refuseEvidenceOverwrite } from "./scripts/lib/evidence-output.mjs"; refuseEvidenceOverwrite(process.argv[1]);' "$out"
persistent=${PHASE8_PERSISTENT_CONTAINER:-freehold-postgres-1}
if [ "$persistent" != "freehold-postgres-1" ] && [ "${PHASE8_ALLOW_OTHER_CONTAINER:-}" != "1" ]; then
  echo 'Refusing an unexpected persistent container name' >&2
  exit 1
fi
if ! docker inspect "$persistent" >/dev/null 2>&1; then
  echo "Persistent container ${persistent} is not running. Rehearsal is UNVERIFIED." >&2
  exit 1
fi
scratch=$(mktemp -d /tmp/freehold-phase8-rehearsal.XXXXXX)
chmod 700 "$scratch"
container="freehold-rehearsal8-$$"
cleanup() {
  status=$?
  docker rm -f -v "$container" >/dev/null 2>&1 || true
  if [ "$status" -eq 0 ]; then rm -rf "$scratch"; else echo "Rehearsal scratch kept at $scratch" >&2; fi
}
trap cleanup EXIT
before=$(docker exec "$persistent" psql -U postgres -d freehold -X -Atc "SELECT coalesce(string_agg(name, ',' ORDER BY name), '') FROM freehold_deploy.migrations")
docker exec "$persistent" pg_dump -U postgres -d freehold -Fc -f /tmp/phase8-rehearsal.dump
docker cp "$persistent:/tmp/phase8-rehearsal.dump" "$scratch/freehold.dump"
docker exec "$persistent" rm -f /tmp/phase8-rehearsal.dump
sha=$(sha256sum "$scratch/freehold.dump" | awk 'NR==1 { print $1 }')
bytes=$(wc -c < "$scratch/freehold.dump" | tr -d ' ')
chmod 600 "$scratch/freehold.dump"
pg_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
api_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
worker_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
verifier_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
auth_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
scheduler_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
docker run --name "$container" -d -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD="$pg_password" -e POSTGRES_DB=freehold_rehearsal_disposable postgres:16 >/dev/null
for attempt in $(seq 1 100); do
  if docker exec "$container" psql -h 127.0.0.1 -U postgres -d freehold_rehearsal_disposable -X -Atc 'SELECT 1' >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 100 ]; then echo 'Rehearsal database failed to start' >&2; exit 1; fi
  sleep 0.2
done
docker cp "$scratch/freehold.dump" "$container:/tmp/freehold.dump"
docker exec "$container" psql -U postgres -d freehold_rehearsal_disposable -v ON_ERROR_STOP=1 -c \
  "CREATE ROLE freehold_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; CREATE ROLE freehold_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; CREATE ROLE freehold_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;"
docker exec "$container" pg_restore -U postgres -d freehold_rehearsal_disposable --exit-on-error /tmp/freehold.dump
docker exec "$container" rm -f /tmp/freehold.dump
snapshot() {
  docker exec "$container" psql -U postgres -d freehold_rehearsal_disposable -X -Atc "$1"
}
posture_before=$(snapshot "SELECT (SELECT sandbox_enabled::text FROM freehold.ledger_settings WHERE singleton)||','||(SELECT enabled::text FROM freehold.demo_settings WHERE singleton)")
counts_before=$(snapshot "SELECT (SELECT count(*) FROM freehold.users)||','||(SELECT count(*) FROM freehold.accounts)||','||(SELECT count(*) FROM freehold.ledger_journals)||','||(SELECT count(*) FROM freehold.ledger_entries)||','||(SELECT count(*) FROM freehold.ledger_journals j WHERE (SELECT coalesce(sum(CASE WHEN e.side='DEBIT' THEN e.amount_minor ELSE -e.amount_minor END),0) FROM freehold.ledger_entries e WHERE e.journal_id=j.id)<>0)")
balances_before=$(snapshot "SELECT coalesce(string_agg(currency_code||'='||total, ',' ORDER BY currency_code), '') FROM (SELECT currency_code, sum(available_minor)::text AS total FROM freehold.accounts GROUP BY currency_code) s")
pg_address=$(docker port "$container" 5432/tcp)
export API_DATABASE_PASSWORD="$api_password" WORKER_DATABASE_PASSWORD="$worker_password"
export VERIFIER_DATABASE_PASSWORD="$verifier_password" AUTH_DATABASE_PASSWORD="$auth_password"
export SCHEDULER_DATABASE_PASSWORD="$scheduler_password"
export MIGRATION_DATABASE_URL="postgresql://postgres:${pg_password}@${pg_address}/freehold_rehearsal_disposable"
export NODE_ENV=test DEMO_MODE=false DEMO_BOOTSTRAP_TOKEN=''
started=$(date +%s%3N)
node scripts/migrate.mjs >"$scratch/migrate.log"
migrate_ms=$(( $(date +%s%3N) - started ))
posture_after=$(snapshot "SELECT (SELECT sandbox_enabled::text FROM freehold.ledger_settings WHERE singleton)||','||(SELECT enabled::text FROM freehold.demo_settings WHERE singleton)")
counts_after=$(snapshot "SELECT (SELECT count(*) FROM freehold.users)||','||(SELECT count(*) FROM freehold.accounts)||','||(SELECT count(*) FROM freehold.ledger_journals)||','||(SELECT count(*) FROM freehold.ledger_entries)||','||(SELECT count(*) FROM freehold.ledger_journals j WHERE (SELECT coalesce(sum(CASE WHEN e.side='DEBIT' THEN e.amount_minor ELSE -e.amount_minor END),0) FROM freehold.ledger_entries e WHERE e.journal_id=j.id)<>0)")
balances_after=$(snapshot "SELECT coalesce(string_agg(currency_code||'='||total, ',' ORDER BY currency_code), '') FROM (SELECT currency_code, sum(available_minor)::text AS total FROM freehold.accounts GROUP BY currency_code) s")
applied=$(snapshot "SELECT string_agg(name, ',' ORDER BY name) FROM freehold_deploy.migrations")
roles=$(snapshot "SELECT rolname||':'||rolcanlogin||':'||rolsuper||':'||rolbypassrls FROM pg_roles WHERE rolname LIKE 'freehold_%' ORDER BY rolname")
api_reads=$(snapshot "SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='freehold' AND c.relkind='r' AND has_table_privilege('freehold_api', c.oid, 'SELECT')")
export VERIFY_DATABASE_URL="postgresql://freehold_verifier:${verifier_password}@${pg_address}/freehold_rehearsal_disposable"
set +e
node scripts/verify-ledger.mjs >"$scratch/verifier.json"
verifier_exit=$?
CHECK_DATABASE_URL="$MIGRATION_DATABASE_URL" VERIFY_DATABASE_URL="$VERIFY_DATABASE_URL" node scripts/deployment-check.mjs --json --out "$scratch/deployment.json"
check_exit=$?
set -e
beat_id=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')
if docker exec -e PGPASSWORD="$scheduler_password" "$container" psql -h 127.0.0.1 -U freehold_scheduler -d freehold_rehearsal_disposable -X -v ON_ERROR_STOP=1 -c "SELECT freehold.scheduler_record_heartbeat('${beat_id}'::uuid)" >/dev/null; then
  scheduler_ok=t
else
  scheduler_ok=f
fi
worker_ok=$(docker exec -e PGPASSWORD="$worker_password" "$container" psql -h 127.0.0.1 -U freehold_worker -d freehold_rehearsal_disposable -X -Atc "SELECT (freehold.worker_backlog_status()->>'count') IS NOT NULL")
after=$(docker exec "$persistent" psql -U postgres -d freehold -X -Atc "SELECT coalesce(string_agg(name, ',' ORDER BY name), '') FROM freehold_deploy.migrations")
rm -f "$scratch/freehold.dump"
export PERSISTENT_NAME="$persistent"
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const verifier = JSON.parse(readFileSync(process.argv[1], "utf8"));
const deployment = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = {
  generatedAt: new Date().toISOString(),
  reportType: "freehold.phase8-migration-rehearsal",
  persistentContainer: process.env.PERSISTENT_NAME,
  persistentMutated: process.argv[3] !== process.argv[4],
  persistentMigrationsBefore: process.argv[3],
  persistentMigrationsAfter: process.argv[4],
  dumpSha256: process.argv[5],
  dumpBytes: Number(process.argv[6]),
  dumpRetained: false,
  postureBefore: process.argv[20],
  postureAfter: process.argv[21],
  postureNote: "DEMO_MODE=false sets sandbox_enabled and demo_settings.enabled to false on the disposable copy. That is a control-flag change, not a balance change.",
  countsBefore: process.argv[7],
  countsAfter: process.argv[8],
  balancesBefore: process.argv[9],
  balancesAfter: process.argv[10],
  countsMatch: process.argv[7] === process.argv[8],
  balancesMatch: process.argv[9] === process.argv[10],
  applied: process.argv[11],
  migrateMs: Number(process.argv[12]),
  roles: process.argv[13],
  apiTableReads: process.argv[14],
  schedulerHeartbeat: process.argv[15] === "t",
  workerBacklog: process.argv[16] === "t",
  verifierOutcome: verifier.outcome ?? null,
  verifierExit: Number(process.argv[17]),
  deploymentResult: deployment.result,
  deploymentExit: Number(process.argv[18]),
  cutover: { executed: false, requiresExplicitApproval: true, target: "do not run against Compose without a new backup and explicit approval" },
  signature: null,
};
const ok = report.persistentMutated === false && report.countsMatch && report.balancesMatch && report.verifierOutcome === "VERIFIED" && report.deploymentResult !== "READY" && report.schedulerHeartbeat && report.workerBacklog && report.apiTableReads === "currencies";
report.passed = ok;
writeFileSync(process.argv[19], JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log((ok ? "PASS" : "FAIL") + " migration rehearsal verifier " + report.verifierOutcome + " deployment " + report.deploymentResult + " persistentMutated " + report.persistentMutated);
if (!ok) process.exit(1);
' "$scratch/verifier.json" "$scratch/deployment.json" "$before" "$after" "$sha" "$bytes" "$counts_before" "$counts_after" "$balances_before" "$balances_after" "$applied" "$migrate_ms" "$roles" "$api_reads" "$scheduler_ok" "$worker_ok" "$verifier_exit" "$check_exit" "$out" "$posture_before" "$posture_after"
