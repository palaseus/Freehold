-- Independent verifier is a read-only observer; it does not call reconciliation.
BEGIN;
CREATE ROLE freehold_verifier LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
COMMENT ON ROLE freehold_verifier IS 'Read-only independent journal verifier; never a financial writer.';
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;
REVOKE ALL ON SCHEMA freehold FROM freehold_verifier;
GRANT USAGE ON SCHEMA freehold TO freehold_verifier;
GRANT SELECT ON freehold.currencies,freehold.accounts,freehold.ledger_accounts,
 freehold.ledger_journals,freehold.ledger_entries,freehold.journal_seals,
 freehold.idempotency_requests,freehold.transfers,freehold.holds,
 freehold.outbox_events,freehold.worker_inbox TO freehold_verifier;
GRANT SELECT (id) ON freehold.users TO freehold_verifier;
GRANT SELECT (operation_id,actor_user_id,action_type,target_id,correlation_id)
 ON freehold.admin_actions TO freehold_verifier;
GRANT SELECT (id,event_type,resource_id,operation_id,outcome,correlation_id,actor_id)
 ON freehold.audit_log TO freehold_verifier;
ALTER DEFAULT PRIVILEGES FOR ROLE freehold_owner IN SCHEMA freehold
 REVOKE ALL ON TABLES FROM freehold_verifier;
ALTER DEFAULT PRIVILEGES FOR ROLE freehold_owner IN SCHEMA freehold
 REVOKE EXECUTE ON FUNCTIONS FROM freehold_verifier;
RESET ROLE;
GRANT USAGE ON SCHEMA freehold_deploy TO freehold_verifier;
GRANT SELECT ON freehold_deploy.migrations TO freehold_verifier;
COMMIT;
