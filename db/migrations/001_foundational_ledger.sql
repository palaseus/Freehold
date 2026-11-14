-- Freehold foundational ledger. PostgreSQL 16+; apply once to a fresh database
-- with psql -v ON_ERROR_STOP=1 -f db/migrations/001_foundational_ledger.sql.
-- Run as a deployment superuser; never grant freehold_owner to runtime logins.
-- Grant freehold_app to a separately provisioned service login (not end users).
-- p_actor is supplied by a TRUSTED authenticated backend, not by an end-user SQL
-- connection. A shared DB role cannot establish an individual user's identity.
-- Use one public financial operation per READ COMMITTED transaction; caller must
-- commit before reporting success. Leave constraint triggers initially deferred.
-- Retry 40P01/40001/55P03 with the same key. Structural/authentication errors
-- raise and roll back; business rejections commit an idempotent REJECTED result.
-- Multiple calls in one transaction can acquire locks across calls out of order;
-- callers batching operations must prelock their complete account set ascending.
-- References: https://www.postgresql.org/docs/current/sql-createfunction.html
--             https://www.postgresql.org/docs/current/sql-createtrigger.html
BEGIN;
CREATE ROLE freehold_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE freehold_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE SCHEMA freehold AUTHORIZATION freehold_owner;
REVOKE ALL ON SCHEMA freehold FROM PUBLIC;
SET LOCAL ROLE freehold_owner;
SET LOCAL search_path = pg_catalog, freehold, pg_temp;
ALTER DEFAULT PRIVILEGES IN SCHEMA freehold REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE freehold.users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 email_normalized text NOT NULL UNIQUE CHECK (email_normalized = lower(btrim(email_normalized)) AND length(email_normalized) BETWEEN 3 AND 320),
 password_hash text NOT NULL CHECK (length(password_hash) > 0),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
 role text NOT NULL DEFAULT 'USER' CHECK (role IN ('USER','ADMIN')),
 totp_secret_encrypted bytea,
 auth_version bigint NOT NULL DEFAULT 1 CHECK (auth_version > 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE freehold.currencies (
 code text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9]{2,11}$'),
 name text NOT NULL CHECK (length(btrim(name)) > 0),
 minor_unit_exponent smallint NOT NULL CHECK (minor_unit_exponent BETWEEN 0 AND 18),
 enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE freehold.ledger_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 sandbox_enabled boolean NOT NULL DEFAULT false,
 max_operation_minor bigint NOT NULL DEFAULT 1000000000000000 CHECK (max_operation_minor > 0)
);
INSERT INTO freehold.ledger_settings DEFAULT VALUES;
COMMENT ON TABLE freehold.ledger_settings IS 'Deployment-controlled. Sandbox funding is never proof of custody. No runtime write grants.';
CREATE TABLE freehold.accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL REFERENCES freehold.users(id),
 currency_code text NOT NULL REFERENCES freehold.currencies(code),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FROZEN','CLOSED')),
 available_minor bigint NOT NULL DEFAULT 0 CHECK (available_minor >= 0),
 reserved_minor bigint NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (owner_user_id,currency_code), UNIQUE (id,currency_code),
 CHECK (status <> 'CLOSED' OR (available_minor = 0 AND reserved_minor = 0))
);
CREATE INDEX accounts_owner_status_idx ON freehold.accounts(owner_user_id,status);
CREATE TABLE freehold.ledger_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 currency_code text NOT NULL REFERENCES freehold.currencies(code),
 customer_account_id uuid,
 bucket text NOT NULL CHECK (bucket IN ('AVAILABLE','RESERVED','SANDBOX_EQUITY')),
 accounting_class text NOT NULL CHECK (accounting_class IN ('LIABILITY','EQUITY')),
 normal_side text NOT NULL CHECK (normal_side IN ('DEBIT','CREDIT')),
 FOREIGN KEY (customer_account_id,currency_code) REFERENCES freehold.accounts(id,currency_code),
 UNIQUE (id,currency_code),
 CHECK ((customer_account_id IS NOT NULL AND bucket IN ('AVAILABLE','RESERVED') AND accounting_class='LIABILITY' AND normal_side='CREDIT')
     OR (customer_account_id IS NULL AND bucket='SANDBOX_EQUITY' AND accounting_class='EQUITY' AND normal_side='CREDIT'))
);
CREATE UNIQUE INDEX ledger_customer_bucket_idx ON freehold.ledger_accounts(customer_account_id,bucket) WHERE customer_account_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_equity_currency_idx ON freehold.ledger_accounts(currency_code,bucket) WHERE customer_account_id IS NULL;

