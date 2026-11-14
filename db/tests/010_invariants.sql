\set ON_ERROR_STOP on
-- Run after 000_fixtures.sql, as superuser. All mutations here roll back.
BEGIN;
CREATE FUNCTION pg_temp.assert_true(value boolean,message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'TEST FAILED: %',message; END IF; END $$;
SELECT pg_temp.assert_true((SELECT NOT rolcanlogin AND NOT rolsuper FROM pg_roles WHERE rolname='freehold_owner'),'non-login non-superuser owner');
SELECT pg_temp.assert_true(NOT has_schema_privilege('freehold_app','freehold','CREATE'),'runtime cannot create schema objects');
SELECT pg_temp.assert_true((SELECT bool_and(p.prosecdef AND p.proowner='freehold_owner'::regrole AND p.proconfig @> ARRAY['search_path=pg_catalog, freehold, pg_temp']) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='freehold'),'all functions have restricted owner and search path');
SELECT pg_temp.assert_true((SELECT bool_and(NOT has_table_privilege('freehold_app',c.oid,'INSERT') AND NOT has_table_privilege('freehold_app',c.oid,'UPDATE') AND NOT has_table_privilege('freehold_app',c.oid,'DELETE') AND NOT has_table_privilege('freehold_app',c.oid,'TRUNCATE')) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='freehold' AND c.relkind='r'),'runtime has no direct table writes');
SET LOCAL ROLE freehold_app;
DO $$
DECLARE first_result jsonb; replay jsonb; held jsonb; released jsonb; frozen jsonb; rejected jsonb; n bigint;
BEGIN
 first_result:=freehold.execute_internal_transfer('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000102','USD',25,'same-key');
 replay:=freehold.execute_internal_transfer('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000102','USD',25,'same-key');
 PERFORM pg_temp.assert_true(first_result=replay AND first_result->>'state'='COMPLETED','idempotent response equality');
 SELECT count(*) INTO n FROM freehold.ledger_journals WHERE operation_id=(first_result->>'operationId')::uuid;
 PERFORM pg_temp.assert_true(n=1,'one journal per idempotency key');
 PERFORM pg_temp.assert_true((SELECT available_minor=75 FROM freehold.accounts WHERE id='00000000-0000-0000-0000-000000000101'),'replay did not debit twice');
 BEGIN
  PERFORM freehold.execute_internal_transfer('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000102','USD',26,'same-key');
  RAISE EXCEPTION 'TEST FAILED: changed payload accepted';
 EXCEPTION WHEN invalid_parameter_value THEN
  PERFORM pg_temp.assert_true(SQLERRM='IDEMPOTENCY_CONFLICT','changed-payload failure reason');
 END;
 held:=freehold.reserve_funds('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000101',30,'reserve-key','test hold');
 PERFORM pg_temp.assert_true(held->>'state'='COMPLETED','reservation completed');
 PERFORM pg_temp.assert_true((SELECT available_minor=45 AND reserved_minor=30 FROM freehold.accounts WHERE id='00000000-0000-0000-0000-000000000101'),'reservation projection');
 frozen:=freehold.set_account_frozen('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000101',true,'freeze-key','test freeze');
 rejected:=freehold.execute_internal_transfer('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000102','USD',1,'frozen-debit');
 PERFORM pg_temp.assert_true(rejected->>'state'='REJECTED' AND rejected->>'error'='ACCOUNT_FROZEN','freeze blocks debits');
 PERFORM pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM freehold.ledger_journals WHERE operation_id=(rejected->>'operationId')::uuid),'rejection has no journal');
 PERFORM freehold.set_account_frozen('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000101',false,'unfreeze-key','test unfreeze');
 replay:=freehold.execute_internal_transfer('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000102','USD',1,'frozen-debit');
 PERFORM pg_temp.assert_true(replay=rejected,'rejection stays idempotent after unfreeze');
 released:=freehold.release_hold('00000000-0000-0000-0000-000000000002',(held->>'holdId')::uuid,'release-key');
 PERFORM pg_temp.assert_true(released->>'state'='COMPLETED','hold released');
 PERFORM pg_temp.assert_true(released=freehold.release_hold('00000000-0000-0000-0000-000000000002',(held->>'holdId')::uuid,'release-key'),'release replay');
 PERFORM pg_temp.assert_true((SELECT available_minor=75 AND reserved_minor=0 FROM freehold.accounts WHERE id='00000000-0000-0000-0000-000000000101'),'release restores funds');
 BEGIN
  UPDATE freehold.accounts SET available_minor=999 WHERE id='00000000-0000-0000-0000-000000000101';
  RAISE EXCEPTION 'TEST FAILED: direct account write permitted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM freehold._post_pair(NULL,NULL,NULL,NULL,NULL,NULL,1);
  RAISE EXCEPTION 'TEST FAILED: private helper executable';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM freehold.execute_internal_transfer('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000102','USD',1,'stolen-account');
  RAISE EXCEPTION 'TEST FAILED: wrong owner allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM freehold.execute_internal_transfer('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000105','USD',1,'cross-currency');
  RAISE EXCEPTION 'TEST FAILED: currency mismatch allowed';
 EXCEPTION WHEN invalid_parameter_value THEN
  PERFORM pg_temp.assert_true(SQLERRM='CURRENCY_MISMATCH','currency mismatch error');
 END;
 BEGIN
  PERFORM freehold.sandbox_fund_account('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000101',1,'user-funding','test');
  RAISE EXCEPTION 'TEST FAILED: user could sandbox-fund';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
