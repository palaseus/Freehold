BEGIN;
-- Column reads only. Table-level SELECT stays false so the verifier cannot widen this list by accident.
GRANT SELECT (id, status, source_account_id, destination_account_id, currency_code, amount_minor)
  ON freehold.scheduled_transfers TO freehold_verifier;
GRANT SELECT (id, instruction_id, operation_id, outcome)
  ON freehold.scheduled_transfer_executions TO freehold_verifier;
COMMIT;