CREATE TABLE freehold.idempotency_requests (
 actor_id uuid NOT NULL REFERENCES freehold.users(id),
 operation text NOT NULL CHECK (operation IN ('TRANSFER','RESERVE','RELEASE','SANDBOX_FUND','FREEZE','UNFREEZE','CREATE_ACCOUNT')),
 key text NOT NULL CHECK (length(btrim(key)) BETWEEN 1 AND 200),
 operation_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload)='object'),
 request_hash bytea NOT NULL CHECK (octet_length(request_hash)=32),
 resource_id uuid,
 response_status integer CHECK (response_status BETWEEN 200 AND 599),
 response_body jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz,
 PRIMARY KEY (actor_id,operation,key),
 CHECK ((response_body IS NULL AND response_status IS NULL AND completed_at IS NULL)
     OR (response_body IS NOT NULL AND response_status IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE TABLE freehold.transfers (
 id uuid PRIMARY KEY,
 operation_id uuid NOT NULL UNIQUE REFERENCES freehold.idempotency_requests(operation_id),
 initiator_user_id uuid NOT NULL REFERENCES freehold.users(id),
 source_account_id uuid NOT NULL,
 destination_account_id uuid NOT NULL,
 currency_code text NOT NULL REFERENCES freehold.currencies(code),
 amount_minor bigint NOT NULL CHECK (amount_minor > 0),
 state text NOT NULL CHECK (state IN ('RECEIVED','COMPLETED','REJECTED')),
 idempotency_key text NOT NULL,
 request_hash bytea NOT NULL CHECK (octet_length(request_hash)=32),
 correlation_id uuid NOT NULL,
 failure_code text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (initiator_user_id,idempotency_key),
 FOREIGN KEY (source_account_id,currency_code) REFERENCES freehold.accounts(id,currency_code),
 FOREIGN KEY (destination_account_id,currency_code) REFERENCES freehold.accounts(id,currency_code),
 CHECK (source_account_id <> destination_account_id),
 CHECK ((state='REJECTED') = (failure_code IS NOT NULL))
);
CREATE INDEX transfers_source_history_idx ON freehold.transfers(source_account_id,created_at DESC,id);
CREATE INDEX transfers_destination_history_idx ON freehold.transfers(destination_account_id,created_at DESC,id);
CREATE INDEX transfers_correlation_idx ON freehold.transfers(correlation_id);
CREATE TABLE freehold.holds (
 id uuid PRIMARY KEY,
 account_id uuid NOT NULL,
 currency_code text NOT NULL,
 amount_minor bigint NOT NULL CHECK (amount_minor > 0),
 state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','RELEASED')),
 purpose text NOT NULL CHECK (length(btrim(purpose)) BETWEEN 1 AND 500),
 expires_at timestamptz,
 creation_operation_id uuid NOT NULL UNIQUE REFERENCES freehold.idempotency_requests(operation_id),
 release_operation_id uuid UNIQUE REFERENCES freehold.idempotency_requests(operation_id),
 capture_operation_id uuid UNIQUE REFERENCES freehold.idempotency_requests(operation_id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 released_at timestamptz,
 FOREIGN KEY (account_id,currency_code) REFERENCES freehold.accounts(id,currency_code),
 CHECK (expires_at IS NULL OR expires_at > created_at),
 CHECK ((state='ACTIVE' AND release_operation_id IS NULL AND released_at IS NULL)
     OR (state='RELEASED' AND release_operation_id IS NOT NULL AND released_at IS NOT NULL)),
 CHECK (capture_operation_id IS NULL) -- Capture is intentionally unsupported in this MVP.
);
CREATE INDEX holds_active_idx ON freehold.holds(account_id,expires_at,id) WHERE state='ACTIVE';
CREATE TABLE freehold.ledger_journals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 operation_id uuid NOT NULL UNIQUE REFERENCES freehold.idempotency_requests(operation_id),
 transfer_id uuid UNIQUE REFERENCES freehold.transfers(id),
 hold_id uuid REFERENCES freehold.holds(id),
 kind text NOT NULL CHECK (kind IN ('INTERNAL_TRANSFER','RESERVE','RELEASE','SANDBOX_FUND')),
 correlation_id uuid NOT NULL,
 effective_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reverses_journal_id uuid UNIQUE REFERENCES freehold.ledger_journals(id),
 created_by uuid NOT NULL REFERENCES freehold.users(id),
 creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 CHECK ((kind='INTERNAL_TRANSFER') = (transfer_id IS NOT NULL)),
 CHECK ((kind IN ('RESERVE','RELEASE')) = (hold_id IS NOT NULL)),
 CHECK (reverses_journal_id IS NULL) -- Add a separately reviewed reversal command later.
);
CREATE INDEX journals_effective_idx ON freehold.ledger_journals(effective_at,id);
CREATE INDEX journals_recorded_idx ON freehold.ledger_journals(recorded_at,id);
CREATE INDEX journals_correlation_idx ON freehold.ledger_journals(correlation_id);
CREATE INDEX journals_hold_idx ON freehold.ledger_journals(hold_id);
CREATE TABLE freehold.ledger_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 journal_id uuid NOT NULL REFERENCES freehold.ledger_journals(id),
 line_no smallint NOT NULL CHECK (line_no > 0),
 ledger_account_id uuid NOT NULL,
 currency_code text NOT NULL,
 side text NOT NULL CHECK (side IN ('DEBIT','CREDIT')),
 amount_minor bigint NOT NULL CHECK (amount_minor > 0),
 UNIQUE (journal_id,line_no),
 FOREIGN KEY (ledger_account_id,currency_code) REFERENCES freehold.ledger_accounts(id,currency_code)
);
CREATE INDEX entries_account_journal_idx ON freehold.ledger_entries(ledger_account_id,journal_id);
-- Private seal is insert-only. Unlike checking creation_xid alone, it prevents
-- appending after a function returns in the SAME transaction.
CREATE TABLE freehold.journal_seals (
 journal_id uuid PRIMARY KEY REFERENCES freehold.ledger_journals(id),
 sealed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE freehold.admin_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_user_id uuid NOT NULL REFERENCES freehold.users(id),
 action_type text NOT NULL CHECK (action_type IN ('FREEZE','UNFREEZE','SANDBOX_FUND')),
 target_id uuid NOT NULL REFERENCES freehold.accounts(id),
 operation_id uuid NOT NULL UNIQUE REFERENCES freehold.idempotency_requests(operation_id),
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
 correlation_id uuid NOT NULL,
 before_state jsonb NOT NULL,
 after_state jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX admin_actions_target_idx ON freehold.admin_actions(target_id,recorded_at,id);
CREATE TABLE freehold.audit_log (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid REFERENCES freehold.users(id),
 service_identity text,
 event_type text NOT NULL,
 resource_id uuid NOT NULL,
 operation_id uuid UNIQUE REFERENCES freehold.idempotency_requests(operation_id),
 correlation_id uuid NOT NULL,
 request_id uuid NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('COMPLETED','REJECTED')),
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (actor_id IS NOT NULL OR service_identity IS NOT NULL)
);
CREATE INDEX audit_resource_idx ON freehold.audit_log(resource_id,recorded_at,id);
CREATE INDEX audit_correlation_idx ON freehold.audit_log(correlation_id);
CREATE TABLE freehold.outbox_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 aggregate_id uuid NOT NULL,
 operation_id uuid NOT NULL UNIQUE REFERENCES freehold.idempotency_requests(operation_id),
 event_type text NOT NULL,
 payload_version integer NOT NULL DEFAULT 1 CHECK (payload_version > 0),
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 dispatched_at timestamptz,
 attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)
);
CREATE INDEX outbox_pending_idx ON freehold.outbox_events(created_at,id) WHERE dispatched_at IS NULL;
-- Reserved integration boundary only; no runtime settlement function or grants.
CREATE TABLE freehold.settlement_instructions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 operation_id uuid NOT NULL UNIQUE REFERENCES freehold.idempotency_requests(operation_id),
 transfer_id uuid REFERENCES freehold.transfers(id),
 hold_id uuid REFERENCES freehold.holds(id),
 adapter text NOT NULL,
 external_reference text,
 status text NOT NULL DEFAULT 'DISABLED' CHECK (status='DISABLED'),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION freehold._immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE: %.% % forbidden',TG_TABLE_SCHEMA,TG_TABLE_NAME,TG_OP USING ERRCODE='23514'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ledger_journals','ledger_entries','ledger_accounts','journal_seals','transfers','admin_actions','audit_log'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON freehold.%I FOR EACH ROW EXECUTE FUNCTION freehold._immutable()',t);
  EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON freehold.%I FOR EACH STATEMENT EXECUTE FUNCTION freehold._immutable()',t);
 END LOOP;