-- Force every deferred invariant over the successful operations before rollback.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE freehold_owner;
DO $$
DECLARE j uuid; op uuid; equity uuid; other_equity uuid; original uuid; mode text;
BEGIN
 SELECT id INTO equity FROM freehold.ledger_accounts WHERE bucket='SANDBOX_EQUITY' AND currency_code='USD';
 INSERT INTO freehold.ledger_accounts(currency_code,bucket,accounting_class,normal_side) VALUES('EUR','SANDBOX_EQUITY','EQUITY','CREDIT') RETURNING id INTO other_equity;
 -- Exercise the actual deferred trigger, rather than calling its function.
 FOREACH mode IN ARRAY ARRAY['UNBALANCED','EMPTY','MULTI_CURRENCY'] LOOP
  BEGIN
   INSERT INTO freehold.idempotency_requests(actor_id,operation,key,request_payload,request_hash)
   VALUES('00000000-0000-0000-0000-000000000001','SANDBOX_FUND','invalid-'||mode,'{}',sha256(''::bytea)) RETURNING operation_id INTO op;
   INSERT INTO freehold.ledger_journals(operation_id,kind,correlation_id,created_by)
   VALUES(op,'SANDBOX_FUND',gen_random_uuid(),'00000000-0000-0000-0000-000000000001') RETURNING id INTO j;
   IF mode<>'EMPTY' THEN
    INSERT INTO freehold.ledger_entries(journal_id,line_no,ledger_account_id,currency_code,side,amount_minor) VALUES
     (j,1,equity,'USD','DEBIT',2),
     (j,2,CASE WHEN mode='MULTI_CURRENCY' THEN other_equity ELSE equity END,CASE WHEN mode='MULTI_CURRENCY' THEN 'EUR' ELSE 'USD' END,'CREDIT',CASE WHEN mode='UNBALANCED' THEN 1 ELSE 2 END);
   END IF;
   INSERT INTO freehold.journal_seals(journal_id) VALUES(j);
   SET CONSTRAINTS freehold.journal_balanced IMMEDIATE;
   RAISE EXCEPTION 'TEST FAILED: invalid journal accepted (%)',mode;
  EXCEPTION WHEN check_violation THEN
   PERFORM pg_temp.assert_true(SQLERRM LIKE 'INVALID_JOURNAL:%',mode||' deferred journal rejection');
  END;
 END LOOP;
 FOR original IN SELECT id FROM freehold.ledger_journals LOOP
 BEGIN
  INSERT INTO freehold.ledger_entries(journal_id,line_no,ledger_account_id,currency_code,side,amount_minor)
  VALUES(original,99,equity,'USD','CREDIT',1);
  RAISE EXCEPTION 'TEST FAILED: historical/sealed append allowed';
 EXCEPTION WHEN check_violation THEN
  PERFORM pg_temp.assert_true(SQLERRM='JOURNAL_ALREADY_SEALED_OR_HISTORICAL','sealed append rejection');
 END;
 END LOOP;
 SELECT id INTO original FROM freehold.ledger_journals LIMIT 1;
 BEGIN
  UPDATE freehold.ledger_entries SET amount_minor=amount_minor+1 WHERE journal_id=original;
  RAISE EXCEPTION 'TEST FAILED: entry update allowed';
 EXCEPTION WHEN check_violation THEN
  PERFORM pg_temp.assert_true(SQLERRM LIKE 'IMMUTABLE:%','entry immutability');
 END;
 BEGIN
  UPDATE freehold.accounts SET available_minor=available_minor+1 WHERE id='00000000-0000-0000-0000-000000000101';
  SET CONSTRAINTS freehold.account_projection IMMEDIATE;
  RAISE EXCEPTION 'TEST FAILED: projection tampering accepted';
 EXCEPTION WHEN check_violation THEN
  PERFORM pg_temp.assert_true(SQLERRM LIKE 'BALANCE_PROJECTION_OR_HOLD_MISMATCH:%','projection mismatch rejection');
 END;
END $$;
UPDATE freehold.ledger_settings SET sandbox_enabled=false,max_operation_minor=1;
SET LOCAL ROLE freehold_app;
DO $$
DECLARE replay jsonb; rejected jsonb;
BEGIN
 replay:=freehold.execute_internal_transfer('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000102','USD',25,'same-key');
 PERFORM pg_temp.assert_true(replay->>'state'='COMPLETED','stored response survives lower operation limit');
 rejected:=freehold.sandbox_fund_account('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000101',1,'sandbox-disabled','test kill switch');
 PERFORM pg_temp.assert_true(rejected->>'error'='SANDBOX_DISABLED','sandbox kill switch');
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
\echo 'PASS: atomic posting, idempotency, freeze, holds, privileges, deferred journal/projection invariants'
