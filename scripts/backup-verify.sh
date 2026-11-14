#!/usr/bin/env bash
# Reject an empty, unreadable, or truncated gzip base backup. Prints the sha256.
set -euo pipefail
file=${1:?backup file}
if [ ! -s "$file" ]; then echo "Backup missing or empty: $file" >&2; exit 1; fi
gzip -t "$file"
manifest="$(dirname "$file")/backup_manifest"
if [ ! -s "$manifest" ]; then echo "backup_manifest missing beside $file" >&2; exit 1; fi
sha=$(sha256sum "$file" | awk 'NR==1 { print $1 }')
bytes=$(wc -c < "$file" | tr -d ' ')
printf 'PASS backup sha256 %s bytes %s\n' "$sha" "$bytes"
