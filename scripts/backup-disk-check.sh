#!/usr/bin/env bash
# Print free bytes for a backup or WAL directory. Exit 1 below the minimum.
set -euo pipefail
dir=${1:?directory}
minimum=${2:-104857600}
if [ ! -d "$dir" ]; then echo "Directory missing: $dir" >&2; exit 1; fi
if ! [[ "$minimum" =~ ^[0-9]+$ ]]; then echo 'Minimum bytes must be a whole number' >&2; exit 1; fi
free=$(df -B1 --output=avail "$dir" | awk 'NR==2 { print $1 }')
ok=true
if [ "$free" -lt "$minimum" ]; then ok=false; fi
printf '{"path":"%s","freeBytes":%s,"minimumBytes":%s,"ok":%s}\n' "$dir" "$free" "$minimum" "$ok"
if [ "$ok" != true ]; then echo 'Backup destination is below the free-space minimum' >&2; exit 1; fi
