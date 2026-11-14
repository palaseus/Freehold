\set ON_ERROR_STOP on
-- TEST DATABASE ONLY. Run after fixtures and 010_invariants.sql as superuser.
-- Uses two real PostgreSQL sessions, no application code. dblink is test-only.
-- Default connection uses the local socket and current superuser. For a remote
-- test server supply: psql -v test_conninfo='host=... dbname=... user=... ...'
-- Use .pgpass/service credentials rather than checking passwords into this file.
-- This test commits financial fixtures; run once in a disposable database.
CREATE SCHEMA freehold_test;
CREATE EXTENSION dblink WITH SCHEMA freehold_test;
\if :{?test_conninfo}
\else
 SELECT 'dbname=' || quote_literal(current_database()) || ' user=' || quote_literal(current_user) AS test_conninfo \gset
\endif
SELECT freehold_test.dblink_connect('fh_a', :'test_conninfo');
SELECT freehold_test.dblink_connect('fh_b', :'test_conninfo');
SELECT freehold_test.dblink_exec('fh_a','SET ROLE freehold_app');
SELECT freehold_test.dblink_exec('fh_b','SET ROLE freehold_app');
CREATE FUNCTION pg_temp.assert_true(value boolean,message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'TEST FAILED: %',message; END IF; END $$;
-- Assert that B is actually blocked by A, rather than assuming overlap from a
-- timing delay. Bounded polling happens only in this test, never in production.
CREATE FUNCTION pg_temp.await_block(p_a integer,p_b integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE deadline timestamptz:=clock_timestamp()+interval '3 seconds';
BEGIN
 LOOP
  IF p_a=ANY(pg_blocking_pids(p_b)) THEN RETURN; END IF;
  IF clock_timestamp()>deadline THEN RAISE EXCEPTION 'TEST FAILED: concurrent session did not block'; END IF;
  PERFORM pg_sleep(0.01);
 END LOOP;
END $$;
DO $$
DECLARE a_pid integer; b_pid integer; first_result jsonb; second_result jsonb; q text;
BEGIN
 SELECT pid INTO a_pid FROM freehold_test.dblink('fh_a','SELECT pg_backend_pid()') AS t(pid integer);
 SELECT pid INTO b_pid FROM freehold_test.dblink('fh_b','SELECT pg_backend_pid()') AS t(pid integer);
 PERFORM pg_temp.assert_true((SELECT available_minor=100 FROM freehold.accounts WHERE id='00000000-0000-0000-0000-000000000101'),'fresh concurrency fixture');
 PERFORM freehold_test.dblink_exec('fh_a','BEGIN');
 q:=$query$SELECT freehold.execute_internal_transfer('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000102','USD',80,'concurrent-a')$query$;
 SELECT result::jsonb INTO first_result FROM freehold_test.dblink('fh_a',q) AS t(result text);
 q:=$query$SELECT freehold.execute_internal_transfer('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000103','USD',80,'concurrent-b')$query$;
 PERFORM freehold_test.dblink_send_query('fh_b',q);
 PERFORM pg_temp.await_block(a_pid,b_pid);
 PERFORM freehold_test.dblink_exec('fh_a','COMMIT');
 SELECT result::jsonb INTO second_result FROM freehold_test.dblink_get_result('fh_b') AS t(result text);
 PERFORM pg_temp.assert_true(first_result->>'state'='COMPLETED','first concurrent debit completed');
 PERFORM pg_temp.assert_true(second_result->>'state'='REJECTED' AND second_result->>'error'='INSUFFICIENT_FUNDS','second debit rejected after waiting');
 PERFORM pg_temp.assert_true((SELECT available_minor=20 AND reserved_minor=0 FROM freehold.accounts WHERE id='00000000-0000-0000-0000-000000000101'),'no overspend');
 PERFORM pg_temp.assert_true((SELECT sum(available_minor::numeric+reserved_minor::numeric)=100 FROM freehold.accounts),'customer value conserved');
 -- Drain the terminating empty async result before reusing the connection.
 PERFORM * FROM freehold_test.dblink_get_result('fh_b') AS t(result text);
 -- Concurrent copies of the SAME key block on durable idempotency, then return
 -- byte-for-byte equal JSON results with one posting.
 PERFORM freehold_test.dblink_exec('fh_a','BEGIN');
 q:=$query$SELECT freehold.execute_internal_transfer('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000103','USD',5,'concurrent-same-key')$query$;
 SELECT result::jsonb INTO first_result FROM freehold_test.dblink('fh_a',q) AS t(result text);
 PERFORM freehold_test.dblink_send_query('fh_b',q);
 PERFORM pg_temp.await_block(a_pid,b_pid);
 PERFORM freehold_test.dblink_exec('fh_a','COMMIT');
 SELECT result::jsonb INTO second_result FROM freehold_test.dblink_get_result('fh_b') AS t(result text);
 PERFORM pg_temp.assert_true(first_result=second_result,'concurrent idempotency returned original');
 PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM freehold.ledger_journals WHERE operation_id=(first_result->>'operationId')::uuid),'concurrent idempotency posted once');
 PERFORM pg_temp.assert_true((SELECT available_minor=15 FROM freehold.accounts WHERE id='00000000-0000-0000-0000-000000000101'),'duplicate debited only once');
 PERFORM * FROM freehold_test.dblink_get_result('fh_b') AS t(result text);
 -- Freeze holds the same row lock as transfers. A debit already waiting behind
 -- an uncommitted freeze must see FROZEN after the administrator commits.
 PERFORM freehold_test.dblink_exec('fh_a','BEGIN');
 PERFORM * FROM freehold_test.dblink('fh_a',$query$SELECT freehold.set_account_frozen('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000101',true,'concurrent-freeze','test freeze ordering')$query$) AS t(result text);
 q:=$query$SELECT freehold.execute_internal_transfer('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000103','USD',1,'concurrent-frozen-debit')$query$;
 PERFORM freehold_test.dblink_send_query('fh_b',q);
 PERFORM pg_temp.await_block(a_pid,b_pid);
 PERFORM freehold_test.dblink_exec('fh_a','COMMIT');
 SELECT result::jsonb INTO second_result FROM freehold_test.dblink_get_result('fh_b') AS t(result text);
 PERFORM pg_temp.assert_true(second_result->>'error'='ACCOUNT_FROZEN','concurrent freeze blocks new debit');
 PERFORM * FROM freehold_test.dblink_get_result('fh_b') AS t(result text);
END $$;
SELECT freehold_test.dblink_disconnect('fh_a');
SELECT freehold_test.dblink_disconnect('fh_b');
DROP EXTENSION dblink;
DROP SCHEMA freehold_test;
\echo 'PASS: concurrent overspend, concurrent idempotency, concurrent freeze ordering'
