#!/usr/bin/env bash
# Disposable browser drill. Does not attach to the Compose project.
# Prints no passwords. Evidence records whether Playwright actually ran.
set -euo pipefail
set -m
cd "$(dirname "$0")/.."
node --input-type=module -e 'import { refuseEvidenceOverwrite } from "./scripts/lib/evidence-output.mjs"; refuseEvidenceOverwrite(process.env.PHASE7_BROWSER_OUT ?? "docs/evidence/browser-run.json");'
container="freehold-browser-$$"
redis_container="${container}-redis"
auth_pid=""
api_pid=""
web_pid=""
sched_pid=""
scratch=$(mktemp -d)
chmod 700 "$scratch"
cleanup() {
  if [ -n "${FREEHOLD_SCHEDULER_PID_FILE:-}" ] && [ -f "$FREEHOLD_SCHEDULER_PID_FILE" ]; then
    while IFS= read -r pid; do
      if [ -n "$pid" ]; then kill -- -"$pid" >/dev/null 2>&1 || kill "$pid" >/dev/null 2>&1 || true; fi
    done <"$FREEHOLD_SCHEDULER_PID_FILE"
  fi
  if [ -n "$sched_pid" ]; then kill -- -"$sched_pid" >/dev/null 2>&1 || kill "$sched_pid" >/dev/null 2>&1 || true; fi
  if [ -n "$web_pid" ]; then kill -- -"$web_pid" >/dev/null 2>&1 || kill "$web_pid" >/dev/null 2>&1 || true; fi
  if [ -n "$api_pid" ]; then kill -- -"$api_pid" >/dev/null 2>&1 || kill "$api_pid" >/dev/null 2>&1 || true; fi
  if [ -n "$auth_pid" ]; then kill -- -"$auth_pid" >/dev/null 2>&1 || kill "$auth_pid" >/dev/null 2>&1 || true; fi
  docker rm -f -v "$container" "$redis_container" >/dev/null 2>&1 || true
  rm -rf "$scratch" web/test-results web/playwright-report
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
customer_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("base64url"))')
admin_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("base64url"))')
customer_email="browser-customer-${RANDOM}@example.com"
admin_email="browser-admin-${RANDOM}@example.com"
reviewer_email="browser-reviewer-${RANDOM}@example.com"
payee_email="browser-payee-${RANDOM}@example.com"
reviewer_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("base64url"))')
docker run --name "$container" -d -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD="$pg_password" -e POSTGRES_DB=freehold_browser_disposable postgres:16 >/dev/null
docker run --name "$redis_container" -d -p 127.0.0.1::6379 redis:7-alpine >/dev/null
for attempt in $(seq 1 100); do
  if docker exec "$container" psql -h 127.0.0.1 -U postgres -d freehold_browser_disposable -X -Atc 'SELECT 1' >/dev/null 2>&1 \
    && docker exec "$redis_container" redis-cli ping >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 100 ]; then echo 'Browser infrastructure failed to start' >&2; exit 1; fi
  sleep 0.2
done
pg_address=$(docker port "$container" 5432/tcp)
redis_address=$(docker port "$redis_container" 6379/tcp)
export API_DATABASE_PASSWORD="$api_password" WORKER_DATABASE_PASSWORD="$worker_password"
export VERIFIER_DATABASE_PASSWORD="$verifier_password" AUTH_DATABASE_PASSWORD="$auth_password"
export SCHEDULER_DATABASE_PASSWORD="$scheduler_password"
export MIGRATION_DATABASE_URL="postgresql://postgres:${pg_password}@${pg_address}/freehold_browser_disposable"
export DEMO_MODE=false DEMO_BOOTSTRAP_TOKEN=''
node scripts/migrate.mjs
npx tsc -p tsconfig.json --pretty false --noEmit false
web_port=$(node -e 'const s=require("net").createServer(); s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port)); s.close();})')
api_port=$(node -e 'const s=require("net").createServer(); s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port)); s.close();})')
web_origin="http://127.0.0.1:${web_port}"
env -u DATABASE_URL \
  AUTH_DATABASE_URL="postgresql://freehold_auth:${auth_password}@${pg_address}/freehold_browser_disposable" \
  REDIS_URL="redis://${redis_address}" \
  TOTP_ENCRYPTION_KEY="$totp_key" \
  AUTH_INTERNAL_TOKEN="$auth_token" \
  AUTH_PORT=0 AUTH_BIND_HOST=127.0.0.1 \
  node dist/src/auth-server.js >"$scratch/auth.log" 2>&1 &