END $$;

CREATE FUNCTION freehold._account_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCOUNT_DELETE_FORBIDDEN' USING ERRCODE='23514'; END IF;
 IF ROW(NEW.id,NEW.owner_user_id,NEW.currency_code,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.owner_user_id,OLD.currency_code,OLD.created_at)
 OR (OLD.status='CLOSED' AND NEW IS DISTINCT FROM OLD) THEN
  RAISE EXCEPTION 'ACCOUNT_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 NEW.updated_at := clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER account_guard BEFORE UPDATE OR DELETE ON freehold.accounts FOR EACH ROW EXECUTE FUNCTION freehold._account_guard();
CREATE TRIGGER account_no_truncate BEFORE TRUNCATE ON freehold.accounts FOR EACH STATEMENT EXECUTE FUNCTION freehold._immutable();
CREATE FUNCTION freehold._create_buckets() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 INSERT INTO freehold.ledger_accounts(currency_code,customer_account_id,bucket,accounting_class,normal_side)
 VALUES (NEW.currency_code,NEW.id,'AVAILABLE','LIABILITY','CREDIT'),(NEW.currency_code,NEW.id,'RESERVED','LIABILITY','CREDIT');
 RETURN NEW;
END $$;
CREATE TRIGGER account_buckets AFTER INSERT ON freehold.accounts FOR EACH ROW EXECUTE FUNCTION freehold._create_buckets();
CREATE FUNCTION freehold._currency_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 IF ROW(NEW.code,NEW.minor_unit_exponent) IS DISTINCT FROM ROW(OLD.code,OLD.minor_unit_exponent) THEN
  RAISE EXCEPTION 'CURRENCY_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER currency_guard BEFORE UPDATE ON freehold.currencies FOR EACH ROW EXECUTE FUNCTION freehold._currency_guard();

CREATE FUNCTION freehold._hold_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'HOLD_DELETE_FORBIDDEN' USING ERRCODE='23514'; END IF;
 IF OLD.state<>'ACTIVE' OR NEW.state<>'RELEASED'
 OR (to_jsonb(NEW)-ARRAY['state','release_operation_id','released_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','release_operation_id','released_at']) THEN
  RAISE EXCEPTION 'HOLD_INVALID_TRANSITION' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hold_guard BEFORE UPDATE OR DELETE ON freehold.holds FOR EACH ROW EXECUTE FUNCTION freehold._hold_guard();
