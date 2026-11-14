-- Phase 16.2 follow-up: restrict execute privileges on institution_usage_record.
-- Forward only. Migrations 001 through 033 are not edited.
--
-- Migration 033 replaced institution_usage_record to add an idempotency key
-- parameter with a DEFAULT, which created a new 6-argument function signature
-- alongside the old 5-argument one and left default (PUBLIC) execute on the
-- new function. The runtime privilege guard requires that only expected roles
-- can execute freehold functions, so PUBLIC execute on the 6-arg function
-- causes auth/runtime startup to fail. This migration removes the obsolete
-- 5-argument overload and restricts execute on the canonical 6-argument form
-- to the API runtime (and owner), matching the intent of migration 025.
BEGIN;
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;

DROP FUNCTION IF EXISTS freehold.institution_usage_record(uuid, uuid, date, text, bigint);

REVOKE ALL ON FUNCTION freehold.institution_usage_record(uuid, uuid, date, text, bigint, text)
  FROM PUBLIC, freehold_worker, freehold_verifier, freehold_auth, freehold_scheduler, freehold_backup;
GRANT EXECUTE ON FUNCTION freehold.institution_usage_record(uuid, uuid, date, text, bigint, text)
  TO freehold_api;

RESET ROLE;
COMMIT;