auth_pid=$!
for attempt in $(seq 1 80); do
  if grep -q '^AUTH_LISTENING ' "$scratch/auth.log"; then break; fi
  if ! kill -0 "$auth_pid" >/dev/null 2>&1; then echo 'Auth process exited before listening' >&2; exit 1; fi
  if [ "$attempt" -eq 80 ]; then echo 'Auth process did not listen' >&2; exit 1; fi
  sleep 0.1
done
auth_port=$(sed -n 's/^AUTH_LISTENING //p' "$scratch/auth.log" | head -1)
env -u AUTH_DATABASE_URL \
  NODE_ENV=test BIND_HOST=127.0.0.1 PORT="$api_port" \
  DATABASE_URL="postgresql://freehold_api:${api_password}@${pg_address}/freehold_browser_disposable" \
  AUTH_SERVICE_URL="http://127.0.0.1:${auth_port}" \
  AUTH_INTERNAL_TOKEN="$auth_token" \
  REDIS_URL="redis://${redis_address}" \
  TOTP_ENCRYPTION_KEY="$totp_key" \
  APP_ORIGIN="$web_origin" COOKIE_SECURE=false DEMO_MODE=false \
  node dist/src/main.js >"$scratch/api.log" 2>&1 &
api_pid=$!
for attempt in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:${api_port}/openapi.json" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$api_pid" >/dev/null 2>&1; then echo 'API exited before readiness' >&2; exit 1; fi
  if [ "$attempt" -eq 100 ]; then echo 'API did not become ready' >&2; exit 1; fi
  sleep 0.2
done
(
  cd web
  exec env API_ORIGIN="http://127.0.0.1:${api_port}" \
    XDG_CONFIG_HOME=/tmp/freehold-next-config NEXT_TELEMETRY_DISABLED=1 \
    npx next dev --webpack --hostname 127.0.0.1 --port "$web_port"
) >"$scratch/web.log" 2>&1 &
web_pid=$!
for attempt in $(seq 1 150); do
  if curl -fsS "$web_origin/login" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$web_pid" >/dev/null 2>&1; then echo 'Web process exited before readiness' >&2; tail -n 40 "$scratch/web.log" >&2; exit 1; fi
  if [ "$attempt" -eq 150 ]; then echo 'Web process did not become ready' >&2; exit 1; fi
  sleep 0.4
