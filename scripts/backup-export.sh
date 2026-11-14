#!/usr/bin/env bash
# Export one backup file to a directory chosen by the operator.
# This does not connect to PostgreSQL and does not upload anywhere.
# BACKUP_OFFSITE_DEST must be an existing directory other than BACKUP_EXPORT_DIR.
# A second directory on this host does not set offsiteCopy. The operator sets
# BACKUP_OFFSITE_INDEPENDENT=1 only when another administrator controls that destination.
set -euo pipefail
source=${1:?backup file}
dest_dir=${BACKUP_EXPORT_DIR:?}
failure="$dest_dir/export-failure.json"
report() {
  local ok=$1 detail=$2
  mkdir -p "$dest_dir"
  chmod 700 "$dest_dir"
  printf '{"ok":%s,"detail":"%s","offsiteCopy":false,"generatedAt":"%s"}\n' \
    "$ok" "$detail" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$failure"
  chmod 600 "$failure"
}
if [ ! -s "$source" ]; then report false 'source missing or empty'; echo 'Backup source missing or empty' >&2; exit 1; fi
case "$dest_dir" in
  /|/var/lib/postgresql|/var/lib/postgresql/*) echo 'Refusing to export onto a PostgreSQL data path' >&2; exit 1;;
esac
if [ -n "${DATABASE_URL:-}${AUTH_DATABASE_URL:-}${SCHEDULER_DATABASE_URL:-}" ]; then
  echo 'Refusing to export while this process holds a database URL' >&2
  exit 1
fi
mkdir -p "$dest_dir"
chmod 700 "$dest_dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
work="$dest_dir/$stamp"
mkdir -p "$work"
chmod 700 "$work"
base=$(basename "$source")
cp -- "$source" "$work/$base"
chmod 600 "$work/$base"
plain_sha=$(sha256sum "$work/$base" | awk 'NR==1 { print $1 }')
plain_bytes=$(wc -c < "$work/$base" | tr -d ' ')
encrypted=false
shipped="$work/$base"
if [ -n "${BACKUP_EXPORT_PASSPHRASE:-}" ]; then
  if [ "${#BACKUP_EXPORT_PASSPHRASE}" -lt 16 ]; then echo 'Export passphrase must have 16 or more characters' >&2; exit 1; fi
  openssl enc -aes-256-cbc -pbkdf2 -salt -in "$work/$base" -out "$work/$base.enc" -pass env:BACKUP_EXPORT_PASSPHRASE
  chmod 600 "$work/$base.enc"
  tmp=$(mktemp)
  chmod 600 "$tmp"
  openssl enc -d -aes-256-cbc -pbkdf2 -in "$work/$base.enc" -out "$tmp" -pass env:BACKUP_EXPORT_PASSPHRASE
  round=$(sha256sum "$tmp" | awk 'NR==1 { print $1 }')
  rm -f "$tmp"
  if [ "$round" != "$plain_sha" ]; then echo 'Encrypted export did not decrypt to the source hash' >&2; exit 1; fi
  rm -f "$work/$base"
  encrypted=true
  shipped="$work/$base.enc"
fi
file_sha=$(sha256sum "$shipped" | awk 'NR==1 { print $1 }')
offsite=false
offsite_note='No independent destination was configured. This copy is local.'
if [ -n "${BACKUP_OFFSITE_DEST:-}" ]; then
  if [ ! -d "$BACKUP_OFFSITE_DEST" ]; then echo 'BACKUP_OFFSITE_DEST is not a directory' >&2; exit 1; fi
  if [ "$(cd "$BACKUP_OFFSITE_DEST" && pwd -P)" = "$(cd "$dest_dir" && pwd -P)" ]; then
    echo 'BACKUP_OFFSITE_DEST must be a different directory from BACKUP_EXPORT_DIR' >&2
    exit 1
  fi
  install -m 600 "$shipped" "$BACKUP_OFFSITE_DEST/$(basename "$shipped")"
  if [ "${BACKUP_OFFSITE_INDEPENDENT:-}" = "1" ]; then
    offsite=true
    offsite_note='Operator attested that another administrator controls BACKUP_OFFSITE_DEST. A path on this host is not that attestation by itself.'
  else
    offsite_note='A copy was written to a separate directory. offsiteCopy stays false until BACKUP_OFFSITE_INDEPENDENT=1 and another administrator controls that directory.'
  fi
fi
if [ -n "${BACKUP_RETENTION_DAYS:-}" ]; then
  if ! [[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]]; then echo 'BACKUP_RETENTION_DAYS must be a whole number' >&2; exit 1; fi
  newest=$(find "$dest_dir" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | awk 'NR==1 { print $2 }')
  find "$dest_dir" -mindepth 1 -maxdepth 1 -type d -mtime "+$BACKUP_RETENTION_DAYS" -print | while IFS= read -r old; do
    if [ -n "$newest" ] && [ "$old" = "$newest" ]; then continue; fi
    rm -rf -- "$old"
  done
fi
cat >"$work/manifest.json" <<EOF
{
  "manifestType": "freehold.backup-export",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "sha256": "$file_sha",
  "plaintextSha256": "$plain_sha",
  "plaintextBytes": $plain_bytes,
  "encrypted": $encrypted,
  "cipher": "$( [ "$encrypted" = true ] && echo aes-256-cbc-pbkdf2 || echo none )",
  "offsiteCopy": $offsite,
  "offsiteNote": "$offsite_note",
  "retentionDays": ${BACKUP_RETENTION_DAYS:-null},
  "restoreCheck": "plaintext sha256 matched after copy or decrypt"
}
EOF
chmod 600 "$work/manifest.json"
rm -f "$failure"
echo "PASS backup export sha256 $file_sha offsiteCopy $offsite"
