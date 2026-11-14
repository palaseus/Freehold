#!/usr/bin/env bash
# Isolated, persistent LOCAL sandbox. Never uses the existing Compose project.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
state=tmp/local-deployment
mkdir -p "$state"
chmod 700 "$state"
node --input-type=module <<'JS'
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const path = 'tmp/local-deployment/deployment.env';
if (!existsSync(path)) {
  const values = Object.fromEntries(['POSTGRES_PASSWORD', 'API_DATABASE_PASSWORD', 'WORKER_DATABASE_PASSWORD',
    'VERIFIER_DATABASE_PASSWORD', 'AUTH_DATABASE_PASSWORD', 'SCHEDULER_DATABASE_PASSWORD', 'AUTH_INTERNAL_TOKEN',
    'DEMO_BOOTSTRAP_TOKEN', 'DEMO_USER_PASSWORD'].map(key => [key, randomBytes(32).toString('base64url')]));
  Object.assign(values, { TOTP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), DEMO_MODE: 'true',
    APP_ORIGIN: 'http://localhost:3100', COOKIE_SECURE: 'false', API_NODE_ENV: 'development', WEB_PORT: '3100', API_PORT: '3101' });
  writeFileSync(path, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
}
JS
if ! docker compose version >/dev/null 2>&1; then
  echo 'Install the current Docker Compose plugin (docker compose). The legacy docker-compose client is unsupported.' >&2
  exit 1
fi
compose=(docker compose)
compose+=(-p freehold-local --env-file "$state/deployment.env" -f compose.yaml -f deploy/compose.local.yaml)
"${compose[@]}" up -d --build postgres redis migrate auth api worker scheduler web
for attempt in $(seq 1 90); do
  if node -e 'fetch("http://127.0.0.1:3101/ready").then(async r=>process.exit(r.ok && (await r.json()).status==="accepting"?0:1)).catch(()=>process.exit(1))'; then break; fi
  if [ "$attempt" -eq 90 ]; then echo 'Local API did not become ready. Inspect the freehold-local project logs.' >&2; exit 1; fi
  sleep 1
done
if [ ! -f "$state/accounts.json" ]; then
  # Seed prints credentials: keep its output private and publish only on success.
  "${compose[@]}" --profile demo run --rm -T seed >"$state/seed-output.tmp" 2>"$state/seed-error.log"
  node --input-type=module - "$state/seed-output.tmp" "$state/accounts.json" <<'JS'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
writeFileSync(process.argv[3], `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
unlinkSync(process.argv[2]);
JS
fi
for attempt in $(seq 1 60); do
  if node -e 'fetch("http://127.0.0.1:3100/login").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; then break; fi
  if [ "$attempt" -eq 60 ]; then echo 'Local web server did not become ready.' >&2; exit 1; fi
  sleep 1
done
"${compose[@]}" ps
echo 'Local sandbox: http://localhost:3100'
echo 'Demo login credentials: tmp/local-deployment/accounts.json (private file)'
