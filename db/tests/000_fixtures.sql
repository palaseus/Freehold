\set ON_ERROR_STOP on
-- TEST DATABASE ONLY. Run once after migration, as deployment superuser.
-- Fixtures use privileged identity provisioning, which is outside this migration's
-- runtime API. Account buckets are still created by the production trigger.
BEGIN;
SET LOCAL ROLE freehold_owner;
INSERT INTO freehold.users(id,email_normalized,password_hash,role) VALUES
 ('00000000-0000-0000-0000-000000000001','admin@example.test','test-only','ADMIN'),
 ('00000000-0000-0000-0000-000000000002','alice@example.test','test-only','USER'),
 ('00000000-0000-0000-0000-000000000003','bob@example.test','test-only','USER'),
 ('00000000-0000-0000-0000-000000000004','carol@example.test','test-only','USER'),
 ('00000000-0000-0000-0000-000000000005','dave@example.test','test-only','USER');
INSERT INTO freehold.currencies(code,name,minor_unit_exponent) VALUES('USD','US dollar',2),('EUR','Euro',2);
INSERT INTO freehold.accounts(id,owner_user_id,currency_code) VALUES
 ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000002','USD'),
 ('00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000003','USD'),
 ('00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000004','USD'),
 ('00000000-0000-0000-0000-000000000104','00000000-0000-0000-0000-000000000005','USD'),
 ('00000000-0000-0000-0000-000000000105','00000000-0000-0000-0000-000000000002','EUR');
UPDATE freehold.ledger_settings SET sandbox_enabled=true;
SET LOCAL ROLE freehold_app;
SELECT freehold.sandbox_fund_account('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000101',100,'fixture-fund','SANDBOX test fixture');
COMMIT;
