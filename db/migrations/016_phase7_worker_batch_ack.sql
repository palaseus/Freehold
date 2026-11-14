-- Acknowledge a claimed outbox batch in one statement.
-- Financial posting is unchanged: the API has already committed the journal.
BEGIN;
SET LOCAL ROLE freehold_owner;

CREATE FUNCTION freehold.worker_complete_outbox_batch(p_worker_id uuid, p_event_ids uuid[])
RETURNS uuid[] LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE completed uuid[];
BEGIN
  IF p_worker_id IS NULL OR p_event_ids IS NULL OR cardinality(p_event_ids) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'INVALID_WORKER_ACK' USING ERRCODE='22023';
  END IF;
  WITH owned AS (
    UPDATE freehold.worker_inbox
    SET status='PROCESSED', processed_at=clock_timestamp(), lease_until=clock_timestamp()
    WHERE worker_id=p_worker_id AND status='PROCESSING' AND event_id = ANY(p_event_ids)
    RETURNING event_id
  ), dispatched AS (
    UPDATE freehold.outbox_events AS event
    SET dispatched_at=clock_timestamp()
    FROM owned
    WHERE event.id=owned.event_id AND event.dispatched_at IS NULL
    RETURNING event.id
  )
  SELECT COALESCE(array_agg(id), '{}'::uuid[]) INTO completed FROM dispatched;
  RETURN completed;
END $$;

REVOKE ALL ON FUNCTION freehold.worker_complete_outbox_batch(uuid,uuid[])
  FROM PUBLIC,freehold_api,freehold_worker,freehold_verifier,freehold_auth,freehold_scheduler,freehold_backup;
GRANT EXECUTE ON FUNCTION freehold.worker_complete_outbox_batch(uuid,uuid[]) TO freehold_worker;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA freehold FROM PUBLIC;
RESET ROLE;
COMMIT;
