#!/usr/bin/env bash
# Fail when a source or config file contains a literal credential.
# Does not open .env or .env.compose. Those files are gitignored and may hold local secrets.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .gitignore ] && ! grep -qx '.env' .gitignore; then
  echo '.env is not gitignored' >&2
  exit 1
fi
if [ -f .gitignore ] && ! grep -qx '.env.compose' .gitignore; then
  echo '.env.compose is not gitignored' >&2
  exit 1
fi
# Inspect release inputs only; ignored runtime data and private archives are not publication inputs.
mapfile -d '' files < <(git ls-files -z --cached --others --exclude-standard)
fail=0
while IFS= read -r -d '' file; do
  [ -f "$file" ] || continue
  case "$file" in
    *.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.woff|*.woff2|*.pdf) continue ;;
  esac
  if grep -nE -- '-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}' "$file" >/dev/null; then
    echo "credential pattern in $file" >&2
    fail=1
  fi
  # A postgres URL with a literal password. Shell placeholders and the public replace-me example are allowed.
  if grep -nE -- 'postgres(ql)?://[^[:space:]/$]+:[^[:space:]$@]{12,}@' "$file" | grep -vE -- 'replace-me|freehold-(local-postgres-change-me|test-only|fresh-test-only|[a-z]+-test-password-)' >/dev/null; then
    echo "literal database password in $file" >&2
    fail=1
  fi
done < <(printf '%s\0' "${files[@]}")
if [ "$fail" -ne 0 ]; then
  echo 'Secret check failed. No file contents were printed.' >&2
  exit 1
fi
echo 'PASS no literal private keys, cloud access keys, or non-placeholder database passwords in scanned files'
