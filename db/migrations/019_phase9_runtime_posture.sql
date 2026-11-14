-- Two booleans a production process must read before it serves.
-- No customer, balance, secret, or journal data. Posting is unchanged.
-- The verifier is not granted EXECUTE. Algorithm 1.3.0 stays a table scan.
BEGIN;
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;

CREATE FUNCTION freehold.runtime_posture() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, freehold, pg_temp
AS $$
  SELECT jsonb_build_object(
    'sandboxEnabled', (SELECT sandbox_enabled FROM freehold.ledger_settings WHERE singleton),
    'demoEnabled', (SELECT enabled FROM freehold.demo_settings WHERE singleton)
  );
$$;

REVOKE ALL ON FUNCTION freehold.runtime_posture() FROM PUBLIC, freehold_verifier, freehold_backup;
GRANT EXECUTE ON FUNCTION freehold.runtime_posture() TO freehold_api, freehold_worker, freehold_auth, freehold_scheduler;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA freehold FROM PUBLIC;
RESET ROLE;
COMMIT;