done
export FREEHOLD_API_ORIGIN="http://127.0.0.1:${api_port}"
export FREEHOLD_WEB_ORIGIN="$web_origin"
export FREEHOLD_PG_URL="$MIGRATION_DATABASE_URL"
export FREEHOLD_CUSTOMER_EMAIL="$customer_email"
export FREEHOLD_CUSTOMER_PASSWORD="$customer_password"
export FREEHOLD_ADMIN_EMAIL="$admin_email"
export FREEHOLD_ADMIN_PASSWORD="$admin_password"
export FREEHOLD_REVIEWER_EMAIL="$reviewer_email"
export FREEHOLD_REVIEWER_PASSWORD="$reviewer_password"
export FREEHOLD_PAYEE_EMAIL="$payee_email"
node --input-type=module >"$scratch/seed.out" <<'EOF'
import pg from 'pg';
import { Secret, TOTP } from 'otpauth';
const origin = process.env.FREEHOLD_WEB_ORIGIN;
const api = process.env.FREEHOLD_API_ORIGIN;
async function register(email, password, totp) {
  const response = await fetch(`${api}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, password, ...(totp ?? {}) }),
  });
  const body = await response.json().catch(() => ({}));
  if (response.status !== 201 || !body.userId) {
    process.stderr.write(`register failed status ${response.status} code ${body.code ?? 'UNKNOWN'}\n`);
    process.exit(1);
  }
  return body.userId;
}
function accountId(body) {
  const value = typeof body === 'string' ? JSON.parse(body) : body;
  if (!value || typeof value.accountId !== 'string') throw new Error('account was not created');
  return value.accountId;
}
const secret = new Secret({ size: 20 });
const totp = new TOTP({ issuer: 'Freehold', label: 'browser-admin', algorithm: 'SHA1', digits: 6, period: 30, secret });
const reviewerSecret = new Secret({ size: 20 });
const reviewerTotp = new TOTP({ issuer: 'Freehold', label: 'browser-reviewer', algorithm: 'SHA1', digits: 6, period: 30, secret: reviewerSecret });
const adminId = await register(process.env.FREEHOLD_ADMIN_EMAIL, process.env.FREEHOLD_ADMIN_PASSWORD, { totpSecret: secret.base32, totp: totp.generate() });
const reviewerId = await register(process.env.FREEHOLD_REVIEWER_EMAIL, process.env.FREEHOLD_REVIEWER_PASSWORD, { totpSecret: reviewerSecret.base32, totp: reviewerTotp.generate() });
const customerId = await register(process.env.FREEHOLD_CUSTOMER_EMAIL, process.env.FREEHOLD_CUSTOMER_PASSWORD);
const payeeId = await register(process.env.FREEHOLD_PAYEE_EMAIL, process.env.FREEHOLD_CUSTOMER_PASSWORD);
const client = new pg.Client({ connectionString: process.env.FREEHOLD_PG_URL });
await client.connect();
const updated = await client.query(`UPDATE freehold.users SET role='ADMIN' WHERE id=$1 AND role='USER'`, [adminId]);
if (updated.rowCount !== 1) throw new Error('admin role was not set');
const reviewerUpdated = await client.query(`UPDATE freehold.users SET role='ADMIN' WHERE id=$1 AND role='USER'`, [reviewerId]);
if (reviewerUpdated.rowCount !== 1) throw new Error('reviewer role was not set');
for (const capability of ['AUDITOR', 'INSTITUTION_ADMIN', 'COMPLIANCE_OFFICER', 'ACCOUNT_ADMIN', 'EMERGENCY_CONTROL']) {
  await client.query(`SELECT freehold.governance_provision_capability($1,$2,'phase7-browser-disposable',true)`, [adminId, capability]);
}
await client.query(`SELECT freehold.governance_provision_capability($1,$2,'phase7-browser-disposable',true)`, [reviewerId, 'FINANCIAL_REVIEWER']);
await client.query(`SELECT freehold.governance_provision_capability($1,$2,'phase7-browser-disposable',true)`, [reviewerId, 'INSTITUTION_ADMIN']);
const customerAccount = accountId((await client.query(`SELECT freehold.create_account($1,'USD',$2,gen_random_uuid()) AS body`, [customerId, `browser-customer-${customerId}`])).rows[0].body);
const destination = accountId((await client.query(`SELECT freehold.create_account($1,'USD',$2,gen_random_uuid()) AS body`, [payeeId, `browser-payee-${payeeId}`])).rows[0].body);
const openId = await register(`browser-open-${customerId}@example.com`, process.env.FREEHOLD_CUSTOMER_PASSWORD);
const openDestination = accountId((await client.query(`SELECT freehold.create_account($1,'USD',$2,gen_random_uuid()) AS body`, [openId, `browser-open-${openId}`])).rows[0].body);
await client.query(`UPDATE freehold.ledger_settings SET sandbox_enabled=true WHERE singleton`);
await client.query(`SELECT freehold.sandbox_fund_account($1,$2,10000,$3,'browser sandbox funding',gen_random_uuid())`, [adminId, customerAccount, `browser-fund-${customerId}`]);
await client.end();
process.stdout.write(`${secret.base32}\n${destination}\n${customerAccount}\n${reviewerSecret.base32}\n${openDestination}\n`);
EOF
chmod 600 "$scratch/seed.out"
mapfile -t seed < "$scratch/seed.out"
if [ "${#seed[@]}" -lt 5 ] || [ -z "${seed[0]}" ] || [ -z "${seed[1]}" ] || [ -z "${seed[3]}" ] || [ -z "${seed[4]}" ]; then
  echo 'Browser seed did not return authenticator secrets and a destination account' >&2
  exit 1
fi
export FREEHOLD_ADMIN_TOTP_SECRET="${seed[0]}"
export FREEHOLD_DESTINATION_ACCOUNT_ID="${seed[1]}"
export FREEHOLD_CUSTOMER_ACCOUNT_ID="${seed[2]}"
export FREEHOLD_REVIEWER_TOTP_SECRET="${seed[3]}"
export FREEHOLD_OPEN_DESTINATION_ACCOUNT_ID="${seed[4]}"
export FREEHOLD_CUSTOMER_STATE="$scratch/customer-state.json"
export FREEHOLD_ADMIN_STATE="$scratch/admin-state.json"
export FREEHOLD_REVIEWER_STATE="$scratch/reviewer-state.json"
export FREEHOLD_REPO_ROOT="$(pwd)"
export SCHEDULER_DATABASE_URL="postgresql://freehold_scheduler:${scheduler_password}@${pg_address}/freehold_browser_disposable"
export SCHEDULER_POLL_MS=1000
export FREEHOLD_SCHEDULER_PID_FILE="$scratch/scheduler.pids"
: >"$FREEHOLD_SCHEDULER_PID_FILE"
chmod 600 "$FREEHOLD_SCHEDULER_PID_FILE"
env -u DATABASE_URL -u AUTH_DATABASE_URL \
  SCHEDULER_DATABASE_URL="$SCHEDULER_DATABASE_URL" \
  SCHEDULER_POLL_MS="$SCHEDULER_POLL_MS" \
  node dist/src/scheduler.js >"$scratch/scheduler.log" 2>&1 &
sched_pid=$!
echo "$sched_pid" >>"$FREEHOLD_SCHEDULER_PID_FILE"
export FREEHOLD_SCHEDULER_PID="$sched_pid"
for attempt in $(seq 1 80); do
  if grep -q 'scheduler_started' "$scratch/scheduler.log"; then break; fi
  if ! kill -0 "$sched_pid" >/dev/null 2>&1; then echo 'Scheduler exited before ready' >&2; exit 1; fi
  if [ "$attempt" -eq 80 ]; then echo 'Scheduler did not start' >&2; exit 1; fi
  sleep 0.1
done
set +e
npx --prefix web playwright test -c web/playwright.config.ts >"$scratch/playwright.log" 2>&1
playwright_exit=$?
set -e
mkdir -p docs/evidence
node --input-type=module - "$playwright_exit" "$scratch/playwright.log" <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { sourceRevision } from './scripts/lib/source-revision.mjs';
const exitCode = Number(process.argv[2]);
const log = readFileSync(process.argv[3], 'utf8');
const summary = log.trim().split('\n').filter(line => /^\s*\d+ (passed|failed|flaky|skipped)/.test(line.trim()) || line.includes('passed') || line.includes('failed')).slice(-4);
const report = {
  generatedAt: new Date().toISOString(),
  reportType: 'freehold.phase7-browser',
  sourceRevision: sourceRevision(),
  signature: null,
  signatureCustody: 'REQUIRES_EXTERNAL_REVIEW',
  executed: true,
  exitCode,
  ok: exitCode === 0,
  channel: 'chrome',
  projects: ['setup', 'desktop-public', 'mobile-public', 'desktop', 'mobile', 'desktop-admin', 'mobile-admin'],
  webServer: 'next dev on 127.0.0.1',
  schedulerProcess: true,
  sandboxFunding: 'sandbox_fund_account credits a customer liability and debits sandbox equity. It is not an external asset.',
  target: 'disposable postgres, redis, auth process, API, scheduler, and web. Not the Compose stack.',
  summary: summary.map(line => line.trim()).filter(line => !/password|secret|postgresql:\/\//i.test(line)),
};
const hashBody = { ...report };
delete hashBody.contentSha256;
report.contentSha256 = createHash('sha256').update(JSON.stringify(hashBody)).digest('hex');
report.contentHashCovers = 'every field except contentSha256, using JSON.stringify key order';
const browserOut = process.env.PHASE7_BROWSER_OUT ?? 'docs/evidence/browser-run.json';
const { refuseEvidenceOverwrite } = await import('./scripts/lib/evidence-output.mjs');
refuseEvidenceOverwrite(browserOut);
writeFileSync(browserOut, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
EOF
if [ "$playwright_exit" -ne 0 ]; then
  cp "$scratch/playwright.log" /tmp/freehold-browser-last.log
  chmod 600 /tmp/freehold-browser-last.log
  echo 'Browser tests failed. The Playwright log was copied to /tmp/freehold-browser-last.log.' >&2
  tail -n 80 "$scratch/playwright.log" >&2
  exit "$playwright_exit"
fi
echo 'PASS browser tests'
