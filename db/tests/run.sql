\set ON_ERROR_STOP on
-- Run from any directory: psql -X -d <EMPTY_DISPOSABLE_TEST_DATABASE> -f db/tests/run.sql
-- Requires a deployment superuser and the contrib dblink extension package.
-- Creates cluster roles; run in a disposable cluster where these roles do not exist.
-- 020_concurrency.sql accepts -v test_conninfo=... when a local connection is unavailable.
\ir ../migrations/001_foundational_ledger.sql
\ir 000_fixtures.sql
\ir 010_invariants.sql
\ir 020_concurrency.sql