CREATE TRIGGER hold_no_truncate BEFORE TRUNCATE ON freehold.holds FOR EACH STATEMENT EXECUTE FUNCTION freehold._immutable();
CREATE FUNCTION freehold._idempotency_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'IDEMPOTENCY_DELETE_FORBIDDEN' USING ERRCODE='23514'; END IF;
 IF OLD.response_body IS NOT NULL OR NEW.response_body IS NULL
 OR (to_jsonb(NEW)-ARRAY['resource_id','response_status','response_body','completed_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['resource_id','response_status','response_body','completed_at']) THEN
  RAISE EXCEPTION 'IDEMPOTENCY_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER idempotency_guard BEFORE UPDATE OR DELETE ON freehold.idempotency_requests FOR EACH ROW EXECUTE FUNCTION freehold._idempotency_guard();
CREATE TRIGGER idempotency_no_truncate BEFORE TRUNCATE ON freehold.idempotency_requests FOR EACH STATEMENT EXECUTE FUNCTION freehold._immutable();

CREATE FUNCTION freehold._entry_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE x xid8;
BEGIN
 SELECT creation_xid INTO x FROM freehold.ledger_journals WHERE id=NEW.journal_id;
 IF x IS DISTINCT FROM pg_current_xact_id() OR EXISTS(SELECT 1 FROM freehold.journal_seals WHERE journal_id=NEW.journal_id) THEN
  RAISE EXCEPTION 'JOURNAL_ALREADY_SEALED_OR_HISTORICAL' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER entry_guard BEFORE INSERT ON freehold.ledger_entries FOR EACH ROW EXECUTE FUNCTION freehold._entry_guard();
CREATE FUNCTION freehold._apply_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE a freehold.ledger_accounts; delta bigint;
BEGIN
 SELECT * INTO STRICT a FROM freehold.ledger_accounts WHERE id=NEW.ledger_account_id;
 IF a.customer_account_id IS NOT NULL THEN
  delta := CASE NEW.side WHEN 'CREDIT' THEN NEW.amount_minor ELSE -NEW.amount_minor END;
  -- Public functions already hold all affected customer account locks ascending.
  UPDATE freehold.accounts SET
   available_minor=available_minor+CASE WHEN a.bucket='AVAILABLE' THEN delta ELSE 0 END,
   reserved_minor=reserved_minor+CASE WHEN a.bucket='RESERVED' THEN delta ELSE 0 END
  WHERE id=a.customer_account_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER apply_entry AFTER INSERT ON freehold.ledger_entries FOR EACH ROW EXECUTE FUNCTION freehold._apply_entry();

-- Full indexed history aggregation is deliberately simple for the MVP. Its cost
-- grows with account history and is paid at commit; benchmark before raising
-- transaction-volume limits. Do not remove this check without a proven replacement.
CREATE FUNCTION freehold._check_account(p_account uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE a freehold.accounts; av numeric; rs numeric; held numeric;
BEGIN
 SELECT * INTO STRICT a FROM freehold.accounts WHERE id=p_account;
 SELECT coalesce(sum(CASE WHEN la.bucket='AVAILABLE' THEN CASE e.side WHEN 'CREDIT' THEN e.amount_minor::numeric ELSE -e.amount_minor::numeric END ELSE 0 END),0),
        coalesce(sum(CASE WHEN la.bucket='RESERVED' THEN CASE e.side WHEN 'CREDIT' THEN e.amount_minor::numeric ELSE -e.amount_minor::numeric END ELSE 0 END),0)
 INTO av,rs FROM freehold.ledger_accounts la LEFT JOIN freehold.ledger_entries e ON e.ledger_account_id=la.id WHERE la.customer_account_id=p_account;
 SELECT coalesce(sum(amount_minor::numeric),0) INTO held FROM freehold.holds WHERE account_id=p_account AND state='ACTIVE';
 IF a.available_minor<0 OR a.reserved_minor<0 OR a.available_minor::numeric<>av OR a.reserved_minor::numeric<>rs OR rs<>held THEN
  RAISE EXCEPTION 'BALANCE_PROJECTION_OR_HOLD_MISMATCH: %',p_account USING ERRCODE='23514';
 END IF;
 IF (SELECT count(*) FROM freehold.ledger_accounts WHERE customer_account_id=p_account)<>2 THEN
  RAISE EXCEPTION 'MISSING_CUSTOMER_BUCKETS' USING ERRCODE='23514';
 END IF;
END $$;
CREATE FUNCTION freehold._account_constraint() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE a uuid;
BEGIN
 IF TG_TABLE_NAME='accounts' THEN a:=NEW.id;
 ELSIF TG_TABLE_NAME='holds' THEN a:=NEW.account_id;
 ELSIF TG_TABLE_NAME='ledger_accounts' THEN a:=NEW.customer_account_id;
 ELSE SELECT customer_account_id INTO a FROM freehold.ledger_accounts WHERE id=NEW.ledger_account_id;
 END IF;
 IF a IS NOT NULL THEN PERFORM freehold._check_account(a); END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER account_projection AFTER INSERT OR UPDATE ON freehold.accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION freehold._account_constraint();
CREATE CONSTRAINT TRIGGER entry_projection AFTER INSERT ON freehold.ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION freehold._account_constraint();
CREATE CONSTRAINT TRIGGER bucket_projection AFTER INSERT ON freehold.ledger_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION freehold._account_constraint();
CREATE CONSTRAINT TRIGGER hold_projection AFTER INSERT OR UPDATE ON freehold.holds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION freehold._account_constraint();

CREATE FUNCTION freehold._check_journal(p_journal uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE j freehold.ledger_journals; t freehold.transfers; h freehold.holds; req freehold.idempotency_requests;
 n bigint; currencies bigint; net numeric; matches bigint;
BEGIN
 SELECT * INTO STRICT j FROM freehold.ledger_journals WHERE id=p_journal;
 SELECT count(*),count(DISTINCT currency_code),coalesce(sum(CASE side WHEN 'DEBIT' THEN amount_minor::numeric ELSE -amount_minor::numeric END),0)
 INTO n,currencies,net FROM freehold.ledger_entries WHERE journal_id=p_journal;
 IF n<2 OR currencies<>1 OR net<>0 OR NOT EXISTS(SELECT 1 FROM freehold.journal_seals WHERE journal_id=p_journal) THEN
  RAISE EXCEPTION 'INVALID_JOURNAL: %',p_journal USING ERRCODE='23514';
 END IF;
 -- This MVP has exactly two lines per operation. Expand templates deliberately.
 IF n<>2 THEN RAISE EXCEPTION 'INVALID_POSTING_TEMPLATE' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT req FROM freehold.idempotency_requests WHERE operation_id=j.operation_id;
 IF req.actor_id<>j.created_by OR req.response_body IS NULL OR req.response_body->>'state' IS DISTINCT FROM 'COMPLETED'
 OR req.response_body->>'journalId' IS DISTINCT FROM j.id::text THEN
  RAISE EXCEPTION 'JOURNAL_REQUEST_MISMATCH' USING ERRCODE='23514';
 END IF;
 IF j.kind='INTERNAL_TRANSFER' THEN
  SELECT * INTO STRICT t FROM freehold.transfers WHERE id=j.transfer_id;
  IF t.state<>'COMPLETED' OR t.operation_id<>j.operation_id OR t.initiator_user_id<>j.created_by OR req.operation<>'TRANSFER' THEN
   RAISE EXCEPTION 'TRANSFER_JOURNAL_MISMATCH' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO matches FROM freehold.ledger_entries e JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id
  WHERE e.journal_id=j.id AND e.currency_code=t.currency_code AND e.amount_minor=t.amount_minor AND la.bucket='AVAILABLE'
   AND ((e.side='DEBIT' AND la.customer_account_id=t.source_account_id) OR (e.side='CREDIT' AND la.customer_account_id=t.destination_account_id));
 ELSIF j.kind IN ('RESERVE','RELEASE') THEN
  SELECT * INTO STRICT h FROM freehold.holds WHERE id=j.hold_id;
  IF (j.kind='RESERVE' AND (h.creation_operation_id<>j.operation_id OR req.operation<>'RESERVE'))
   OR (j.kind='RELEASE' AND (h.release_operation_id IS DISTINCT FROM j.operation_id OR h.state<>'RELEASED' OR req.operation<>'RELEASE')) THEN
   RAISE EXCEPTION 'HOLD_JOURNAL_MISMATCH' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO matches FROM freehold.ledger_entries e JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id
  WHERE e.journal_id=j.id AND la.customer_account_id=h.account_id AND e.currency_code=h.currency_code AND e.amount_minor=h.amount_minor
   AND ((e.side='DEBIT' AND la.bucket=CASE j.kind WHEN 'RESERVE' THEN 'AVAILABLE' ELSE 'RESERVED' END)
     OR (e.side='CREDIT' AND la.bucket=CASE j.kind WHEN 'RESERVE' THEN 'RESERVED' ELSE 'AVAILABLE' END));
 ELSE
  IF req.operation<>'SANDBOX_FUND' OR NOT EXISTS(SELECT 1 FROM freehold.admin_actions WHERE operation_id=j.operation_id AND action_type='SANDBOX_FUND') THEN
   RAISE EXCEPTION 'SANDBOX_JOURNAL_MISMATCH' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO matches FROM freehold.ledger_entries e JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id
  WHERE e.journal_id=j.id AND e.amount_minor=(req.request_payload->>'amountMinor')::bigint
   AND ((e.side='DEBIT' AND la.bucket='SANDBOX_EQUITY' AND la.customer_account_id IS NULL)
    OR (e.side='CREDIT' AND la.bucket='AVAILABLE' AND la.customer_account_id=(req.request_payload->>'accountId')::uuid));
 END IF;
 IF matches<>2 THEN RAISE EXCEPTION 'POSTING_BUSINESS_MISMATCH' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION freehold._journal_constraint() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='ledger_journals' THEN PERFORM freehold._check_journal(NEW.id);
 ELSE PERFORM freehold._check_journal(NEW.journal_id); END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT ON freehold.ledger_journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION freehold._journal_constraint();
CREATE CONSTRAINT TRIGGER entries_balanced AFTER INSERT ON freehold.ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION freehold._journal_constraint();
CREATE CONSTRAINT TRIGGER seal_balanced AFTER INSERT ON freehold.journal_seals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION freehold._journal_constraint();

CREATE FUNCTION freehold._operation_constraint() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE r freehold.idempotency_requests; t freehold.transfers; h freehold.holds;
BEGIN
 IF TG_TABLE_NAME='idempotency_requests' THEN
  SELECT * INTO STRICT r FROM freehold.idempotency_requests WHERE operation_id=NEW.operation_id;
  IF r.response_body IS NULL OR r.response_body->>'operationId' IS DISTINCT FROM r.operation_id::text
   OR NOT EXISTS(SELECT 1 FROM freehold.audit_log WHERE operation_id=r.operation_id)
   OR NOT EXISTS(SELECT 1 FROM freehold.outbox_events WHERE operation_id=r.operation_id) THEN
   RAISE EXCEPTION 'INCOMPLETE_OPERATION' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME='transfers' THEN
  SELECT * INTO STRICT t FROM freehold.transfers WHERE id=NEW.id;
  SELECT * INTO STRICT r FROM freehold.idempotency_requests WHERE operation_id=t.operation_id;
  IF t.state='RECEIVED' OR r.actor_id<>t.initiator_user_id OR r.key<>t.idempotency_key OR r.request_hash<>t.request_hash
   OR r.operation<>'TRANSFER' OR r.resource_id IS DISTINCT FROM t.id
   OR r.response_body->>'state' IS DISTINCT FROM t.state
   OR ((t.state='COMPLETED') <> EXISTS(SELECT 1 FROM freehold.ledger_journals WHERE transfer_id=t.id)) THEN
   RAISE EXCEPTION 'INVALID_TRANSFER_STATE' USING ERRCODE='23514';
  END IF;
 ELSE
  SELECT * INTO STRICT h FROM freehold.holds WHERE id=NEW.id;
  IF NOT EXISTS(SELECT 1 FROM freehold.ledger_journals WHERE hold_id=h.id AND kind='RESERVE' AND operation_id=h.creation_operation_id)
   OR ((h.state='RELEASED') <> EXISTS(SELECT 1 FROM freehold.ledger_journals WHERE hold_id=h.id AND kind='RELEASE' AND operation_id=h.release_operation_id)) THEN
   RAISE EXCEPTION 'HOLD_MISSING_JOURNAL' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER idempotency_complete AFTER INSERT OR UPDATE ON freehold.idempotency_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION freehold._operation_constraint();
CREATE CONSTRAINT TRIGGER transfer_complete AFTER INSERT ON freehold.transfers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION freehold._operation_constraint();
CREATE CONSTRAINT TRIGGER hold_complete AFTER INSERT OR UPDATE ON freehold.holds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION freehold._operation_constraint();

-- Private helpers. None are executable by PUBLIC or freehold_app.
CREATE FUNCTION freehold._actor(p_actor uuid,p_admin boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE u freehold.users;
BEGIN
 SELECT * INTO u FROM freehold.users WHERE id=p_actor FOR SHARE;
 IF NOT FOUND OR u.status<>'ACTIVE' OR (p_admin AND u.role<>'ADMIN') THEN
  RAISE EXCEPTION 'ACTOR_NOT_AUTHORIZED' USING ERRCODE='42501';
 END IF;
END $$;
CREATE FUNCTION freehold._amount(p_amount bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
BEGIN
 IF p_amount IS NULL OR p_amount<=0 OR p_amount>(SELECT max_operation_minor FROM freehold.ledger_settings WHERE singleton) THEN
  RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE='22023';
 END IF;
END $$;
CREATE FUNCTION freehold._claim(p_actor uuid,p_operation text,p_key text,p_payload jsonb)
RETURNS freehold.idempotency_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE r freehold.idempotency_requests; digest bytea;
BEGIN
 IF p_key IS NULL OR length(btrim(p_key)) NOT BETWEEN 1 AND 200 THEN
  RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY' USING ERRCODE='22023';
 END IF;
 digest:=sha256(convert_to(p_payload::text,'UTF8'));
 INSERT INTO freehold.idempotency_requests(actor_id,operation,key,request_payload,request_hash)
 VALUES(p_actor,p_operation,p_key,p_payload,digest) ON CONFLICT (actor_id,operation,key) DO NOTHING;
 SELECT * INTO STRICT r FROM freehold.idempotency_requests WHERE actor_id=p_actor AND operation=p_operation AND key=p_key FOR UPDATE;
 IF r.request_hash<>digest OR r.request_payload<>p_payload THEN
  RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='22023';
 END IF;
 RETURN r;
END $$;
CREATE FUNCTION freehold._finish(p_operation uuid,p_resource uuid,p_correlation uuid,p_body jsonb,p_status integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE r freehold.idempotency_requests; result jsonb;
BEGIN
 result:=p_body||jsonb_build_object('operationId',p_operation,'correlationId',p_correlation);
 UPDATE freehold.idempotency_requests SET resource_id=p_resource,response_status=p_status,response_body=result,completed_at=clock_timestamp()
 WHERE operation_id=p_operation AND response_body IS NULL RETURNING * INTO STRICT r;
 INSERT INTO freehold.audit_log(actor_id,event_type,resource_id,operation_id,correlation_id,request_id,outcome,metadata)
 VALUES(r.actor_id,r.operation,p_resource,p_operation,p_correlation,p_correlation,result->>'state',result);
 INSERT INTO freehold.outbox_events(aggregate_id,operation_id,event_type,payload)
 VALUES(p_resource,p_operation,r.operation||'.'||(result->>'state'),result);
 RETURN result;
END $$;
CREATE FUNCTION freehold._post_pair(p_operation uuid,p_actor uuid,p_kind text,p_correlation uuid,p_debit uuid,p_credit uuid,p_amount bigint,p_transfer uuid DEFAULT NULL,p_hold uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp AS $$
DECLARE journal uuid:=gen_random_uuid(); currency text; other_currency text;
BEGIN
 SELECT currency_code INTO STRICT currency FROM freehold.ledger_accounts WHERE id=p_debit;
 SELECT currency_code INTO STRICT other_currency FROM freehold.ledger_accounts WHERE id=p_credit;
 IF currency<>other_currency OR p_debit=p_credit THEN RAISE EXCEPTION 'INVALID_POSTING_PAIR' USING ERRCODE='23514'; END IF;
 INSERT INTO freehold.ledger_journals(id,operation_id,created_by,kind,correlation_id,transfer_id,hold_id)
 VALUES(journal,p_operation,p_actor,p_kind,p_correlation,p_transfer,p_hold);
 INSERT INTO freehold.ledger_entries(journal_id,line_no,ledger_account_id,currency_code,side,amount_minor)
 VALUES(journal,1,p_debit,currency,'DEBIT',p_amount),(journal,2,p_credit,currency,'CREDIT',p_amount);
 INSERT INTO freehold.journal_seals(journal_id) VALUES(journal);
 RETURN journal;
END $$;

CREATE FUNCTION freehold.execute_internal_transfer(p_actor uuid,p_source uuid,p_destination uuid,p_currency text,p_amount bigint,p_key text,p_correlation uuid DEFAULT gen_random_uuid())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
DECLARE r freehold.idempotency_requests; src freehold.accounts; dst freehold.accounts;
 enabled boolean; failure text; transfer uuid:=gen_random_uuid(); journal uuid; debit uuid; credit uuid;
BEGIN
 PERFORM freehold._actor(p_actor);
 IF p_source IS NULL OR p_destination IS NULL OR p_source=p_destination OR p_currency IS NULL OR p_correlation IS NULL THEN
  RAISE EXCEPTION 'INVALID_TRANSFER' USING ERRCODE='22023';
 END IF;
 r:=freehold._claim(p_actor,'TRANSFER',p_key,jsonb_build_object('sourceAccountId',p_source,'destinationAccountId',p_destination,'currency',p_currency,'amountMinor',p_amount::text));
 IF r.response_body IS NOT NULL THEN RETURN r.response_body; END IF;
 PERFORM freehold._amount(p_amount);
 SELECT c.enabled INTO enabled FROM freehold.currencies c WHERE code=p_currency FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_CURRENCY' USING ERRCODE='22023'; END IF;
 -- UUID ordering is the global lock order, independent of debit direction.
 PERFORM id FROM freehold.accounts WHERE id IN (p_source,p_destination) ORDER BY id FOR UPDATE;
 SELECT * INTO src FROM freehold.accounts WHERE id=p_source;
 IF NOT FOUND OR src.owner_user_id<>p_actor THEN RAISE EXCEPTION 'SOURCE_NOT_AUTHORIZED' USING ERRCODE='42501'; END IF;
 SELECT * INTO dst FROM freehold.accounts WHERE id=p_destination;
 IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_DESTINATION' USING ERRCODE='22023'; END IF;
 IF src.currency_code<>p_currency OR dst.currency_code<>p_currency THEN RAISE EXCEPTION 'CURRENCY_MISMATCH' USING ERRCODE='22023'; END IF;
 failure:=CASE WHEN NOT enabled THEN 'CURRENCY_DISABLED'
  WHEN src.status='FROZEN' OR dst.status='FROZEN' THEN 'ACCOUNT_FROZEN'
  WHEN src.status<>'ACTIVE' OR dst.status<>'ACTIVE' THEN 'ACCOUNT_CLOSED'
  WHEN src.available_minor<p_amount THEN 'INSUFFICIENT_FUNDS'
  WHEN dst.available_minor::numeric+p_amount::numeric>9223372036854775807::numeric THEN 'BALANCE_LIMIT' END;
 INSERT INTO freehold.transfers(id,operation_id,initiator_user_id,source_account_id,destination_account_id,currency_code,amount_minor,state,idempotency_key,request_hash,correlation_id,failure_code)
 VALUES(transfer,r.operation_id,p_actor,p_source,p_destination,p_currency,p_amount,CASE WHEN failure IS NULL THEN 'COMPLETED' ELSE 'REJECTED' END,p_key,r.request_hash,p_correlation,failure);
 IF failure IS NOT NULL THEN
  RETURN freehold._finish(r.operation_id,transfer,p_correlation,jsonb_build_object('transferId',transfer,'state','REJECTED','error',failure),422);
 END IF;
 SELECT id INTO STRICT debit FROM freehold.ledger_accounts WHERE customer_account_id=p_source AND bucket='AVAILABLE';
 SELECT id INTO STRICT credit FROM freehold.ledger_accounts WHERE customer_account_id=p_destination AND bucket='AVAILABLE';
 journal:=freehold._post_pair(r.operation_id,p_actor,'INTERNAL_TRANSFER',p_correlation,debit,credit,p_amount,transfer);
 RETURN freehold._finish(r.operation_id,transfer,p_correlation,jsonb_build_object('transferId',transfer,'journalId',journal,'state','COMPLETED','currency',p_currency,'amountMinor',p_amount::text));
END $$;

CREATE FUNCTION freehold.reserve_funds(p_actor uuid,p_account uuid,p_amount bigint,p_key text,p_purpose text,p_expires_at timestamptz DEFAULT NULL,p_correlation uuid DEFAULT gen_random_uuid())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
DECLARE r freehold.idempotency_requests; a freehold.accounts; currency text; enabled boolean;
 failure text; hold uuid:=gen_random_uuid(); journal uuid; debit uuid; credit uuid;
BEGIN
 PERFORM freehold._actor(p_actor);
 IF p_correlation IS NULL OR p_purpose IS NULL OR length(btrim(p_purpose)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'INVALID_RESERVATION' USING ERRCODE='22023'; END IF;
 r:=freehold._claim(p_actor,'RESERVE',p_key,jsonb_build_object('accountId',p_account,'amountMinor',p_amount::text,'purpose',p_purpose,'expiresAtEpoch',extract(epoch FROM p_expires_at)));
 IF r.response_body IS NOT NULL THEN RETURN r.response_body; END IF;
 PERFORM freehold._amount(p_amount);
 IF p_expires_at IS NOT NULL AND p_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'INVALID_EXPIRY' USING ERRCODE='22023'; END IF;
 SELECT currency_code INTO currency FROM freehold.accounts WHERE id=p_account;
 SELECT c.enabled INTO enabled FROM freehold.currencies c WHERE code=currency FOR SHARE;
 PERFORM id FROM freehold.accounts WHERE id=p_account ORDER BY id FOR UPDATE;
 SELECT * INTO a FROM freehold.accounts WHERE id=p_account;
 IF NOT FOUND OR a.owner_user_id<>p_actor THEN RAISE EXCEPTION 'ACCOUNT_NOT_AUTHORIZED' USING ERRCODE='42501'; END IF;
 failure:=CASE WHEN NOT enabled THEN 'CURRENCY_DISABLED' WHEN a.status='FROZEN' THEN 'ACCOUNT_FROZEN' WHEN a.status<>'ACTIVE' THEN 'ACCOUNT_CLOSED'
  WHEN a.available_minor<p_amount THEN 'INSUFFICIENT_FUNDS'
  WHEN a.reserved_minor::numeric+p_amount::numeric>9223372036854775807::numeric THEN 'BALANCE_LIMIT' END;
 IF failure IS NOT NULL THEN RETURN freehold._finish(r.operation_id,r.operation_id,p_correlation,jsonb_build_object('state','REJECTED','error',failure),422); END IF;
 INSERT INTO freehold.holds(id,account_id,currency_code,amount_minor,purpose,expires_at,creation_operation_id)
 VALUES(hold,p_account,currency,p_amount,p_purpose,p_expires_at,r.operation_id);
 SELECT id INTO STRICT debit FROM freehold.ledger_accounts WHERE customer_account_id=p_account AND bucket='AVAILABLE';
 SELECT id INTO STRICT credit FROM freehold.ledger_accounts WHERE customer_account_id=p_account AND bucket='RESERVED';
 journal:=freehold._post_pair(r.operation_id,p_actor,'RESERVE',p_correlation,debit,credit,p_amount,NULL,hold);
 RETURN freehold._finish(r.operation_id,hold,p_correlation,jsonb_build_object('holdId',hold,'journalId',journal,'state','COMPLETED','amountMinor',p_amount::text));
END $$;

CREATE FUNCTION freehold.release_hold(p_actor uuid,p_hold uuid,p_key text,p_correlation uuid DEFAULT gen_random_uuid())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
DECLARE r freehold.idempotency_requests; a freehold.accounts; h freehold.holds; account uuid; journal uuid; debit uuid; credit uuid;
BEGIN
 PERFORM freehold._actor(p_actor);
 IF p_correlation IS NULL THEN RAISE EXCEPTION 'INVALID_CORRELATION' USING ERRCODE='22023'; END IF;
 r:=freehold._claim(p_actor,'RELEASE',p_key,jsonb_build_object('holdId',p_hold));
 IF r.response_body IS NOT NULL THEN RETURN r.response_body; END IF;
 SELECT account_id INTO account FROM freehold.holds WHERE id=p_hold;
 -- Always account before hold, including expiry workers using this same API.
 PERFORM id FROM freehold.accounts WHERE id=account ORDER BY id FOR UPDATE;
 SELECT * INTO a FROM freehold.accounts WHERE id=account;
 IF NOT FOUND OR a.owner_user_id<>p_actor THEN RAISE EXCEPTION 'HOLD_NOT_AUTHORIZED' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT h FROM freehold.holds WHERE id=p_hold FOR UPDATE;
 IF h.state<>'ACTIVE' THEN RETURN freehold._finish(r.operation_id,h.id,p_correlation,jsonb_build_object('holdId',h.id,'state','REJECTED','error','HOLD_ALREADY_RELEASED'),422); END IF;
 IF a.available_minor::numeric+h.amount_minor::numeric>9223372036854775807::numeric THEN
  RETURN freehold._finish(r.operation_id,h.id,p_correlation,jsonb_build_object('holdId',h.id,'state','REJECTED','error','BALANCE_LIMIT'),422);
 END IF;
 -- Releasing a hold is allowed while frozen: it restores spendability without
 -- transferring ownership. Subsequent outgoing transfers remain blocked.
 UPDATE freehold.holds SET state='RELEASED',release_operation_id=r.operation_id,released_at=clock_timestamp() WHERE id=h.id;
 SELECT id INTO STRICT debit FROM freehold.ledger_accounts WHERE customer_account_id=account AND bucket='RESERVED';
 SELECT id INTO STRICT credit FROM freehold.ledger_accounts WHERE customer_account_id=account AND bucket='AVAILABLE';
 journal:=freehold._post_pair(r.operation_id,p_actor,'RELEASE',p_correlation,debit,credit,h.amount_minor,NULL,h.id);
 RETURN freehold._finish(r.operation_id,h.id,p_correlation,jsonb_build_object('holdId',h.id,'journalId',journal,'state','COMPLETED','amountMinor',h.amount_minor::text));
END $$;
COMMENT ON COLUMN freehold.holds.expires_at IS 'Advisory scheduling deadline only. Expiry must call release_hold; time passing never silently mutates balances.';

CREATE FUNCTION freehold.sandbox_fund_account(p_actor uuid,p_account uuid,p_amount bigint,p_key text,p_reason text,p_correlation uuid DEFAULT gen_random_uuid())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
DECLARE r freehold.idempotency_requests; a freehold.accounts; currency text; enabled boolean; sandbox boolean;
 failure text; journal uuid; debit uuid; credit uuid;
BEGIN
 PERFORM freehold._actor(p_actor,true);
 IF p_correlation IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'ADMIN_REASON_REQUIRED' USING ERRCODE='22023'; END IF;
 r:=freehold._claim(p_actor,'SANDBOX_FUND',p_key,jsonb_build_object('accountId',p_account,'amountMinor',p_amount::text,'reason',p_reason));
 IF r.response_body IS NOT NULL THEN RETURN r.response_body; END IF;
 PERFORM freehold._amount(p_amount);
 SELECT sandbox_enabled INTO sandbox FROM freehold.ledger_settings WHERE singleton FOR SHARE;
 IF NOT sandbox THEN RETURN freehold._finish(r.operation_id,p_account,p_correlation,jsonb_build_object('state','REJECTED','error','SANDBOX_DISABLED'),422); END IF;
 SELECT currency_code INTO currency FROM freehold.accounts WHERE id=p_account;
 SELECT c.enabled INTO enabled FROM freehold.currencies c WHERE code=currency FOR SHARE;
 PERFORM id FROM freehold.accounts WHERE id=p_account ORDER BY id FOR UPDATE;
 SELECT * INTO a FROM freehold.accounts WHERE id=p_account;
 IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_ACCOUNT' USING ERRCODE='22023'; END IF;
 failure:=CASE WHEN NOT enabled THEN 'CURRENCY_DISABLED' WHEN a.status<>'ACTIVE' THEN 'ACCOUNT_NOT_ACTIVE'
  WHEN a.available_minor::numeric+p_amount::numeric>9223372036854775807::numeric THEN 'BALANCE_LIMIT' END;
 IF failure IS NOT NULL THEN RETURN freehold._finish(r.operation_id,p_account,p_correlation,jsonb_build_object('state','REJECTED','error',failure),422); END IF;
 INSERT INTO freehold.ledger_accounts(currency_code,bucket,accounting_class,normal_side)
 VALUES(currency,'SANDBOX_EQUITY','EQUITY','CREDIT') ON CONFLICT DO NOTHING;
 SELECT id INTO STRICT debit FROM freehold.ledger_accounts WHERE currency_code=currency AND bucket='SANDBOX_EQUITY' AND customer_account_id IS NULL;
 SELECT id INTO STRICT credit FROM freehold.ledger_accounts WHERE customer_account_id=p_account AND bucket='AVAILABLE';
 journal:=freehold._post_pair(r.operation_id,p_actor,'SANDBOX_FUND',p_correlation,debit,credit,p_amount);
 INSERT INTO freehold.admin_actions(actor_user_id,action_type,target_id,operation_id,reason,correlation_id,before_state,after_state)
 VALUES(p_actor,'SANDBOX_FUND',p_account,r.operation_id,p_reason,p_correlation,to_jsonb(a),jsonb_build_object('available_minor',a.available_minor+p_amount,'sandbox',true));
 RETURN freehold._finish(r.operation_id,p_account,p_correlation,jsonb_build_object('journalId',journal,'state','COMPLETED','sandbox',true,'amountMinor',p_amount::text));
END $$;
COMMENT ON FUNCTION freehold.sandbox_fund_account(uuid,uuid,bigint,text,text,uuid) IS 'SANDBOX ONLY: debit institutional equity, credit customer liability. No external asset receipt or custody is implied.';

-- Minimal supporting APIs keep runtime writes off accounts and admin/audit tables.
CREATE FUNCTION freehold.create_account(p_actor uuid,p_currency text,p_key text,p_correlation uuid DEFAULT gen_random_uuid()) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
DECLARE r freehold.idempotency_requests; account uuid; enabled boolean;
BEGIN
 PERFORM freehold._actor(p_actor);
 IF p_correlation IS NULL OR p_currency IS NULL THEN RAISE EXCEPTION 'INVALID_ACCOUNT_REQUEST' USING ERRCODE='22023'; END IF;
 r:=freehold._claim(p_actor,'CREATE_ACCOUNT',p_key,jsonb_build_object('currency',p_currency));
 IF r.response_body IS NOT NULL THEN RETURN r.response_body; END IF;
 SELECT c.enabled INTO enabled FROM freehold.currencies c WHERE code=p_currency FOR SHARE;
 IF NOT FOUND OR NOT enabled THEN RAISE EXCEPTION 'CURRENCY_UNAVAILABLE' USING ERRCODE='22023'; END IF;
 INSERT INTO freehold.accounts(owner_user_id,currency_code) VALUES(p_actor,p_currency) ON CONFLICT (owner_user_id,currency_code) DO NOTHING;
 SELECT id INTO STRICT account FROM freehold.accounts WHERE owner_user_id=p_actor AND currency_code=p_currency;
 RETURN freehold._finish(r.operation_id,account,p_correlation,jsonb_build_object('accountId',account,'currency',p_currency,'state','COMPLETED'));
END $$;
CREATE FUNCTION freehold.set_account_frozen(p_actor uuid,p_account uuid,p_frozen boolean,p_key text,p_reason text,p_correlation uuid DEFAULT gen_random_uuid()) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freehold,pg_temp SET lock_timeout='5s' AS $$
DECLARE r freehold.idempotency_requests; a freehold.accounts; action text;
BEGIN
 PERFORM freehold._actor(p_actor,true);
 IF p_correlation IS NULL OR p_frozen IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'ADMIN_REASON_REQUIRED' USING ERRCODE='22023'; END IF;
 action:=CASE WHEN p_frozen THEN 'FREEZE' ELSE 'UNFREEZE' END;
 r:=freehold._claim(p_actor,action,p_key,jsonb_build_object('accountId',p_account,'reason',p_reason));
 IF r.response_body IS NOT NULL THEN RETURN r.response_body; END IF;
 PERFORM id FROM freehold.accounts WHERE id=p_account ORDER BY id FOR UPDATE;
 SELECT * INTO a FROM freehold.accounts WHERE id=p_account;
 IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_ACCOUNT' USING ERRCODE='22023'; END IF;
 IF a.status='CLOSED' THEN RETURN freehold._finish(r.operation_id,p_account,p_correlation,jsonb_build_object('state','REJECTED','error','ACCOUNT_CLOSED'),422); END IF;
 UPDATE freehold.accounts SET status=CASE WHEN p_frozen THEN 'FROZEN' ELSE 'ACTIVE' END WHERE id=p_account;
 INSERT INTO freehold.admin_actions(actor_user_id,action_type,target_id,operation_id,reason,correlation_id,before_state,after_state)
 VALUES(p_actor,action,p_account,r.operation_id,p_reason,p_correlation,jsonb_build_object('status',a.status),jsonb_build_object('status',CASE WHEN p_frozen THEN 'FROZEN' ELSE 'ACTIVE' END));
 RETURN freehold._finish(r.operation_id,p_account,p_correlation,jsonb_build_object('accountId',p_account,'state','COMPLETED','frozen',p_frozen));
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA freehold FROM PUBLIC,freehold_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA freehold FROM PUBLIC,freehold_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA freehold FROM PUBLIC,freehold_app;
GRANT USAGE ON SCHEMA freehold TO freehold_app;
-- Service role reads are institution-wide; the API must scope responses by owner.
-- No password/2FA secrets or private seals/settings are granted to this role.
GRANT SELECT ON freehold.currencies,freehold.accounts,freehold.ledger_accounts,
 freehold.ledger_journals,freehold.ledger_entries,freehold.transfers,freehold.holds,
 freehold.idempotency_requests,freehold.admin_actions,freehold.audit_log,freehold.outbox_events TO freehold_app;
GRANT EXECUTE ON FUNCTION freehold.execute_internal_transfer(uuid,uuid,uuid,text,bigint,text,uuid),
 freehold.reserve_funds(uuid,uuid,bigint,text,text,timestamptz,uuid),
 freehold.release_hold(uuid,uuid,text,uuid),
 freehold.sandbox_fund_account(uuid,uuid,bigint,text,text,uuid),
 freehold.create_account(uuid,text,text,uuid),
 freehold.set_account_frozen(uuid,uuid,boolean,text,text,uuid) TO freehold_app;
-- Authentication provisioning and outbox acknowledgement roles are deliberately
-- absent. Add narrowly scoped functions in later migrations, never table DML grants.
RESET ROLE;
COMMIT;
