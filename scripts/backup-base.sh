#!/usr/bin/env bash
# Base backup through freehold_backup into a directory that is not the data volume.
# Requires BACKUP_CONTAINER, BACKUP_DEST_IN_CONTAINER, and BACKUP_DATABASE_PASSWORD.
set -euo pipefail
: "${BACKUP_CONTAINER:?}" "${BACKUP_DEST_IN_CONTAINER:?}" "${BACKUP_DATABASE_PASSWORD:?}"
if [ "${#BACKUP_DATABASE_PASSWORD}" -lt 32 ]; then echo 'Backup password must have 32+ characters' >&2; exit 1; fi
if [ "$BACKUP_DEST_IN_CONTAINER" = "/var/lib/postgresql/data" ] || [ "$BACKUP_DEST_IN_CONTAINER" = "/" ]; then
  echo 'Refusing to store the base backup on the PostgreSQL data directory' >&2
  exit 1
fi
docker exec -e PGPASSWORD="$BACKUP_DATABASE_PASSWORD" -e PGHOST=127.0.0.1 -e PGUSER=freehold_backup -e PGDATABASE=postgres \
  -u postgres "$BACKUP_CONTAINER" \
  pg_basebackup -D "$BACKUP_DEST_IN_CONTAINER" -Ft -z -X fetch --no-sync
echo "PASS base backup written to ${BACKUP_DEST_IN_CONTAINER} in ${BACKUP_CONTAINER}"
