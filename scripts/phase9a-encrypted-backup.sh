#!/usr/bin/env bash
# Encrypt a disposable PostgreSQL backup, decrypt it with the test passphrase,
# restore it into a fresh database, and run the independent verifier.
# A wrong passphrase and a missing passphrase must not produce VERIFIED.
# Does not read the Compose database and does not keep a passphrase.
set -euo pipefail
cd "$(dirname "$0")/.."
out="${PHASE9A_BACKUP_OUT:-docs/evidence/phase9a-encrypted-backup.json}"
node --input-type=module -e 'import { refuseEvidenceOverwrite } from "./scripts/lib/evidence-output.mjs"; refuseEvidenceOverwrite(process.argv[1]);' "$out"
source_container="freehold-enc9a-$$"
case "$source_container" in
  freehold-postgres-1|freehold-api-1|freehold-web-1|freehold-redis-1)
    echo 'Refusing a persistent Compose container name' >&2
    exit 1
    ;;
esac
work=$(mktemp -d /tmp/freehold-enc9a.XXXXXX)
chmod 700 "$work"
cleanup() {
  docker rm -f -v "$source_container" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
pg_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
passphrase=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
wrong=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
if [ "$passphrase" = "$wrong" ] || [ "${#passphrase}" -lt 16 ]; then echo 'Test passphrase was not usable' >&2; exit 1; fi
for name in api worker verifier auth scheduler; do
  printf -v "${name}_password" '%s' "$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')"
done
docker run --name "$source_container" -d -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD="$pg_password" -e POSTGRES_DB=freehold_encrypted_backup_disposable postgres:16 >/dev/null
for attempt in $(seq 1 100); do
  if docker exec "$source_container" psql -h 127.0.0.1 -U postgres -d freehold_encrypted_backup_disposable -X -Atc 'SELECT 1' >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 100 ]; then echo 'Encrypted-backup source database failed to start' >&2; exit 1; fi
  sleep 0.2
done
pg_address=$(docker port "$source_container" 5432/tcp)
export API_DATABASE_PASSWORD="$api_password" WORKER_DATABASE_PASSWORD="$worker_password"
export VERIFIER_DATABASE_PASSWORD="$verifier_password" AUTH_DATABASE_PASSWORD="$auth_password"
export SCHEDULER_DATABASE_PASSWORD="$scheduler_password"
export MIGRATION_DATABASE_URL="postgresql://postgres:${pg_password}@${pg_address}/freehold_encrypted_backup_disposable"
export NODE_ENV=test DEMO_MODE=false DEMO_BOOTSTRAP_TOKEN=''
node scripts/migrate.mjs >/dev/null
docker exec "$source_container" pg_dump -U postgres -d freehold_encrypted_backup_disposable -Fc -f /tmp/source.dump
docker cp "$source_container:/tmp/source.dump" "$work/ledger.dump"
docker exec "$source_container" rm -f /tmp/source.dump
chmod 600 "$work/ledger.dump"
mkdir -p "$work/export"
chmod 700 "$work/export"
env -u DATABASE_URL -u AUTH_DATABASE_URL -u SCHEDULER_DATABASE_URL \
  BACKUP_EXPORT_DIR="$work/export" BACKUP_EXPORT_PASSPHRASE="$passphrase" \
  bash scripts/backup-export.sh "$work/ledger.dump" >/dev/null
set +e
BACKUP_EXPORT_PASSPHRASE="$passphrase" node scripts/backup-validate.mjs --set "$work/export" --restore --out "$work/good.json"
good_code=$?
BACKUP_EXPORT_PASSPHRASE="$wrong" node scripts/backup-validate.mjs --set "$work/export" --restore --out "$work/wrong.json"
wrong_code=$?
env -u BACKUP_EXPORT_PASSPHRASE node scripts/backup-validate.mjs --set "$work/export" --restore --out "$work/missing.json"
missing_code=$?
set -e
plain_left=0
if find "$work/export" -type f \( -name '*.dump' -o -name 'plain.dump' \) | grep -q .; then plain_left=1; fi
node --input-type=module - "$out" "$work/good.json" "$work/wrong.json" "$work/missing.json" "$good_code" "$wrong_code" "$missing_code" "$plain_left" <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs';
import { signatureFor } from './scripts/lib/evidence-signature.mjs';
import { sourceRevision } from './scripts/lib/source-revision.mjs';
const [out, goodPath, wrongPath, missingPath, goodCode, wrongCode, missingCode, plainLeft] = process.argv.slice(2);
function read(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return { outcome: 'ERROR', reason: 'report was not readable', decryptionError: null, verifierOutcome: null, encrypted: null, decrypted: null, restoreCompleted: null, offsiteCopy: null, walContinuity: null, primaryTouched: null }; }
}
const good = read(goodPath);
const wrong = read(wrongPath);
const missing = read(missingPath);
const goodVerified = good.outcome === 'VERIFIED' && good.restoreCompleted === true && good.verifierOutcome === 'VERIFIED' && good.encrypted === true && good.decrypted === true && good.decryptionError == null;
const wrongSafe = wrong.outcome !== 'VERIFIED' && wrong.verifierOutcome !== 'VERIFIED' && wrong.restoreCompleted !== true;
const missingSafe = missing.outcome !== 'VERIFIED' && missing.verifierOutcome !== 'VERIFIED' && missing.restoreCompleted !== true;
const body = {
  reportType: 'freehold.phase9a-encrypted-backup',
  generatedAt: new Date().toISOString(),
  sourceRevision: sourceRevision(),
  persistentDatabase: false,
  plaintextLeftInExport: Number(plainLeft) !== 0,
  offsiteCopy: good.offsiteCopy === true,
  walContinuity: good.walContinuity ?? null,
  primaryTouched: good.primaryTouched === true,
  correct: { outcome: good.outcome ?? null, exitCode: Number(goodCode), encrypted: good.encrypted === true, decrypted: good.decrypted === true, decryptionError: good.decryptionError ?? null, restoreCompleted: good.restoreCompleted === true, verifierOutcome: good.verifierOutcome ?? null },
  wrongPassphrase: { outcome: wrong.outcome ?? null, exitCode: Number(wrongCode), decryptionError: wrong.decryptionError ?? null, restoreCompleted: wrong.restoreCompleted === true, verifierOutcome: wrong.verifierOutcome ?? null },
  missingPassphrase: { outcome: missing.outcome ?? null, exitCode: Number(missingCode), decryptionError: missing.decryptionError ?? null, restoreCompleted: missing.restoreCompleted === true, verifierOutcome: missing.verifierOutcome ?? null },
};
body.passed = goodVerified && wrongSafe && missingSafe && body.plaintextLeftInExport === false && body.persistentDatabase === false && body.offsiteCopy === false && body.primaryTouched === false;
const report = { ...body, signature: signatureFor(body, process.env.EVIDENCE_SIGNING_KEY ?? '') };
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
if (!body.passed) process.exit(1);
EOF
echo "PASS encrypted backup restore VERIFIED wrong and missing passphrase not VERIFIED"
