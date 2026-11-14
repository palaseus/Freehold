-- Phase 16.2 follow-up: bind institution usage metering to the idempotency key.
-- Forward only. Migrations 001 through 032 are not edited.
--
-- institution_usage_records appended one row per call with no key and no
-- duplicate detection, so a retried metering emission (for example a client
-- retry after an ambiguous response) inflated the billed usage for the period.
-- This migration adds an optional event idempotency key and makes
-- institution_usage_record idempotent: a retried event with the same
-- institution, period, meter, and key returns the stored result, and a
-- retried event carrying a different quantity under the same key is rejected
-- with INSTITUTION_IDEMPOTENCY_CONFLICT (SQLSTATE 55000). Events without a key
-- keep appending, preserving unkeyed metering callers.
BEGIN;
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;

ALTER TABLE freehold.institution_usage_records ADD COLUMN idempotency_key text;

CREATE UNIQUE INDEX institution_usage_records_event_key
  ON freehold.institution_usage_records (institution_id, period_start, meter, idempotency_key);

CREATE OR REPLACE FUNCTION freehold.institution_usage_record(
  p_actor uuid, p_institution uuid, p_period date, p_meter text, p_quantity bigint, p_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, freehold, pg_temp AS $$
DECLARE
  inserted_id uuid;
  existing_quantity bigint;
BEGIN
  PERFORM freehold._institution_actor(p_actor, NULL, NULL, NULL, p_institution, 'billing:read');
  INSERT INTO freehold.institution_usage_records(institution_id, period_start, meter, quantity, idempotency_key)
  VALUES (p_institution, p_period, p_meter, p_quantity, p_key)
  ON CONFLICT (institution_id, period_start, meter, idempotency_key) DO NOTHING
  RETURNING id INTO inserted_id;
  IF inserted_id IS NULL THEN
    SELECT quantity INTO existing_quantity FROM freehold.institution_usage_records
    WHERE institution_id = p_institution AND period_start = p_period AND meter = p_meter
      AND idempotency_key IS NOT DISTINCT FROM p_key;
    IF existing_quantity IS DISTINCT FROM p_quantity THEN
      RAISE EXCEPTION 'INSTITUTION_IDEMPOTENCY_CONFLICT' USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object('meter', p_meter, 'quantity', p_quantity::text, 'duplicate', true);
  END IF;
  RETURN jsonb_build_object('meter', p_meter, 'quantity', p_quantity::text, 'duplicate', false);
END $$;

RESET ROLE;
COMMIT;
