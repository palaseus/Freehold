#!/usr/bin/env bash
# Disposable production boot. Does not connect to the persistent Compose project.
# Proves TLS, Redis authentication, migration 019, heartbeats, /ready, and the
# verifier. The deployment checker must stay NOT_READY because the backup is local.
set -euo pipefail
cd "$(dirname "$0")/.."
work=$(mktemp -d /tmp/freehold-production-rehearsal.XXXXXX)
pg="freehold-prod-pg-$$"
redis="freehold-prod-redis-$$"
pids=()
cleanup() {
  local pid
  for pid in "${pids[@]:-}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  docker rm -f -v "$pg" "$redis" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# Container names are unique to this process. This script never names the Compose project.

openssl req -x509 -newkey rsa:2048 -nodes -days 2 -keyout "$work/ca.key" -out "$work/ca.crt" -subj '/CN=Freehold disposable CA' >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout "$work/server.key" -out "$work/server.csr" -subj '/CN=postgres' >/dev/null 2>&1
printf 'subjectAltName=DNS:postgres,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' >"$work/server.ext"
openssl x509 -req -in "$work/server.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" -CAcreateserial -out "$work/server.crt" -days 2 -extfile "$work/server.ext" >/dev/null 2>&1
chmod 644 "$work/ca.crt" "$work/server.crt"
docker run --rm -v "$work:/certs" postgres:16 bash -c 'chown 999:999 /certs/server.key && chmod 600 /certs/server.key'
cat >"$work/start-postgres.sh" <<'EOF'
#!/bin/bash
set -euo pipefail
mkdir -p /wal-archive
chown postgres:postgres /wal-archive
chmod 700 /wal-archive
exec docker-entrypoint.sh postgres \
  -c ssl=on \
  -c ssl_cert_file=/certs/server.crt \
  -c ssl_key_file=/certs/server.key \
  -c wal_level=replica \
  -c archive_mode=on \
  -c archive_timeout=60 \
  -c archive_command='test ! -f /wal-archive/%f && cp %p /wal-archive/%f'
EOF
chmod 755 "$work/start-postgres.sh"

pg_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
api_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
worker_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
verifier_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
auth_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
scheduler_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
redis_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
totp_key=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')
auth_token=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
api_port=$(node -e 'const n=require("node:net"); const s=n.createServer(); s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port)); s.close();});')

docker run --name "$pg" -d -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD="$pg_password" -e POSTGRES_DB=freehold_production_rehearsal \
  -v "$work/ca.crt:/certs/ca.crt:ro" -v "$work/server.crt:/certs/server.crt:ro" -v "$work/server.key:/certs/server.key:ro" \
  -v "$work/start-postgres.sh:/start-postgres.sh:ro" \
  postgres:16 bash /start-postgres.sh >/dev/null
docker run --name "$redis" -d -p 127.0.0.1::6379 redis:7-alpine \
  redis-server --requirepass "$redis_password" --appendonly yes >/dev/null

# pg_isready is true during the image's temporary init server, which then shuts down.
# Wait until the restarted server is the one with ssl=on.
for attempt in $(seq 1 100); do
  ssl_state=$(docker exec "$pg" psql -U postgres -d freehold_production_rehearsal -X -Atc 'SHOW ssl' 2>/dev/null || true)
  redis_ok=false
  if docker exec -e REDISCLI_AUTH="$redis_password" "$redis" redis-cli ping >/dev/null 2>&1; then redis_ok=true; fi
  if [ "$ssl_state" = "on" ] && [ "$redis_ok" = true ]; then break; fi
  if [ "$attempt" -eq 100 ]; then echo 'Disposable production infrastructure failed to start' >&2; docker logs "$pg" 2>&1 | tail -n 30 >&2; exit 1; fi
  sleep 0.3
done
pg_address=$(docker port "$pg" 5432/tcp)
redis_address=$(docker port "$redis" 6379/tcp)
ssl_query="sslmode=verify-full&sslrootcert=${work}/ca.crt"
migration_url="postgresql://postgres:${pg_password}@${pg_address}/freehold_production_rehearsal?${ssl_query}"
api_url="postgresql://freehold_api:${api_password}@${pg_address}/freehold_production_rehearsal?${ssl_query}"
auth_url="postgresql://freehold_auth:${auth_password}@${pg_address}/freehold_production_rehearsal?${ssl_query}"
worker_url="postgresql://freehold_worker:${worker_password}@${pg_address}/freehold_production_rehearsal?${ssl_query}"
verifier_url="postgresql://freehold_verifier:${verifier_password}@${pg_address}/freehold_production_rehearsal?${ssl_query}"
scheduler_url="postgresql://freehold_scheduler:${scheduler_password}@${pg_address}/freehold_production_rehearsal?${ssl_query}"
check_url="postgresql://postgres:${pg_password}@${pg_address}/freehold_production_rehearsal?${ssl_query}"
redis_url="redis://:${redis_password}@${redis_address}"

export API_DATABASE_PASSWORD="$api_password" WORKER_DATABASE_PASSWORD="$worker_password"
export VERIFIER_DATABASE_PASSWORD="$verifier_password" AUTH_DATABASE_PASSWORD="$auth_password"
export SCHEDULER_DATABASE_PASSWORD="$scheduler_password"
export MIGRATION_DATABASE_URL="$migration_url" DEMO_MODE=false DEMO_BOOTSTRAP_TOKEN=
node scripts/migrate.mjs >"$work/migrate.log"
npm run build >"$work/build.log"

redact() { sed -E 's#://[^[:space:]/]+:[^@[:space:]]+@#://redacted@#g'; }
env -i PATH="$PATH" HOME="${HOME:-/tmp}" \
  NODE_ENV=production AUTH_DATABASE_URL="$auth_url" REDIS_URL="$redis_url" \
  TOTP_ENCRYPTION_KEY="$totp_key" AUTH_INTERNAL_TOKEN="$auth_token" \
  AUTH_BIND_HOST=127.0.0.1 AUTH_PORT=0 \
  node dist/src/auth-server.js >"$work/auth.log" 2>&1 &
pids+=("$!")
for attempt in $(seq 1 50); do
  if grep -q '^AUTH_LISTENING ' "$work/auth.log"; then break; fi
  if ! kill -0 "${pids[0]}" >/dev/null 2>&1; then echo 'Auth process exited' >&2; redact <"$work/auth.log" >&2; exit 1; fi
  if [ "$attempt" -eq 50 ]; then echo 'Auth process did not listen' >&2; redact <"$work/auth.log" >&2; exit 1; fi
  sleep 0.2
done
auth_port=$(sed -n 's/^AUTH_LISTENING //p' "$work/auth.log" | head -1)

env -i PATH="$PATH" HOME="${HOME:-/tmp}" \
  NODE_ENV=production PORT="$api_port" BIND_HOST=127.0.0.1 \
  DATABASE_URL="$api_url" AUTH_SERVICE_URL="http://127.0.0.1:${auth_port}" \
  AUTH_INTERNAL_TOKEN="$auth_token" REDIS_URL="$redis_url" TOTP_ENCRYPTION_KEY="$totp_key" \
  APP_ORIGIN=https://ledger.example COOKIE_SECURE=true \
  node dist/src/main.js >"$work/api.log" 2>&1 &
pids+=("$!")
env -i PATH="$PATH" HOME="${HOME:-/tmp}" \
  NODE_ENV=production WORKER_DATABASE_URL="$worker_url" \
  node dist/src/worker.js >"$work/worker.log" 2>&1 &
pids+=("$!")
env -i PATH="$PATH" HOME="${HOME:-/tmp}" \
  NODE_ENV=production SCHEDULER_DATABASE_URL="$scheduler_url" \
  node dist/src/scheduler.js >"$work/scheduler.log" 2>&1 &
pids+=("$!")

ready=false
for attempt in $(seq 1 50); do
  if node -e 'fetch(process.argv[1]).then(async r=>{const b=await r.json(); process.exit(r.ok && b.status==="accepting"?0:1)}).catch(()=>process.exit(1))' "http://127.0.0.1:${api_port}/ready"; then ready=true; break; fi
  if ! kill -0 "${pids[1]}" >/dev/null 2>&1; then echo 'API process exited' >&2; redact <"$work/api.log" >&2; exit 1; fi
  sleep 0.2
done
if [ "$ready" != true ]; then echo 'API /ready did not accept' >&2; redact <"$work/api.log" >&2; exit 1; fi

for attempt in $(seq 1 40); do
  counts=$(docker exec "$pg" psql -U postgres -d freehold_production_rehearsal -X -Atc \
    "SELECT (SELECT count(*) FROM freehold.worker_heartbeats), (SELECT count(*) FROM freehold.scheduler_heartbeats)")
  worker_beats=${counts%%|*}
  scheduler_beats=${counts##*|}
  if [ "${worker_beats:-0}" != "0" ] && [ "${scheduler_beats:-0}" != "0" ]; then break; fi
  if [ "$attempt" -eq 40 ]; then
    echo 'Heartbeats were not recorded' >&2
    redact <"$work/worker.log" >&2
    redact <"$work/scheduler.log" >&2
    exit 1
  fi
  sleep 0.5
done

if [ ! -f web/.next/BUILD_ID ]; then
  npm --prefix web run build >"$work/web-build.log"
fi

printf 'not a database\n' >"$work/separate-source"
mkdir -p "$work/export-a" "$work/export-b"
env -u DATABASE_URL -u AUTH_DATABASE_URL -u SCHEDULER_DATABASE_URL \
  BACKUP_EXPORT_DIR="$work/export-a" BACKUP_OFFSITE_DEST="$work/export-b" \
  bash scripts/backup-export.sh "$work/separate-source" >"$work/separate-export.log"
separate_manifest=$(find "$work/export-a" -name manifest.json -print -quit)
node --input-type=module -e '
import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
if (manifest.offsiteCopy !== false) {
  console.error("A same-host copy set offsiteCopy");
  process.exit(1);
}
' "$separate_manifest"

docker exec -e PGPASSWORD="$pg_password" "$pg" \
  pg_dump -h 127.0.0.1 -U postgres -Fc -d freehold_production_rehearsal -f /tmp/rehearsal.dump
docker cp "$pg:/tmp/rehearsal.dump" "$work/rehearsal.dump" >/dev/null
docker exec "$pg" rm -f /tmp/rehearsal.dump
mkdir -p "$work/backup-export"
passphrase=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
env -u DATABASE_URL -u AUTH_DATABASE_URL -u SCHEDULER_DATABASE_URL \
  BACKUP_EXPORT_DIR="$work/backup-export" BACKUP_EXPORT_PASSPHRASE="$passphrase" \
  bash scripts/backup-export.sh "$work/rehearsal.dump" >"$work/backup-export.log"
unset passphrase
manifest=$(find "$work/backup-export" -name manifest.json -print -quit)
node --input-type=module -e '
import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
if (manifest.offsiteCopy !== false || manifest.encrypted !== true || !manifest.sha256) {
  console.error("Disposable dump manifest is not a local encrypted backup");
  process.exit(1);
}
' "$manifest"

out="${PRODUCTION_REHEARSAL_OUT:-docs/evidence/production-rehearsal-latest.json}"
set +e
env -u DATABASE_URL -u AUTH_DATABASE_URL -u WORKER_DATABASE_URL -u SCHEDULER_DATABASE_URL -u MIGRATION_DATABASE_URL \
  CHECK_DATABASE_URL="$check_url" VERIFY_DATABASE_URL="$verifier_url" \
  CHECK_API_URL="http://127.0.0.1:${api_port}/ready" CHECK_BACKUP_MANIFEST="$manifest" \
  node scripts/deployment-check.mjs --json --out "$out" >"$work/check.out"
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
if (report.result !== 'NOT_READY' || code !== 2) {
  console.error(`Expected NOT_READY exit 2, got ${report.result} exit ${code}`);
  process.exit(1);
}
const byId = Object.fromEntries(report.checks.map(check => [check.id, check.status]));
const allowedFail = new Set(['backup_availability']);
const problems = Object.entries(byId).filter(([id, status]) => status !== 'PASS' && !(allowedFail.has(id) && status === 'FAIL'));
if (byId.backup_availability !== 'FAIL' || problems.length) {
  console.error(JSON.stringify(byId));
  process.exit(1);
}
console.log(`PASS production rehearsal NOT_READY exit ${code}`);
for (const [id, status] of Object.entries(byId)) console.log(`${status}\t${id}`);
EOF
archive_count=$(docker exec "$pg" bash -c 'ls /wal-archive | wc -l' | tr -d ' ')
echo "PASS wal archive files ${archive_count}"
