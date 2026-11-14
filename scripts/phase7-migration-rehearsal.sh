#!/usr/bin/env bash
# Read-only copy of the persistent Compose database, restored into a disposable
# cluster, then migrated through 013 only. Does not migrate or restart Compose.
set -euo pipefail
cd "$(dirname "$0")/.."
node --input-type=module -e 'import { refuseEvidenceOverwrite } from "./scripts/lib/evidence-output.mjs"; refuseEvidenceOverwrite("docs/evidence/phase7-migration-rehearsal.json");'
persistent=${PHASE7_PERSISTENT_CONTAINER:-freehold-postgres-1}
if ! docker inspect "$persistent" >/dev/null 2>&1; then
  echo "Persistent container ${persistent} is not running. Rehearsal is UNVERIFIED." >&2
  exit 1
fi
scratch=$(mktemp -d /tmp/freehold-phase7-rehearsal.XXXXXX)
chmod 700 "$scratch"
container="freehold-rehearsal-$$"
cleanup() {
  status=$?
  docker rm -f -v "$container" >/dev/null 2>&1 || true
  if [ "$status" -eq 0 ]; then rm -rf "$scratch"; else echo "Rehearsal scratch kept at $scratch" >&2; fi
}
trap cleanup EXIT
before=$(docker exec "$persistent" psql -U postgres -d freehold -X -Atc "SELECT coalesce(string_agg(name, ',' ORDER BY name), '') FROM freehold_deploy.migrations")
docker exec "$persistent" pg_dump -U postgres -d freehold -Fc -f /tmp/phase7-rehearsal.dump
docker cp "$persistent:/tmp/phase7-rehearsal.dump" "$scratch/freehold.dump"
docker exec "$persistent" rm -f /tmp/phase7-rehearsal.dump
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
pg_address=$(docker port "$container" 5432/tcp)
export API_DATABASE_PASSWORD="$api_password" WORKER_DATABASE_PASSWORD="$worker_password"
export VERIFIER_DATABASE_PASSWORD="$verifier_password" AUTH_DATABASE_PASSWORD="$auth_password"
export SCHEDULER_DATABASE_PASSWORD="$scheduler_password"
export MIGRATION_DATABASE_URL="postgresql://postgres:${pg_password}@${pg_address}/freehold_rehearsal_disposable"
export NODE_ENV=test DEMO_MODE=false DEMO_BOOTSTRAP_TOKEN=''
export MIGRATION_TEST_STOP_AFTER=013
node scripts/migrate.mjs >"$scratch/migrate.log"
counts=$(docker exec "$container" psql -U postgres -d freehold_rehearsal_disposable -X -Atc \
  "SELECT (SELECT count(*) FROM freehold.users)||','||(SELECT count(*) FROM freehold.accounts)||','||(SELECT count(*) FROM freehold.ledger_journals)||','||(SELECT count(*) FROM freehold.ledger_entries)||','||(SELECT count(*) FROM freehold.idempotency_requests)||','||(SELECT count(*) FROM freehold.ledger_journals j WHERE (SELECT coalesce(sum(CASE WHEN e.side='DEBIT' THEN e.amount_minor ELSE -e.amount_minor END),0) FROM freehold.ledger_entries e WHERE e.journal_id=j.id)<>0)")
grants=$(docker exec "$container" psql -U postgres -d freehold_rehearsal_disposable -X -Atc \
  "SELECT rolname||':'||rolcanlogin||':'||rolsuper||':'||rolbypassrls FROM pg_roles WHERE rolname LIKE 'freehold_%' ORDER BY rolname")
api_reads=$(docker exec "$container" psql -U postgres -d freehold_rehearsal_disposable -X -Atc \
  "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='freehold' AND c.relkind='r' AND has_table_privilege('freehold_api', c.oid, 'SELECT') ORDER BY 1")
applied=$(docker exec "$container" psql -U postgres -d freehold_rehearsal_disposable -X -Atc \
  "SELECT string_agg(name, ',' ORDER BY name) FROM freehold_deploy.migrations")
export VERIFY_DATABASE_URL="postgresql://freehold_verifier:${verifier_password}@${pg_address}/freehold_rehearsal_disposable"
set +e
node scripts/verify-ledger.mjs >"$scratch/verifier-013.json"
verifier_013_exit=$?
set -e
printf '%s\n' "$verifier_013_exit" >"$scratch/verifier-013.exit"
# 014–016 are a separate forward step on this disposable copy only.
# They are not part of the 004–013 rehearsal and do not touch Compose.
unset MIGRATION_TEST_STOP_AFTER
set +e
node scripts/migrate.mjs >"$scratch/migrate-forward.log"
forward_exit=$?
set -e
printf '%s\n' "$forward_exit" >"$scratch/migrate-forward.exit"
counts_forward=$(docker exec "$container" psql -U postgres -d freehold_rehearsal_disposable -X -Atc \
  "SELECT (SELECT count(*) FROM freehold.users)||','||(SELECT count(*) FROM freehold.accounts)||','||(SELECT count(*) FROM freehold.ledger_journals)||','||(SELECT count(*) FROM freehold.ledger_entries)||','||(SELECT count(*) FROM freehold.idempotency_requests)||','||(SELECT count(*) FROM freehold.ledger_journals j WHERE (SELECT coalesce(sum(CASE WHEN e.side='DEBIT' THEN e.amount_minor ELSE -e.amount_minor END),0) FROM freehold.ledger_entries e WHERE e.journal_id=j.id)<>0)")
