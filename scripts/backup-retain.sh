#!/usr/bin/env bash
# Delete regular files in DIR older than DAYS. Always keep the newest file.
set -euo pipefail
dir=${1:?directory}
days=${2:-7}
if [ ! -d "$dir" ]; then echo "Backup directory missing: $dir" >&2; exit 1; fi
if ! [[ "$days" =~ ^[0-9]+$ ]]; then echo 'Retention days must be a whole number' >&2; exit 1; fi
newest=$(find "$dir" -maxdepth 1 -type f -printf '%T@ %p\n' | sort -nr | awk 'NR==1 { print $2 }')
find "$dir" -maxdepth 1 -type f -mtime "+$days" -print | while IFS= read -r old; do
  if [ -n "$newest" ] && [ "$old" = "$newest" ]; then continue; fi
  rm -f -- "$old"
  printf 'removed %s\n' "$old"
done
echo "PASS retention kept newest${newest:+ $newest}"
