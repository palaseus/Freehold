-- Phase 9A: do not steal a live worker lease, and start the lease when the claim returns.
-- At-least-once delivery stays. An expired PROCESSING row can still be reclaimed.
-- Forward only. Migrations 001-020 are not modified. The verifier is not granted.
BEGIN;
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;

CREATE OR REPLACE FUNCTION freehold.worker_claim_outbox(p_worker_id uuid,p_limit integer DEFAULT 25,p_lease_seconds integer DEFAULT 30)
RETURNS TABLE(event_id uuid,operation_id uuid,aggregate_id uuid,event_type text,payload_version integer,payload jsonb,
 created_at timestamptz,actor_id uuid,attempt_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE candidate record; new_attempt integer; claimed uuid[] := ARRAY[]::uuid[];
BEGIN
 IF p_worker_id IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
  RAISE EXCEPTION 'INVALID_WORKER_CLAIM' USING ERRCODE='22023';
 END IF;
 FOR candidate IN
  SELECT o.id AS event_id,o.operation_id,o.aggregate_id,o.event_type,o.payload_version,o.payload,o.created_at,i.actor_id
  FROM freehold.outbox_events o
  JOIN freehold.idempotency_requests i ON i.operation_id=o.operation_id
  LEFT JOIN freehold.worker_inbox inbox ON inbox.event_id=o.id
  WHERE o.dispatched_at IS NULL
   AND o.quarantined_at IS NULL
   AND o.available_at<=clock_timestamp()
   AND (inbox.event_id IS NULL OR (inbox.status='PROCESSING' AND inbox.lease_until<=clock_timestamp()))
  ORDER BY o.available_at,o.created_at,o.id
  LIMIT p_limit
  FOR UPDATE OF o SKIP LOCKED
 LOOP
  new_attempt := NULL;
  -- The SELECT snapshot can miss an inbox row committed after the statement started.
  -- This follow-up statement sees that commit and leaves a live lease with its owner.
  IF EXISTS (
    SELECT 1 FROM freehold.worker_inbox live
    WHERE live.event_id=candidate.event_id AND live.status='PROCESSING' AND live.lease_until>clock_timestamp()
  ) THEN CONTINUE; END IF;
  INSERT INTO freehold.worker_inbox AS inbox_row(event_id,worker_id,status,claimed_at,lease_until,attempt_count)
  VALUES(candidate.event_id,p_worker_id,'PROCESSING',clock_timestamp(),clock_timestamp()+make_interval(secs=>p_lease_seconds),1)
  ON CONFLICT ON CONSTRAINT worker_inbox_pkey DO UPDATE SET worker_id=EXCLUDED.worker_id,status='PROCESSING',claimed_at=EXCLUDED.claimed_at,
   lease_until=EXCLUDED.lease_until,attempt_count=inbox_row.attempt_count+1,processed_at=NULL
   WHERE inbox_row.status IS DISTINCT FROM 'QUARANTINED' AND inbox_row.lease_until<=clock_timestamp()
  RETURNING inbox_row.attempt_count INTO new_attempt;
  IF new_attempt IS NULL THEN CONTINUE; END IF;
  UPDATE freehold.outbox_events o SET attempt_count=o.attempt_count+1 WHERE o.id=candidate.event_id;
  claimed := claimed || candidate.event_id;
  RETURN QUERY SELECT candidate.event_id,candidate.operation_id,candidate.aggregate_id,candidate.event_type,
   candidate.payload_version,candidate.payload,candidate.created_at,candidate.actor_id,new_attempt;
 END LOOP;
 -- clock_timestamp() inside the loop starts the lease before the statement ends.
 -- A slow claim would otherwise commit an already expired lease. Refresh once, after the loop.
 IF cardinality(claimed)>0 THEN
  UPDATE freehold.worker_inbox AS refreshed
  SET lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds)
  WHERE refreshed.event_id=ANY(claimed) AND refreshed.worker_id=p_worker_id AND refreshed.status='PROCESSING';
 END IF;
END $$;

REVOKE ALL ON FUNCTION freehold.worker_claim_outbox(uuid,integer,integer)
 FROM PUBLIC,freehold_api,freehold_verifier,freehold_auth,freehold_scheduler,freehold_backup;
GRANT EXECUTE ON FUNCTION freehold.worker_claim_outbox(uuid,integer,integer) TO freehold_worker;

RESET ROLE;
COMMIT;
