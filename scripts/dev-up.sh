#!/usr/bin/env bash
# Compatibility entry point for the isolated local sandbox.
set -euo pipefail
cd "$(dirname "$0")/.."
exec bash scripts/local-deploy.sh
