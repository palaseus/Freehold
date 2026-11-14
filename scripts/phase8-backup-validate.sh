#!/usr/bin/env bash
# Build a disposable logical backup and validate it in a second disposable database.
# Does not read or write the Compose database.
set -euo pipefail
cd "$(dirname "$0")/.."
source_container="freehold-bval-src-$$"
work=$(mktemp -d /tmp/freehold-bval-work.XXXXXX)
chmod 700 "$work"
cleanup() {
  docker rm -f -v "$source_container" >/dev/null 2>&1 || true;
  rm -rf "$work"
}
trap cleanup EXIT
pg_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
for name in api worker verifier auth scheduler; do
  printf -v "${name}_password" '%s' "$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')"
done
docker run --name "$source_container" -d -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD="$pg_password" -e POSTGRES_DB=freehold_backup_source_disposable postgres:16 >/dev/null
for attempt in $(seq 1 100); do
  if docker exec "$source_container" psql -h 127.0.0.1 -U postgres -d freehold_backup_source_disposable -X -Atc 'SELECT 1' >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 100 ]; then echo 'Backup source database failed to start' >&2; exit 1; fi
  sleep 0.2
done
pg_address=$(docker port "$source_container" 5432/tcp)
export API_DATABASE_PASSWORD="$api_password" WORKER_DATABASE_PASSWORD="$worker_password"
export VERIFIER_DATABASE_PASSWORD="$verifier_password" AUTH_DATABASE_PASSWORD="$auth_password"
export SCHEDULER_DATABASE_PASSWORD="$scheduler_password"
export MIGRATION_DATABASE_URL="postgresql://postgres:${pg_password}@${pg_address}/freehold_backup_source_disposable"
export NODE_ENV=test DEMO_MODE=false DEMO_BOOTSTRAP_TOKEN=''
node scripts/migrate.mjs >/dev/null
docker exec "$source_container" pg_dump -U postgres -d freehold_backup_source_disposable -Fc -f /tmp/source.dump
docker cp "$source_container:/tmp/source.dump" "$work/ledger.dump"
docker exec "$source_container" rm -f /tmp/source.dump
sha=$(sha256sum "$work/ledger.dump" | awk 'NR==1 { print $1 }')
mkdir -p "$work/set" "$work/tampered" "$work/empty"
chmod 700 "$work/set" "$work/tampered"
cp "$work/ledger.dump" "$work/set/ledger.dump"
printf '{"manifestType":"freehold.backup-export","generatedAt":"%s","sha256":"%s","encrypted":false,"offsiteCopy":false}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$sha" >"$work/set/manifest.json"
out="${PHASE8_BACKUP_OUT:-docs/evidence/phase8-backup-validation.json}"
set +e
node scripts/backup-validate.mjs --set "$work/set" --restore --out "$out"
restore_code=$?
node scripts/backup-validate.mjs --set "$work/empty" >"$work/empty.out"
empty_code=$?
cp "$work/set/ledger.dump" "$work/tampered/ledger.dump"
cp "$work/set/manifest.json" "$work/tampered/manifest.json"
printf '\n' >>"$work/tampered/ledger.dump"
node scripts/backup-validate.mjs --set "$work/tampered" --restore >"$work/tampered.out"
tamper_code=$?
set -e
empty_outcome=$(head -1 "$work/empty.out")
tamper_outcome=$(head -1 "$work/tampered.out")
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const report = JSON.parse(readFileSync(process.argv[1], "utf8"));
const summary = { restore: report.outcome, restoreExit: Number(process.argv[2]), empty: process.argv[3], emptyExit: Number(process.argv[4]), tampered: process.argv[5], tamperExit: Number(process.argv[6]), offsiteCopy: report.offsiteCopy, walContinuity: report.walContinuity, primaryTouched: report.primaryTouched };
const ok = report.outcome === "VERIFIED" && report.restoreCompleted === true && report.offsiteCopy === false && summary.empty === "UNAVAILABLE" && summary.tampered === "MISMATCH";
summary.passed = ok;
writeFileSync(process.argv[1], JSON.stringify({ ...report, cases: summary, passed: ok }, null, 2) + "\n");
if (!ok) process.exit(1);
' "$out" "$restore_code" "$empty_outcome" "$empty_code" "$tamper_outcome" "$tamper_code"
echo "PASS backup validation restore VERIFIED tamper MISMATCH empty UNAVAILABLE offsiteCopy false"