applied_forward=$(docker exec "$container" psql -U postgres -d freehold_rehearsal_disposable -X -Atc \
  "SELECT string_agg(name, ',' ORDER BY name) FROM freehold_deploy.migrations")
api_reads_forward=$(docker exec "$container" psql -U postgres -d freehold_rehearsal_disposable -X -Atc \
  "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='freehold' AND c.relkind='r' AND has_table_privilege('freehold_api', c.oid, 'SELECT') ORDER BY 1")
set +e
node scripts/verify-ledger.mjs >"$scratch/verifier-forward.json"
verifier_forward_exit=$?
set -e
printf '%s\n' "$verifier_forward_exit" >"$scratch/verifier-forward.exit"
after=$(docker exec "$persistent" psql -U postgres -d freehold -X -Atc "SELECT coalesce(string_agg(name, ',' ORDER BY name), '') FROM freehold_deploy.migrations")
if [ "$before" != "$after" ]; then echo 'Persistent migration state changed during rehearsal' >&2; exit 1; fi
node --input-type=module - "$scratch" "$sha" "$bytes" "$before" "$counts" "$grants" "$api_reads" "$applied" "$counts_forward" "$applied_forward" "$api_reads_forward" "$forward_exit" <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs';
const [scratch, sha, bytes, persistentMigrations, counts, grants, apiReads, applied, countsForward, appliedForward, apiReadsForward, forwardExit] = process.argv.slice(2);
const parseCounts = (value) => {
  const [users, accounts, journals, entries, idempotency, unbalanced] = value.split(',');
  return { users: Number(users), accounts: Number(accounts), journals: Number(journals), entries: Number(entries), idempotency: Number(idempotency), unbalancedJournals: Number(unbalanced) };
};
const through013 = parseCounts(counts);
const through016 = parseCounts(countsForward);
const verifier013 = JSON.parse(readFileSync(`${scratch}/verifier-013.json`, 'utf8'));
let verifierForward = null;
try { verifierForward = JSON.parse(readFileSync(`${scratch}/verifier-forward.json`, 'utf8')); } catch { verifierForward = null; }
const sameHistory = ['users', 'accounts', 'journals', 'entries', 'idempotency', 'unbalancedJournals'].every((key) => through013[key] === through016[key]);
const report = {
  generatedAt: new Date().toISOString(),
  reportType: 'freehold.phase7-migration-rehearsal',
  sourceRevision: 'unknown',
  signature: null,
  persistentContainer: 'freehold-postgres-1',
  persistentMutated: false,
  persistentMigrations: persistentMigrations.split(',').filter(Boolean),
  dumpSha256: sha,
  dumpBytes: Number(bytes),
  dumpPath: 'withheld; local scratch only, not committed',
  restoredDatabase: 'freehold_rehearsal_disposable',
  rehearsedThrough013: {
    appliedMigrations: applied.split(',').filter(Boolean),
    counts: through013,
    roles: grants.split('\n').filter(Boolean),
    apiSelectTables: apiReads.split('\n').filter(Boolean),
    verifier: { outcome: verifier013.outcome ?? null, algorithmVersion: verifier013.algorithmVersion ?? null },
    forward014NotApplied: !String(applied).includes('014_'),
  },
  disposableForwardThrough016: {
    migrateExit: Number(forwardExit),
    appliedMigrations: appliedForward.split(',').filter(Boolean),
    counts: through016,
    historyUnchangedFrom013: sameHistory,
    apiSelectTables: apiReadsForward.split('\n').filter(Boolean),
    verifier: { outcome: verifierForward?.outcome ?? null, algorithmVersion: verifierForward?.algorithmVersion ?? null },
    note: 'Applied only to the restored disposable copy after the 013 check. This is not a persistent cutover.',
  },
  cutover: {
    executed: false,
    requiresExplicitApproval: true,
    proposed: [
      'Take a fresh pg_dump of freehold-postgres-1 and record its sha256. Do not reuse this rehearsal dump.',
      'Stop API, worker, scheduler, and web writers. Do not delete the data volume.',
      'Apply migrations 004 through 013 with scripts/migrate.mjs. This is the rehearsed range.',
      'Run scripts/verify-ledger.mjs as freehold_verifier and compare user, account, journal, and entry counts with the dump.',
      'Apply migrations 014 through 018 only after that check. 014 revokes API table reads. 017 adds scheduler heartbeats. 018 requires a bound session for email lookup and governance-failure audit writes. The running image must call the owner-scoped functions and set the session secret.',
      'Run scripts/verify-ledger.mjs again and scripts/deployment-check.mjs. Do not resume writes when the checker is not READY.',
      'On failure, restore the fresh dump into a replacement cluster and do not resume writes against the failed migration.'
    ],
    downtime: 'UNVERIFIED. The rehearsal did not stop the persistent services, so no downtime was measured.',
  },
};
writeFileSync('docs/evidence/phase7-migration-rehearsal.json', `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
const ok013 = verifier013.outcome === 'VERIFIED' && through013.unbalancedJournals === 0 && report.rehearsedThrough013.forward014NotApplied && report.persistentMutated === false;
const ok016 = Number(forwardExit) === 0 && sameHistory && verifierForward?.outcome === 'VERIFIED' && through016.unbalancedJournals === 0;
process.stdout.write(`${ok013 && ok016 ? 'PASS' : 'FAIL'} rehearsal 013 ${verifier013.outcome ?? 'missing'} journals ${through013.journals}; 016 ${verifierForward?.outcome ?? 'missing'} migrate ${forwardExit}; persistent ${persistentMigrations}\n`);
if (!ok013 || !ok016) process.exitCode = 1;
EOF
