import { createHash, randomUUID, verify as verifyEd25519 } from 'node:crypto';

export const LEDGER_VERIFIER_VERSION = '1.7.0';
const VERSION = LEDGER_VERIFIER_VERSION;
const MAX_EVIDENCE = 2000;
const MAX_REFERENCE_ROWS = 100000;

const key = value => String(value);
const obj = value => value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) ? value : {};
const instant = value => value instanceof Date ? value.getTime() : Date.parse(value);
const stableJson = value => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
};
const countValue = value => {
  const n = BigInt(value);
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString();
};

const PRIVILEGE_SQL = `
      WITH role_info AS (
        SELECT r.oid,r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,r.rolinherit
        FROM pg_roles r WHERE r.rolname=current_user
      ), full_read_tables(name) AS (SELECT unnest(ARRAY[
        'currencies','accounts','ledger_accounts','ledger_journals','ledger_entries','journal_seals','idempotency_requests','transfers','holds','outbox_events','worker_inbox',
        'legal_entities','monetary_products','monetary_books','monetary_supply','monetary_holders','monetary_journals','monetary_entries','monetary_audit',
        'reserve_assets','issuer_capital','monetary_capabilities','issuance_operations','redemption_operations','settlement_evidence','bank_accounts','bank_events',
        'monetary_cap_requests','cross_entity_obligations','chain_observations','monetary_signing_posts','regulatory_reports','monetary_compliance_profiles',
        'monetary_screenings','monetary_restrictions','regulator_requests','product_disclosures','supply_corrections','monetary_alerts','conversion_requests',
        'institutions','institution_members','institution_credentials','institution_customers',
        'institution_ledger_accounts','institution_journals','institution_entries','institution_payments',
        'institution_provider_events','institution_outbox','institution_webhook_endpoints',
        'institution_webhook_subscriptions','institution_webhook_events','institution_webhook_deliveries',
        'institution_disputes','institution_dispute_notes','institution_adjustments','institution_policies',
        'institution_risk_runs','institution_price_plans','institution_usage_records','institution_invoices',
        'institution_invoice_lines','institution_compliance_cases','institution_audit','institution_nonces',
        'institution_rate_buckets','institution_issuance_links',
        'network_rulebooks','network_rulebook_acceptances','network_members','network_member_audit',
        'network_certificates','network_nonces','network_payments','network_obligations','network_cycles',
        'network_cycle_positions','network_settlement_instructions','network_messages','network_risk_runs','network_outbox',
        'program_controls','program_policies','program_workflows','program_approvals','program_executions','program_legs',
        'program_escrows','program_treasury','program_assets','program_asset_positions','program_asset_journals',
        'program_exchange_members','program_quotes','program_trades','program_collateral','program_issuance_requests','program_audit'
      ]::text[])),
      partial_read_columns(name) AS (SELECT unnest(ARRAY[
        'users.id','users.status','users.role',
        'admin_actions.operation_id','admin_actions.actor_user_id','admin_actions.action_type','admin_actions.target_id','admin_actions.correlation_id',
        'audit_log.id','audit_log.event_type','audit_log.resource_id','audit_log.operation_id','audit_log.outcome','audit_log.correlation_id','audit_log.actor_id',
        'governance_requests.id','governance_requests.initiator_id','governance_requests.operation','governance_requests.parameters','governance_requests.payload_hash','governance_requests.required_capability','governance_requests.status','governance_requests.created_at','governance_requests.expires_at','governance_requests.decided_at','governance_requests.executed_at','governance_requests.executor_id','governance_requests.result','governance_requests.operation_id',
        'governance_capabilities.principal_id','governance_capabilities.capability','governance_capabilities.granted_at','governance_capabilities.revoked_at',
        'governance_capability_history.id','governance_capability_history.principal_id','governance_capability_history.capability','governance_capability_history.event','governance_capability_history.changed_at',
        'governance_decisions.request_id','governance_decisions.principal_id','governance_decisions.capability','governance_decisions.decision','governance_decisions.decided_at',
        'governance_approval_requirements.request_id','governance_approval_requirements.capability','governance_approval_requirements.required_count',
        'governance_audit.request_id','governance_audit.event_type','governance_audit.requesting_principal','governance_audit.approving_principal','governance_audit.executing_principal','governance_audit.affected_resource','governance_audit.outcome','governance_audit.recorded_at',
        'institutional_control.singleton','institutional_control.writes_suspended','institutional_control.suspended_by','institutional_control.suspended_at','institutional_control.resumed_at',
        'risk_policies.id','risk_policies.scope','risk_policies.account_id','risk_policies.currency_code','risk_policies.rule_code','risk_policies.threshold_minor','risk_policies.threshold_count','risk_policies.window_seconds','risk_policies.size_multiple','risk_policies.timezone','risk_policies.enabled','risk_policies.governance_request_id',
        'risk_policy_changes.id','risk_policy_changes.policy_id','risk_policy_changes.governance_request_id','risk_policy_changes.parameters','risk_policy_changes.recorded_at',
        'gl_accounts.id','gl_accounts.code','gl_accounts.classification','gl_accounts.currency_code','gl_accounts.posting_enabled',
        'scheduled_transfers.id','scheduled_transfers.status','scheduled_transfers.source_account_id','scheduled_transfers.destination_account_id','scheduled_transfers.currency_code','scheduled_transfers.amount_minor',
        'scheduled_transfer_executions.id','scheduled_transfer_executions.instruction_id','scheduled_transfer_executions.operation_id','scheduled_transfer_executions.outcome'
      ]::text[])),
      actual_partial AS (
        SELECT c.relname||'.'||a.attname AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
        WHERE n.nspname='freehold' AND a.attnum>0 AND NOT a.attisdropped
          AND has_column_privilege(current_user,c.oid,a.attnum,'SELECT')
          AND NOT has_table_privilege(current_user,c.oid,'SELECT')
      ),
      table_rights AS (
        SELECT c.relname,has_table_privilege(current_user,c.oid,'SELECT') AS can_read,
          (has_table_privilege(current_user,c.oid,'INSERT') OR has_table_privilege(current_user,c.oid,'UPDATE') OR
           has_table_privilege(current_user,c.oid,'DELETE') OR has_table_privilege(current_user,c.oid,'TRUNCATE') OR
           has_table_privilege(current_user,c.oid,'REFERENCES') OR has_table_privilege(current_user,c.oid,'TRIGGER')) AS can_write
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='freehold' AND c.relkind IN ('r','p','v','m','f')
      )
      SELECT
        (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit
          AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=oid) FROM role_info) AS safe_role,
        NOT has_schema_privilege(current_user,'freehold','CREATE') AND has_schema_privilege(current_user,'freehold','USAGE') AS safe_schema,
        NOT EXISTS(SELECT 1 FROM table_rights WHERE can_write) AS no_table_writes,
        NOT EXISTS(SELECT 1 FROM table_rights WHERE can_read AND relname NOT IN (SELECT name FROM full_read_tables)) AS no_extra_table_reads,
        NOT EXISTS(SELECT 1 FROM full_read_tables e WHERE NOT EXISTS(SELECT 1 FROM table_rights t WHERE t.relname=e.name AND t.can_read)) AS required_table_reads,
        NOT EXISTS(SELECT 1 FROM actual_partial a WHERE NOT EXISTS(SELECT 1 FROM partial_read_columns p WHERE p.name=a.name)) AND
          NOT EXISTS(SELECT 1 FROM partial_read_columns p WHERE NOT EXISTS(SELECT 1 FROM actual_partial a WHERE a.name=p.name)) AS exact_partial_reads,
        NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='freehold' AND c.relkind='S'
          AND (has_sequence_privilege(current_user,c.oid,'USAGE') OR has_sequence_privilege(current_user,c.oid,'SELECT') OR has_sequence_privilege(current_user,c.oid,'UPDATE'))) AS no_sequence_access,
        NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='freehold' AND has_function_privilege(current_user,p.oid,'EXECUTE')) AS no_function_execution,
        has_schema_privilege(current_user,'freehold_deploy','USAGE') AND has_table_privilege(current_user,'freehold_deploy.migrations','SELECT') AND
          NOT (has_table_privilege(current_user,'freehold_deploy.migrations','INSERT') OR has_table_privilege(current_user,'freehold_deploy.migrations','UPDATE') OR has_table_privilege(current_user,'freehold_deploy.migrations','DELETE')) AS migration_metadata_read_only
`;

function stop(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Independent verification. Large ledger tables are aggregated inside the
 * repeatable-read snapshot. The process retains violation samples and small
 * governance reference sets, not full journals, entries, transfers, or outbox payloads.
 * It does not call worker_reconcile, institutional_report, monetary functions, or institution functions.
 */
export async function verifyLedger(client, { statementTimeoutMs = 300000, afterSnapshot, onProgress, shouldCancel, signal, maxRssBytes } = {}) {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const report = {
    reportType: 'freehold.independent-ledger-verification',
    verificationRunId: runId,
    algorithmVersion: VERSION,
    startedAt,
    completedAt: null,
    database: null,
    schemaMigrationVersion: null,
    snapshot: { isolation: 'REPEATABLE READ', readOnly: true, startsAt: null },
    counts: { accounts: 0, journalEntries: 0, operations: 0, journals: 0, governanceRequests: 0 },
    perCurrencyTotals: [],
    projectionDiscrepancies: [],
    referentialIntegrityViolations: [],
    idempotencyInconsistencies: [],
    accountingViolations: [],
    operationalEventViolations: [],
    governanceViolations: [],
    outcome: 'INCOMPLETE',
    accountingOutcome: 'INCOMPLETE',
    externalReserveOutcome: 'NOT_REQUIRED',
    monetary: null,
    institution: null,
    network: null,
    program: null,
    evidenceTruncated: false,
    scan: { mode: 'server-aggregate', entriesVisited: '0', expectedEntries: null, complete: false },
    resources: { rssBytesStart: process.memoryUsage().rss, rssBytesPeak: 0, heapUsedPeak: 0 },
  };
  const checks = [report.projectionDiscrepancies, report.referentialIntegrityViolations,
    report.idempotencyInconsistencies, report.accountingViolations, report.operationalEventViolations, report.governanceViolations];
  let totalEvidence = 0;
  let incomplete = false;
  let phase = 0;
  const phases = [];
  const issue = (target, code, evidence) => {
    totalEvidence++;
    if (totalEvidence <= MAX_EVIDENCE) target.push({ ...evidence, code });
    else report.evidenceTruncated = true;
  };
  const noteMemory = () => {
    const usage = process.memoryUsage();
    report.resources.rssBytesPeak = Math.max(report.resources.rssBytesPeak, usage.rss);
    report.resources.heapUsedPeak = Math.max(report.resources.heapUsedPeak, usage.heapUsed);
    if (maxRssBytes && usage.rss > maxRssBytes) throw stop('RESOURCE_LIMIT', 'Verification exceeded the configured process RSS limit.');
  };
  const cancelled = () => Boolean(signal?.aborted || shouldCancel?.());
  const guard = () => {
    if (cancelled()) throw stop('CANCELLED', 'Verification was cancelled before every check finished.');
    noteMemory();
  };
  const collect = async (target, code, sql) => {
    guard();
    phase += 1;
    phases.push(code);
    onProgress?.({ phase: code, index: phase, algorithmVersion: VERSION });
    const result = await client.query(`${sql} LIMIT ${MAX_EVIDENCE + 1}`);
    noteMemory();
    for (const row of result.rows) issue(target, code, row);
  };

  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1000, Math.min(900000, Number(statementTimeoutMs) || 300000))}`);
    const identity = await client.query(`SELECT current_database() AS database, current_user AS role,
      version() AS server_version, pg_is_in_recovery() AS is_replica,
      clock_timestamp() AS snapshot_started_at`);
    report.database = identity.rows[0];
    if (identity.rows[0].role !== 'freehold_verifier') throw new Error('Verification requires the freehold_verifier database role.');
    report.snapshot.startsAt = identity.rows[0].snapshot_started_at;
    if (identity.rows[0].is_replica) {
      incomplete = true;
      issue(report.referentialIntegrityViolations, 'REPLICA_SOURCE_NOT_CERTIFIED', { evidence: 'The connection is on a standby; replay position and required freshness were not certified.' });
    }
    if (afterSnapshot) await afterSnapshot(identity.rows[0]);
    guard();

    const privileges = await client.query(PRIVILEGE_SQL);
    if (!Object.values(privileges.rows[0]).every(Boolean)) throw new Error('Verifier database grants do not match the reviewed read-only allowlist.');
    const migrationTable = await client.query("SELECT to_regclass('freehold_deploy.migrations') IS NOT NULL AS present");
    if (migrationTable.rows[0].present) {
      const version = await client.query('SELECT name FROM freehold_deploy.migrations ORDER BY name DESC LIMIT 1');
      report.schemaMigrationVersion = version.rows[0]?.name ?? null;
    }
    if (!report.schemaMigrationVersion) {
      incomplete = true;
      issue(report.referentialIntegrityViolations, 'SCHEMA_VERSION_UNAVAILABLE', { evidence: 'Migration metadata was absent or empty in the snapshot.' });
    }

    const counts = await client.query(`SELECT
      (SELECT count(*) FROM freehold.accounts) AS accounts,
      (SELECT count(*) FROM freehold.idempotency_requests) AS operations,
      (SELECT count(*) FROM freehold.ledger_journals) AS journals,
      (SELECT count(*) FROM freehold.ledger_entries) AS entries,
      (SELECT count(*) FROM freehold.governance_requests) AS governance`);
    const counted = counts.rows[0];
    report.counts.accounts = countValue(counted.accounts);
    report.counts.operations = countValue(counted.operations);
    report.counts.journals = countValue(counted.journals);
    report.counts.journalEntries = countValue(counted.entries);
    report.counts.governanceRequests = countValue(counted.governance);
    const entryCount = BigInt(counted.entries);
    const grouped = await client.query('SELECT coalesce(sum(n),0)::text AS visited FROM (SELECT count(*) AS n FROM freehold.ledger_entries GROUP BY journal_id) s');
    const visited = BigInt(grouped.rows[0].visited);
    report.scan = { mode: 'server-aggregate', entriesVisited: visited.toString(), expectedEntries: entryCount.toString(), complete: visited === entryCount, processRetainedEntryRows: 0 };
    if (visited !== entryCount) {
      incomplete = true;
      issue(report.referentialIntegrityViolations, 'ENTRY_SCAN_COUNT_MISMATCH', { visited: visited.toString(), expected: entryCount.toString() });
    }

    const totals = await client.query(`SELECT c.code AS currency, c.minor_unit_exponent AS "minorUnitExponent",
      coalesce(sum(e.amount_minor) FILTER (WHERE e.side='DEBIT'),0)::text AS "debitsMinor",
      coalesce(sum(e.amount_minor) FILTER (WHERE e.side='CREDIT'),0)::text AS "creditsMinor"
      FROM freehold.currencies c LEFT JOIN freehold.ledger_entries e ON e.currency_code=c.code
      GROUP BY c.code, c.minor_unit_exponent ORDER BY c.code`);
    report.perCurrencyTotals = totals.rows.map(row => {
      const debits = BigInt(row.debitsMinor);
      const credits = BigInt(row.creditsMinor);
      return { ...row, differenceMinor: (debits - credits).toString(), balanced: debits === credits };
    });
    for (const item of report.perCurrencyTotals) if (!item.balanced)
      issue(report.accountingViolations, 'CURRENCY_TOTALS_UNBALANCED', { currency: item.currency, debitsMinor: item.debitsMinor, creditsMinor: item.creditsMinor });

    await collect(report.accountingViolations, 'INVALID_CURRENCY_PRECISION', `SELECT code AS currency, minor_unit_exponent AS exponent FROM freehold.currencies WHERE minor_unit_exponent < 0 OR minor_unit_exponent > 18`);
    await collect(report.referentialIntegrityViolations, 'LEDGER_ACCOUNT_UNKNOWN_CURRENCY', `SELECT la.id AS "ledgerAccountId", la.currency_code AS currency FROM freehold.ledger_accounts la WHERE NOT EXISTS (SELECT 1 FROM freehold.currencies c WHERE c.code=la.currency_code)`);
    await collect(report.referentialIntegrityViolations, 'LEDGER_ACCOUNT_ORPHAN_ACCOUNT', `SELECT la.id AS "ledgerAccountId", la.customer_account_id AS "accountId" FROM freehold.ledger_accounts la WHERE la.customer_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM freehold.accounts a WHERE a.id=la.customer_account_id)`);
    await collect(report.accountingViolations, 'LEDGER_ACCOUNT_CURRENCY_MISMATCH', `SELECT la.id AS "ledgerAccountId", la.customer_account_id AS "accountId", la.currency_code AS "ledgerCurrency", a.currency_code AS "accountCurrency" FROM freehold.ledger_accounts la JOIN freehold.accounts a ON a.id=la.customer_account_id WHERE a.currency_code<>la.currency_code`);
    await collect(report.accountingViolations, 'INVALID_CUSTOMER_LEDGER_ACCOUNT', `SELECT id AS "ledgerAccountId", customer_account_id AS "accountId", bucket, accounting_class AS "accountingClass", normal_side AS "normalSide" FROM freehold.ledger_accounts WHERE customer_account_id IS NOT NULL AND (accounting_class<>'LIABILITY' OR normal_side<>'CREDIT' OR bucket NOT IN ('AVAILABLE','RESERVED'))`);
    await collect(report.accountingViolations, 'INVALID_EQUITY_LEDGER_ACCOUNT', `SELECT id AS "ledgerAccountId", bucket, accounting_class AS "accountingClass", normal_side AS "normalSide" FROM freehold.ledger_accounts WHERE customer_account_id IS NULL AND (bucket<>'SANDBOX_EQUITY' OR accounting_class<>'EQUITY' OR normal_side<>'CREDIT')`);
    await collect(report.accountingViolations, 'ACCOUNT_BUCKET_SET_INVALID', `SELECT a.id AS "accountId", count(la.id)::int AS "ledgerAccountCount" FROM freehold.accounts a LEFT JOIN freehold.ledger_accounts la ON la.customer_account_id=a.id GROUP BY a.id HAVING count(la.id)<>2 OR count(DISTINCT la.bucket) FILTER (WHERE la.bucket IN ('AVAILABLE','RESERVED'))<>2`);
    await collect(report.accountingViolations, 'CLOSED_ACCOUNT_HAS_BALANCE', `SELECT id AS "accountId" FROM freehold.accounts WHERE status='CLOSED' AND (available_minor<>0 OR reserved_minor<>0)`);
    await collect(report.accountingViolations, 'ENTRY_AMOUNT_NOT_POSITIVE', `SELECT id AS "entryId", amount_minor::text AS "amountMinor" FROM freehold.ledger_entries WHERE amount_minor<=0`);
    await collect(report.referentialIntegrityViolations, 'ENTRY_ORPHAN_JOURNAL', `SELECT e.id AS "entryId", e.journal_id AS "journalId" FROM freehold.ledger_entries e WHERE NOT EXISTS (SELECT 1 FROM freehold.ledger_journals j WHERE j.id=e.journal_id)`);
    await collect(report.referentialIntegrityViolations, 'ENTRY_ORPHAN_LEDGER_ACCOUNT', `SELECT e.id AS "entryId", e.ledger_account_id AS "ledgerAccountId" FROM freehold.ledger_entries e WHERE NOT EXISTS (SELECT 1 FROM freehold.ledger_accounts la WHERE la.id=e.ledger_account_id)`);
    await collect(report.accountingViolations, 'ENTRY_LEDGER_CURRENCY_MISMATCH', `SELECT e.id AS "entryId", la.id AS "ledgerAccountId", e.currency_code AS "entryCurrency", la.currency_code AS "ledgerCurrency" FROM freehold.ledger_entries e JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id WHERE la.currency_code<>e.currency_code`);
    await collect(report.referentialIntegrityViolations, 'ENTRY_UNKNOWN_CURRENCY', `SELECT id AS "entryId", currency_code AS currency FROM freehold.ledger_entries e WHERE NOT EXISTS (SELECT 1 FROM freehold.currencies c WHERE c.code=e.currency_code)`);
    await collect(report.accountingViolations, 'ENTRY_INVALID_SIDE', `SELECT id AS "entryId", side FROM freehold.ledger_entries WHERE side NOT IN ('DEBIT','CREDIT')`);
    await collect(report.referentialIntegrityViolations, 'JOURNAL_ORPHAN_OPERATION', `SELECT j.id AS "journalId", j.operation_id AS "operationId" FROM freehold.ledger_journals j WHERE NOT EXISTS (SELECT 1 FROM freehold.idempotency_requests r WHERE r.operation_id=j.operation_id)`);
    await collect(report.accountingViolations, 'JOURNAL_NOT_SEALED', `SELECT j.id AS "journalId" FROM freehold.ledger_journals j WHERE NOT EXISTS (SELECT 1 FROM freehold.journal_seals s WHERE s.journal_id=j.id)`);
    await collect(report.accountingViolations, 'JOURNAL_LINE_COUNT_INVALID', `SELECT j.id AS "journalId", count(e.id)::int AS "lineCount" FROM freehold.ledger_journals j LEFT JOIN freehold.ledger_entries e ON e.journal_id=j.id GROUP BY j.id HAVING count(e.id)<>2 OR count(e.id) FILTER (WHERE e.line_no=1)<>1 OR count(e.id) FILTER (WHERE e.line_no=2)<>1`);
    await collect(report.accountingViolations, 'JOURNAL_CURRENCY_COUNT_INVALID', `SELECT j.id AS "journalId", count(DISTINCT e.currency_code)::int AS currencies FROM freehold.ledger_journals j JOIN freehold.ledger_entries e ON e.journal_id=j.id GROUP BY j.id HAVING count(DISTINCT e.currency_code)<>1`);
    await collect(report.accountingViolations, 'JOURNAL_UNBALANCED', `SELECT j.id AS "journalId", j.operation_id AS "operationId", coalesce(sum(e.amount_minor) FILTER (WHERE e.side='DEBIT'),0)::text AS "debitsMinor", coalesce(sum(e.amount_minor) FILTER (WHERE e.side='CREDIT'),0)::text AS "creditsMinor" FROM freehold.ledger_journals j LEFT JOIN freehold.ledger_entries e ON e.journal_id=j.id GROUP BY j.id, j.operation_id HAVING coalesce(sum(e.amount_minor) FILTER (WHERE e.side='DEBIT'),0)<>coalesce(sum(e.amount_minor) FILTER (WHERE e.side='CREDIT'),0)`);
    await collect(report.accountingViolations, 'JOURNAL_SIDES_INVALID', `SELECT j.id AS "journalId", count(e.id) FILTER (WHERE e.side='DEBIT')::int AS "debitLines", count(e.id) FILTER (WHERE e.side='CREDIT')::int AS "creditLines" FROM freehold.ledger_journals j LEFT JOIN freehold.ledger_entries e ON e.journal_id=j.id GROUP BY j.id HAVING count(e.id) FILTER (WHERE e.side='DEBIT')<>1 OR count(e.id) FILTER (WHERE e.side='CREDIT')<>1`);
    await collect(report.referentialIntegrityViolations, 'JOURNAL_IDEMPOTENCY_LINK_INVALID', `SELECT j.id AS "journalId", j.operation_id AS "operationId" FROM freehold.ledger_journals j JOIN freehold.idempotency_requests r ON r.operation_id=j.operation_id WHERE r.actor_id IS DISTINCT FROM j.created_by OR r.response_body->>'state' IS DISTINCT FROM 'COMPLETED' OR r.response_body->>'journalId' IS DISTINCT FROM j.id::text OR r.response_body->>'correlationId' IS DISTINCT FROM j.correlation_id::text`);
    await collect(report.accountingViolations, 'OPERATION_HAS_MULTIPLE_JOURNALS', `SELECT operation_id AS "operationId", count(*)::int AS "journalCount" FROM freehold.ledger_journals GROUP BY operation_id HAVING count(*)>1`);
    await collect(report.accountingViolations, 'UNKNOWN_JOURNAL_KIND', `SELECT id AS "journalId", kind FROM freehold.ledger_journals WHERE kind NOT IN ('INTERNAL_TRANSFER','RESERVE','RELEASE','SANDBOX_FUND')`);
    await collect(report.accountingViolations, 'TRANSFER_JOURNAL_LINK_INVALID', `SELECT j.id AS "journalId", j.transfer_id AS "transferId", j.operation_id AS "operationId" FROM freehold.ledger_journals j LEFT JOIN freehold.transfers t ON t.id=j.transfer_id LEFT JOIN freehold.idempotency_requests r ON r.operation_id=j.operation_id WHERE j.kind='INTERNAL_TRANSFER' AND (t.id IS NULL OR t.operation_id IS DISTINCT FROM j.operation_id OR t.state<>'COMPLETED' OR r.operation IS DISTINCT FROM 'TRANSFER' OR t.initiator_user_id IS DISTINCT FROM j.created_by)`);
    await collect(report.accountingViolations, 'TRANSFER_POSTING_TEMPLATE_INVALID', `SELECT j.id AS "journalId", t.id AS "transferId", t.source_account_id AS "sourceAccountId", t.destination_account_id AS "destinationAccountId" FROM freehold.ledger_journals j JOIN freehold.transfers t ON t.id=j.transfer_id AND t.operation_id=j.operation_id AND t.state='COMPLETED' WHERE j.kind='INTERNAL_TRANSFER' AND (NOT EXISTS (SELECT 1 FROM freehold.ledger_entries e JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id WHERE e.journal_id=j.id AND e.side='DEBIT' AND e.amount_minor=t.amount_minor AND e.currency_code=t.currency_code AND la.customer_account_id=t.source_account_id AND la.bucket='AVAILABLE') OR NOT EXISTS (SELECT 1 FROM freehold.ledger_entries e JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id WHERE e.journal_id=j.id AND e.side='CREDIT' AND e.amount_minor=t.amount_minor AND e.currency_code=t.currency_code AND la.customer_account_id=t.destination_account_id AND la.bucket='AVAILABLE'))`);
    await collect(report.accountingViolations, 'HOLD_JOURNAL_LINK_INVALID', `SELECT j.id AS "journalId", j.hold_id AS "holdId", j.operation_id AS "operationId" FROM freehold.ledger_journals j LEFT JOIN freehold.holds h ON h.id=j.hold_id LEFT JOIN freehold.idempotency_requests r ON r.operation_id=j.operation_id WHERE j.kind IN ('RESERVE','RELEASE') AND (h.id IS NULL OR (j.kind='RESERVE' AND (r.operation IS DISTINCT FROM 'RESERVE' OR h.creation_operation_id IS DISTINCT FROM j.operation_id)) OR (j.kind='RELEASE' AND (r.operation IS DISTINCT FROM 'RELEASE' OR h.release_operation_id IS DISTINCT FROM j.operation_id OR h.state<>'RELEASED')))`);
    await collect(report.accountingViolations, 'HOLD_JOURNAL_COUNT_INVALID', `SELECT h.id AS "holdId", h.state FROM freehold.holds h WHERE (SELECT count(*) FROM freehold.ledger_journals j WHERE j.hold_id=h.id AND j.kind='RESERVE' AND j.operation_id=h.creation_operation_id)<>1 OR (h.state='RELEASED' AND (SELECT count(*) FROM freehold.ledger_journals j WHERE j.hold_id=h.id AND j.kind='RELEASE' AND j.operation_id=h.release_operation_id)<>1) OR (h.state<>'RELEASED' AND EXISTS (SELECT 1 FROM freehold.ledger_journals j WHERE j.hold_id=h.id AND j.kind='RELEASE'))`);
    await collect(report.referentialIntegrityViolations, 'HOLD_ORPHAN_ACCOUNT', `SELECT id AS "holdId", account_id AS "accountId" FROM freehold.holds h WHERE NOT EXISTS (SELECT 1 FROM freehold.accounts a WHERE a.id=h.account_id)`);
    await collect(report.projectionDiscrepancies, 'ACCOUNT_PROJECTION_MISMATCH', `WITH sums AS (SELECT la.customer_account_id AS account_id, la.bucket, sum(CASE WHEN e.side='CREDIT' THEN e.amount_minor ELSE -e.amount_minor END) AS journal_minor FROM freehold.ledger_entries e JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id WHERE la.customer_account_id IS NOT NULL AND la.bucket IN ('AVAILABLE','RESERVED') GROUP BY la.customer_account_id, la.bucket) SELECT a.id AS "accountId", b.bucket, coalesce(s.journal_minor,0)::text AS "journalMinor", (CASE b.bucket WHEN 'AVAILABLE' THEN a.available_minor ELSE a.reserved_minor END)::text AS "projectionMinor" FROM freehold.accounts a CROSS JOIN (VALUES ('AVAILABLE'),('RESERVED')) AS b(bucket) LEFT JOIN sums s ON s.account_id=a.id AND s.bucket=b.bucket WHERE coalesce(s.journal_minor,0) IS DISTINCT FROM CASE b.bucket WHEN 'AVAILABLE' THEN a.available_minor ELSE a.reserved_minor END`);
    await collect(report.accountingViolations, 'NEGATIVE_CUSTOMER_BALANCE', `WITH sums AS (SELECT la.customer_account_id AS account_id, la.bucket, sum(CASE WHEN e.side='CREDIT' THEN e.amount_minor ELSE -e.amount_minor END) AS journal_minor FROM freehold.ledger_entries e JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id WHERE la.customer_account_id IS NOT NULL AND la.bucket IN ('AVAILABLE','RESERVED') GROUP BY la.customer_account_id, la.bucket) SELECT a.id AS "accountId", b.bucket, coalesce(s.journal_minor,0)::text AS "journalMinor", (CASE b.bucket WHEN 'AVAILABLE' THEN a.available_minor ELSE a.reserved_minor END)::text AS "projectionMinor" FROM freehold.accounts a CROSS JOIN (VALUES ('AVAILABLE'),('RESERVED')) AS b(bucket) LEFT JOIN sums s ON s.account_id=a.id AND s.bucket=b.bucket WHERE coalesce(s.journal_minor,0)<0 OR (CASE b.bucket WHEN 'AVAILABLE' THEN a.available_minor ELSE a.reserved_minor END)<0`);
    await collect(report.projectionDiscrepancies, 'ACTIVE_HOLDS_RESERVED_MISMATCH', `SELECT a.id AS "accountId", coalesce(h.amount,0)::text AS "activeHoldsMinor", a.reserved_minor::text AS "reservedProjectionMinor" FROM freehold.accounts a LEFT JOIN (SELECT account_id, sum(amount_minor) AS amount FROM freehold.holds WHERE state='ACTIVE' GROUP BY account_id) h ON h.account_id=a.id WHERE coalesce(h.amount,0) IS DISTINCT FROM a.reserved_minor`);
    await collect(report.idempotencyInconsistencies, 'IDEMPOTENCY_RESULT_INCOMPLETE', `SELECT operation_id AS "operationId", operation FROM freehold.idempotency_requests WHERE completed_at IS NULL OR response_status IS NULL OR response_body IS NULL OR response_body->>'operationId' IS DISTINCT FROM operation_id::text`);
    await collect(report.idempotencyInconsistencies, 'IDEMPOTENCY_PAYLOAD_HASH_MISMATCH', `SELECT operation_id AS "operationId", operation FROM freehold.idempotency_requests WHERE request_hash IS DISTINCT FROM sha256(convert_to(request_payload::text,'UTF8'))`);
    await collect(report.referentialIntegrityViolations, 'OPERATION_ACTOR_MISSING', `SELECT operation_id AS "operationId" FROM freehold.idempotency_requests r WHERE NOT EXISTS (SELECT 1 FROM freehold.users u WHERE u.id=r.actor_id)`);
    await collect(report.idempotencyInconsistencies, 'IDEMPOTENCY_STATUS_OUTCOME_MISMATCH', `SELECT operation_id AS "operationId", response_body->>'state' AS state, response_status AS status FROM freehold.idempotency_requests WHERE response_body->>'state' NOT IN ('COMPLETED','REJECTED') OR (response_body->>'state'='COMPLETED' AND response_status>=300) OR (response_body->>'state'='REJECTED' AND response_status<400)`);
    await collect(report.operationalEventViolations, 'OPERATION_EVENT_COUNT_INVALID', `SELECT r.operation_id AS "operationId", (SELECT count(*) FROM freehold.outbox_events e WHERE e.operation_id=r.operation_id)::int AS "outboxCount", (SELECT count(*) FROM freehold.audit_log a WHERE a.operation_id=r.operation_id)::int AS "auditCount" FROM freehold.idempotency_requests r WHERE (SELECT count(*) FROM freehold.outbox_events e WHERE e.operation_id=r.operation_id)<>1 OR (SELECT count(*) FROM freehold.audit_log a WHERE a.operation_id=r.operation_id)<>1`);
    await collect(report.operationalEventViolations, 'OUTBOX_OPERATION_LINK_INVALID', `SELECT r.operation_id AS "operationId", e.id AS "eventId" FROM freehold.idempotency_requests r JOIN freehold.outbox_events e ON e.operation_id=r.operation_id WHERE e.event_type IS DISTINCT FROM r.operation||'.'||(r.response_body->>'state') OR e.aggregate_id IS DISTINCT FROM r.resource_id OR e.payload->>'operationId' IS DISTINCT FROM r.operation_id::text OR e.payload->>'state' IS DISTINCT FROM r.response_body->>'state' OR e.payload IS DISTINCT FROM r.response_body`);
    await collect(report.operationalEventViolations, 'OUTBOX_ACK_STATE_INVALID', `SELECT e.operation_id AS "operationId", e.id AS "eventId", (e.dispatched_at IS NOT NULL) AS dispatched, i.status AS "inboxStatus" FROM freehold.outbox_events e LEFT JOIN freehold.worker_inbox i ON i.event_id=e.id WHERE (e.dispatched_at IS NOT NULL AND coalesce(i.status,'')<>'PROCESSED') OR (i.status='PROCESSED' AND e.dispatched_at IS NULL)`);
    await collect(report.operationalEventViolations, 'OUTBOX_ATTEMPT_COUNT_MISMATCH', `SELECT e.operation_id AS "operationId", e.id AS "eventId" FROM freehold.outbox_events e JOIN freehold.worker_inbox i ON i.event_id=e.id WHERE i.attempt_count IS DISTINCT FROM e.attempt_count`);
    await collect(report.operationalEventViolations, 'OUTBOX_ATTEMPT_WITHOUT_INBOX', `SELECT e.operation_id AS "operationId", e.id AS "eventId", e.attempt_count AS "attemptCount" FROM freehold.outbox_events e WHERE e.attempt_count<>0 AND NOT EXISTS (SELECT 1 FROM freehold.worker_inbox i WHERE i.event_id=e.id)`);
    await collect(report.referentialIntegrityViolations, 'RESPONSE_JOURNAL_REFERENCE_INVALID', `SELECT r.operation_id AS "operationId", r.response_body->>'journalId' AS "journalId" FROM freehold.idempotency_requests r WHERE r.response_body ? 'journalId' AND r.response_body->>'journalId' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM freehold.ledger_journals j WHERE j.operation_id=r.operation_id AND j.id::text=r.response_body->>'journalId')`);
    await collect(report.accountingViolations, 'COMPLETED_FINANCIAL_OPERATION_WITHOUT_JOURNAL', `SELECT operation_id AS "operationId", operation FROM freehold.idempotency_requests r WHERE r.response_body->>'state'='COMPLETED' AND r.operation IN ('RESERVE','RELEASE','TRANSFER','SANDBOX_FUND') AND NOT EXISTS (SELECT 1 FROM freehold.ledger_journals j WHERE j.operation_id=r.operation_id)`);
    await collect(report.accountingViolations, 'TRANSFER_REQUEST_RESULT_LINK_INVALID', `SELECT r.operation_id AS "operationId", t.id AS "transferId" FROM freehold.idempotency_requests r JOIN freehold.transfers t ON t.operation_id=r.operation_id WHERE r.operation='TRANSFER' AND (t.initiator_user_id IS DISTINCT FROM r.actor_id OR t.idempotency_key IS DISTINCT FROM r.key OR t.request_hash IS DISTINCT FROM r.request_hash OR t.correlation_id::text IS DISTINCT FROM r.response_body->>'correlationId' OR r.resource_id IS DISTINCT FROM t.id OR r.request_payload->>'sourceAccountId' IS DISTINCT FROM t.source_account_id::text OR r.request_payload->>'destinationAccountId' IS DISTINCT FROM t.destination_account_id::text OR r.request_payload->>'currency' IS DISTINCT FROM t.currency_code OR r.request_payload->>'amountMinor' IS DISTINCT FROM t.amount_minor::text OR r.response_body->>'transferId' IS DISTINCT FROM t.id::text OR r.response_body->>'state' IS DISTINCT FROM t.state OR (t.state='COMPLETED') IS DISTINCT FROM EXISTS (SELECT 1 FROM freehold.ledger_journals j WHERE j.operation_id=r.operation_id))`);
    await collect(report.accountingViolations, 'TRANSFER_WITHOUT_RECORD_INVALID', `SELECT r.operation_id AS "operationId", r.response_body->>'state' AS state FROM freehold.idempotency_requests r WHERE r.operation='TRANSFER' AND NOT EXISTS (SELECT 1 FROM freehold.transfers t WHERE t.operation_id=r.operation_id) AND NOT (r.response_body->>'state'='REJECTED' AND r.response_body->>'error'='DESTINATION_UNAVAILABLE' AND r.resource_id IS NOT DISTINCT FROM r.operation_id)`);
    await collect(report.accountingViolations, 'CREATE_ACCOUNT_RESULT_LINK_INVALID', `SELECT r.operation_id AS "operationId", r.response_body->>'accountId' AS "accountId" FROM freehold.idempotency_requests r LEFT JOIN freehold.accounts a ON a.id::text=r.response_body->>'accountId' WHERE r.operation='CREATE_ACCOUNT' AND r.response_body->>'state'='COMPLETED' AND (a.id IS NULL OR r.resource_id::text IS DISTINCT FROM r.response_body->>'accountId' OR a.currency_code IS DISTINCT FROM r.request_payload->>'currency' OR r.response_body->>'currency' IS DISTINCT FROM a.currency_code)`);
    await collect(report.accountingViolations, 'ADMIN_ACTION_RESULT_LINK_INVALID', `SELECT r.operation_id AS "operationId" FROM freehold.idempotency_requests r LEFT JOIN freehold.admin_actions a ON a.operation_id=r.operation_id WHERE r.operation IN ('FREEZE','UNFREEZE') AND r.response_body->>'state'='COMPLETED' AND (a.operation_id IS NULL OR a.action_type IS DISTINCT FROM r.operation OR a.target_id IS DISTINCT FROM r.resource_id OR r.request_payload->>'accountId' IS DISTINCT FROM r.resource_id::text OR r.response_body->>'accountId' IS DISTINCT FROM r.resource_id::text OR (r.response_body->>'frozen')::boolean IS DISTINCT FROM (r.operation='FREEZE'))`);
    await collect(report.accountingViolations, 'SANDBOX_FUND_ACTION_MISSING', `SELECT r.operation_id AS "operationId" FROM freehold.idempotency_requests r WHERE r.operation='SANDBOX_FUND' AND r.response_body->>'state'='COMPLETED' AND NOT EXISTS (SELECT 1 FROM freehold.admin_actions a WHERE a.operation_id=r.operation_id AND a.action_type='SANDBOX_FUND')`);
    await collect(report.accountingViolations, 'SANDBOX_FUND_POSTING_INVALID', `SELECT j.id AS "journalId", j.operation_id AS "operationId" FROM freehold.ledger_journals j JOIN freehold.idempotency_requests r ON r.operation_id=j.operation_id WHERE j.kind='SANDBOX_FUND' AND (r.operation IS DISTINCT FROM 'SANDBOX_FUND' OR NOT EXISTS (SELECT 1 FROM freehold.admin_actions a WHERE a.operation_id=j.operation_id AND a.action_type='SANDBOX_FUND' AND a.target_id::text=r.request_payload->>'accountId') OR NOT EXISTS (SELECT 1 FROM freehold.ledger_entries e JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id JOIN freehold.accounts ac ON ac.id::text=r.request_payload->>'accountId' WHERE e.journal_id=j.id AND e.side='DEBIT' AND e.amount_minor::text=r.request_payload->>'amountMinor' AND e.currency_code=ac.currency_code AND la.bucket='SANDBOX_EQUITY' AND la.customer_account_id IS NULL) OR NOT EXISTS (SELECT 1 FROM freehold.ledger_entries e JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id JOIN freehold.accounts ac ON ac.id::text=r.request_payload->>'accountId' WHERE e.journal_id=j.id AND e.side='CREDIT' AND e.amount_minor::text=r.request_payload->>'amountMinor' AND e.currency_code=ac.currency_code AND la.customer_account_id::text=r.request_payload->>'accountId' AND la.bucket='AVAILABLE'))`);
    await collect(report.operationalEventViolations, 'INBOX_ORPHAN_EVENT', `SELECT event_id AS "eventId" FROM freehold.worker_inbox i WHERE NOT EXISTS (SELECT 1 FROM freehold.outbox_events e WHERE e.id=i.event_id)`);
    await collect(report.operationalEventViolations, 'AUDIT_EVENT_ORPHAN_OPERATION', `SELECT a.id AS "eventId", a.operation_id AS "operationId" FROM freehold.audit_log a WHERE a.operation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM freehold.idempotency_requests r WHERE r.operation_id=a.operation_id)`);
    await collect(report.operationalEventViolations, 'AUDIT_OPERATION_LINK_INVALID', `SELECT a.id AS "eventId", a.operation_id AS "operationId" FROM freehold.audit_log a JOIN freehold.idempotency_requests r ON r.operation_id=a.operation_id WHERE a.event_type IS DISTINCT FROM r.operation OR a.outcome IS DISTINCT FROM r.response_body->>'state' OR a.resource_id IS DISTINCT FROM r.resource_id OR (a.actor_id IS NOT NULL AND a.actor_id IS DISTINCT FROM r.actor_id)`);
    await collect(report.operationalEventViolations, 'OUTBOX_EVENT_ORPHAN_OPERATION', `SELECT e.id AS "eventId", e.operation_id AS "operationId" FROM freehold.outbox_events e WHERE NOT EXISTS (SELECT 1 FROM freehold.idempotency_requests r WHERE r.operation_id=e.operation_id)`);
    await collect(report.referentialIntegrityViolations, 'TRANSFER_ORPHAN_OPERATION', `SELECT t.id AS "transferId", t.operation_id AS "operationId" FROM freehold.transfers t WHERE NOT EXISTS (SELECT 1 FROM freehold.idempotency_requests r WHERE r.operation_id=t.operation_id)`);
    await collect(report.referentialIntegrityViolations, 'ADMIN_ACTION_ORPHAN_OPERATION', `SELECT a.operation_id AS "operationId", a.action_type AS "actionType", a.target_id AS "targetId" FROM freehold.admin_actions a LEFT JOIN freehold.idempotency_requests r ON r.operation_id=a.operation_id WHERE r.operation_id IS NULL OR r.operation IS DISTINCT FROM a.action_type OR r.resource_id IS DISTINCT FROM a.target_id`);
    await collect(report.referentialIntegrityViolations, 'SEAL_ORPHAN_JOURNAL', `SELECT s.journal_id AS "journalId" FROM freehold.journal_seals s WHERE NOT EXISTS (SELECT 1 FROM freehold.ledger_journals j WHERE j.id=s.journal_id)`);
    await collect(report.accountingViolations, 'GL_POSTING_ENABLED', `SELECT id AS "glAccountId", code FROM freehold.gl_accounts WHERE posting_enabled`);
    await collect(report.accountingViolations, 'GL_CLASSIFICATION_INVALID', `SELECT id AS "glAccountId", classification FROM freehold.gl_accounts WHERE classification NOT IN ('CUSTOMER_LIABILITY','INSTITUTIONAL_ASSET','INSTITUTIONAL_LIABILITY','EQUITY','REVENUE','EXPENSE','SUSPENSE','SETTLEMENT_CLEARING')`);
    await collect(report.projectionDiscrepancies, 'GL_CUSTOMER_LIABILITY_MISMATCH', `SELECT a.currency_code AS currency, coalesce(l.minor,0)::text AS "ledgerLiabilityMinor", coalesce(p.minor,0)::text AS "projectionMinor" FROM (SELECT DISTINCT currency_code FROM freehold.accounts) a LEFT JOIN (SELECT la.currency_code, sum(CASE WHEN e.side='CREDIT' THEN e.amount_minor ELSE -e.amount_minor END) AS minor FROM freehold.ledger_entries e JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id WHERE la.customer_account_id IS NOT NULL AND la.accounting_class='LIABILITY' GROUP BY la.currency_code) l ON l.currency_code=a.currency_code LEFT JOIN (SELECT currency_code, sum(available_minor+reserved_minor) AS minor FROM freehold.accounts GROUP BY currency_code) p ON p.currency_code=a.currency_code WHERE coalesce(l.minor,0) IS DISTINCT FROM coalesce(p.minor,0)`);
    await collect(report.accountingViolations, 'SCHEDULED_EXECUTION_ORPHAN', `SELECT e.id AS "executionId" FROM freehold.scheduled_transfer_executions e WHERE NOT EXISTS (SELECT 1 FROM freehold.scheduled_transfers s WHERE s.id=e.instruction_id)`);
    await collect(report.accountingViolations, 'SCHEDULED_COMPLETED_WITHOUT_POSTING', `SELECT e.id AS "executionId", e.operation_id AS "operationId" FROM freehold.scheduled_transfer_executions e WHERE e.outcome='COMPLETED' AND NOT EXISTS (SELECT 1 FROM freehold.transfers t WHERE t.operation_id=e.operation_id AND t.state='COMPLETED')`);
    await collect(report.accountingViolations, 'SCHEDULED_INSTRUCTION_WITHOUT_EXECUTION', `SELECT s.id AS "instructionId" FROM freehold.scheduled_transfers s WHERE s.status='COMPLETED' AND NOT EXISTS (SELECT 1 FROM freehold.scheduled_transfer_executions e WHERE e.instruction_id=s.id AND e.outcome='COMPLETED')`);

    guard();
    await verifyGovernance(client, report, issue, guard);
    guard();
    await verifyMonetary(client, report, issue);
    guard();
    await verifyInstitution(client, report, issue);
    guard();
    await verifyNetwork(client, report, issue);
    guard();
    await verifyProgram(client, report, issue);
    guard();
    await client.query('COMMIT');
    report.accountingOutcome = incomplete ? 'INCOMPLETE' : totalEvidence === 0 ? 'VERIFIED' : 'MISMATCH';
    report.externalReserveOutcome = report.monetary?.externalReserveOutcome ?? 'NOT_REQUIRED';
    report.outcome = report.accountingOutcome === 'VERIFIED' && report.externalReserveOutcome === 'EXTERNAL_EVIDENCE_UNAVAILABLE'
      ? 'EXTERNAL_EVIDENCE_UNAVAILABLE'
      : report.accountingOutcome;
    report.resources.phases = phases.length;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    const code = error?.code;
    report.outcome = code === '57014' || code === 'CANCELLED' || code === 'RESOURCE_LIMIT' ? 'INCOMPLETE' : 'ERROR';
    report.accountingOutcome = report.outcome;
    report.error = {
      code: code ?? 'INTERNAL',
      message: code === '57014' ? 'Verification exceeded the configured statement timeout.'
        : code === 'CANCELLED' ? 'Verification was cancelled. The partial result is not a verification.'
        : code === 'RESOURCE_LIMIT' ? 'Verification stopped at the configured resource limit. The partial result is not a verification.'
        : 'Verification could not complete; see verifier process diagnostics.',
    };
  }
  if (report.outcome === 'VERIFIED' && (incomplete || checks.some(items => items.length) || !report.scan.complete)) {
    report.outcome = report.scan.complete ? 'MISMATCH' : 'INCOMPLETE';
    report.accountingOutcome = report.outcome;
  }
  report.violationCount = totalEvidence;
  report.completedAt = new Date().toISOString();
  noteMemoryQuiet(report);
  return report;
}

function noteMemoryQuiet(report) {
  const usage = process.memoryUsage();
  report.resources.rssBytesPeak = Math.max(report.resources.rssBytesPeak ?? 0, usage.rss);
  report.resources.heapUsedPeak = Math.max(report.resources.heapUsedPeak ?? 0, usage.heapUsed);
}

async function verifyGovernance(client, report, issue, guard) {
  guard();
  const sizes = await client.query(`SELECT
    (SELECT count(*) FROM freehold.users) AS users,
    (SELECT count(*) FROM freehold.governance_requests) AS requests,
    (SELECT count(*) FROM freehold.governance_decisions) AS decisions,
    (SELECT count(*) FROM freehold.governance_audit) AS audit,
    (SELECT count(*) FROM freehold.risk_policies) AS policies`);
  for (const [name, value] of Object.entries(sizes.rows[0])) {
    if (BigInt(value) > BigInt(MAX_REFERENCE_ROWS)) throw stop('RESOURCE_LIMIT', `Governance reference set ${name} exceeded ${MAX_REFERENCE_ROWS} rows.`);
  }
  const usersQ = await client.query('SELECT id,status,role FROM freehold.users ORDER BY id');
  const governanceQ = await client.query('SELECT id,initiator_id,operation,parameters,payload_hash,required_capability,status,created_at,expires_at,decided_at,executed_at,executor_id,result,operation_id FROM freehold.governance_requests ORDER BY id');
  const capabilityQ = await client.query('SELECT principal_id,capability,granted_at,revoked_at FROM freehold.governance_capabilities ORDER BY principal_id,capability');
  const capabilityHistoryQ = await client.query('SELECT id,principal_id,capability,event,changed_at FROM freehold.governance_capability_history ORDER BY principal_id,capability,changed_at,id');
  const decisionQ = await client.query('SELECT request_id,principal_id,capability,decision,decided_at FROM freehold.governance_decisions ORDER BY request_id,principal_id');
  const requirementQ = await client.query('SELECT request_id,capability,required_count FROM freehold.governance_approval_requirements ORDER BY request_id,capability');
  const governanceAuditQ = await client.query('SELECT request_id,event_type,requesting_principal,approving_principal,executing_principal,affected_resource,outcome,recorded_at FROM freehold.governance_audit ORDER BY request_id,event_type,recorded_at');
  const institutionalControlQ = await client.query('SELECT singleton,writes_suspended,suspended_by,suspended_at,resumed_at FROM freehold.institutional_control');
  const policyQ = await client.query(`SELECT id,scope,account_id,currency_code,rule_code,threshold_minor::text AS threshold_minor,threshold_count,window_seconds,size_multiple,timezone,enabled,governance_request_id FROM freehold.risk_policies`);
  const policyChangeQ = await client.query('SELECT id,policy_id,governance_request_id,parameters,recorded_at FROM freehold.risk_policy_changes');
  const opIds = governanceQ.rows.map(row => row.operation_id).filter(Boolean);
  const requestQ = opIds.length
    ? await client.query('SELECT actor_id::text,operation,operation_id,resource_id,response_body FROM freehold.idempotency_requests WHERE operation_id = ANY($1::uuid[])', [opIds])
    : { rows: [] };
  const adminQ = opIds.length
    ? await client.query('SELECT operation_id,actor_user_id,action_type,target_id FROM freehold.admin_actions WHERE operation_id = ANY($1::uuid[])', [opIds])
    : { rows: [] };
  const accountIds = governanceQ.rows.map(row => obj(row.parameters).accountId).filter(Boolean);
  const accountQ = accountIds.length
    ? await client.query('SELECT id FROM freehold.accounts WHERE id = ANY($1::uuid[])', [accountIds])
    : { rows: [] };
  const accounts = new Map(accountQ.rows.map(row => [key(row.id), row]));
  const governanceUsers = new Map(usersQ.rows.map(row => [key(row.id), row]));
  const governanceRequests = new Map(governanceQ.rows.map(row => [key(row.id), row]));
  const idempotencyByOperation = new Map(requestQ.rows.map(row => [key(row.operation_id), row]));
  const adminByOperation = new Map();
  for (const action of adminQ.rows) if (!adminByOperation.has(key(action.operation_id))) adminByOperation.set(key(action.operation_id), action);
  const decisionsByRequest = new Map();
  const requirementsByRequest = new Map();
  const auditByGovernanceRequest = new Map();
  const decisionPrincipalCounts = new Map();
  const capabilitiesByPrincipal = new Map();
  const capabilityHistoryByScope = new Map();
  for (const capability of capabilityQ.rows) {
    const scope = `${key(capability.principal_id)}:${capability.capability}`;
    const list = capabilitiesByPrincipal.get(scope) ?? [];
    list.push(capability);
    capabilitiesByPrincipal.set(scope, list);
  }
  for (const event of capabilityHistoryQ.rows) {
    const scope = `${key(event.principal_id)}:${event.capability}`;
    const list = capabilityHistoryByScope.get(scope) ?? [];
    list.push(event);
    capabilityHistoryByScope.set(scope, list);
  }
  const hasCapabilityAt = (principal, capability, at) => {
    const when = instant(at);
    const events = capabilityHistoryByScope.get(`${key(principal)}:${capability}`) ?? [];
    const latest = events.filter(event => instant(event.changed_at) <= when).at(-1);
    return latest?.event === 'GRANT';
  };
  const hasCurrentCapability = (principal, capability) => hasCapabilityAt(principal, capability, new Date().toISOString());
  for (const [scope, currentRows] of capabilitiesByPrincipal) {
    const events = capabilityHistoryByScope.get(scope) ?? [];
    const last = events.at(-1);
    const current = currentRows[0];
    if (!last || (last.event === 'GRANT' && (current.revoked_at !== null || instant(current.granted_at) !== instant(last.changed_at))) ||
        (last.event === 'REVOKE' && (current.revoked_at === null || instant(current.revoked_at) !== instant(last.changed_at))))
      issue(report.governanceViolations, 'GOVERNANCE_CAPABILITY_PROJECTION_MISMATCH', { principalId: current.principal_id, capability: current.capability });
  }
  for (const scope of capabilityHistoryByScope.keys()) if (!capabilitiesByPrincipal.has(scope)) {
    const [principalId, capability] = scope.split(':');
    issue(report.governanceViolations, 'GOVERNANCE_CAPABILITY_HISTORY_ORPHAN', { principalId, capability });
  }
  for (const decision of decisionQ.rows) {
    const requestKey = key(decision.request_id);
    const list = decisionsByRequest.get(requestKey) ?? [];
    list.push(decision);
    decisionsByRequest.set(requestKey, list);
    const principalKey = `${requestKey}:${key(decision.principal_id)}`;
    decisionPrincipalCounts.set(principalKey, (decisionPrincipalCounts.get(principalKey) ?? 0) + 1);
  }
  for (const requirement of requirementQ.rows) {
    const requestKey = key(requirement.request_id);
    const list = requirementsByRequest.get(requestKey) ?? [];
    list.push(requirement);
    requirementsByRequest.set(requestKey, list);
  }
  for (const audit of governanceAuditQ.rows) if (audit.request_id) {
    const requestKey = key(audit.request_id);
    const list = auditByGovernanceRequest.get(requestKey) ?? [];
    list.push(audit);
    auditByGovernanceRequest.set(requestKey, list);
  }
  if (institutionalControlQ.rowCount !== 1) issue(report.governanceViolations, 'INSTITUTIONAL_CONTROL_CARDINALITY_INVALID', { rowCount: institutionalControlQ.rowCount });
  for (const decision of decisionQ.rows) {
    const request = governanceRequests.get(key(decision.request_id));
    const user = governanceUsers.get(key(decision.principal_id));
    if (!request) issue(report.governanceViolations, 'GOVERNANCE_DECISION_ORPHAN_REQUEST', { requestId: decision.request_id });
    if ((decisionPrincipalCounts.get(`${key(decision.request_id)}:${key(decision.principal_id)}`) ?? 0) > 1) issue(report.governanceViolations, 'GOVERNANCE_PRINCIPAL_COUNTED_MULTIPLE_TIMES', { requestId: decision.request_id, principalId: decision.principal_id });
    if (!user || user.role !== 'ADMIN') issue(report.governanceViolations, 'GOVERNANCE_APPROVER_NOT_ADMIN', { requestId: decision.request_id, principalId: decision.principal_id });
    if (request && key(request.initiator_id) === key(decision.principal_id)) issue(report.governanceViolations, 'GOVERNANCE_SELF_APPROVAL', { requestId: decision.request_id, principalId: decision.principal_id });
    if (!(requirementsByRequest.get(key(decision.request_id)) ?? []).some(requirement => requirement.capability === decision.capability)) issue(report.governanceViolations, 'GOVERNANCE_DECISION_CAPABILITY_NOT_REQUIRED', { requestId: decision.request_id, capability: decision.capability });
    if (!hasCapabilityAt(decision.principal_id, decision.capability, decision.decided_at)) issue(report.governanceViolations, 'GOVERNANCE_APPROVAL_NOT_AUTHORIZED_AT_DECISION', { requestId: decision.request_id, principalId: decision.principal_id, capability: decision.capability });
  }
  for (const request of governanceQ.rows) {
    const requestKey = key(request.id);
    const requestDecisions = decisionsByRequest.get(requestKey) ?? [];
    const requirements = requirementsByRequest.get(requestKey) ?? [];
    const audit = auditByGovernanceRequest.get(requestKey) ?? [];
    const initiator = governanceUsers.get(key(request.initiator_id));
    if (!initiator || initiator.role !== 'ADMIN') issue(report.governanceViolations, 'GOVERNANCE_INITIATOR_NOT_ADMIN', { requestId: request.id, initiatorId: request.initiator_id });
    if (requirements.length === 0 || !requirements.some(requirement => requirement.capability === request.required_capability)) issue(report.governanceViolations, 'GOVERNANCE_REQUIREMENTS_MISSING_OR_INCONSISTENT', { requestId: request.id });
    if (['FREEZE_ACCOUNT', 'UNFREEZE_ACCOUNT'].includes(request.operation) && !accounts.has(key(obj(request.parameters).accountId))) issue(report.governanceViolations, 'GOVERNANCE_TARGET_ACCOUNT_MISSING', { requestId: request.id });
    if (request.operation === 'SET_RISK_POLICY' && obj(request.parameters).scope === 'ACCOUNT' && !accounts.has(key(obj(request.parameters).accountId))) issue(report.governanceViolations, 'GOVERNANCE_TARGET_ACCOUNT_MISSING', { requestId: request.id });
    const initiatorCapability = request.operation === 'RESUME_WRITES' ? 'EMERGENCY_CONTROL' : request.operation === 'SET_RISK_POLICY' ? 'INSTITUTION_ADMIN' : 'ACCOUNT_ADMIN';
    if (!hasCapabilityAt(request.initiator_id, initiatorCapability, request.created_at)) issue(report.governanceViolations, 'GOVERNANCE_INITIATOR_UNAUTHORIZED_AT_REQUEST', { requestId: request.id, initiatorId: request.initiator_id, capability: initiatorCapability });
    if (audit.filter(event => event.event_type === 'REQUESTED').length !== 1) issue(report.governanceViolations, 'GOVERNANCE_REQUEST_AUDIT_COUNT_INVALID', { requestId: request.id, requestEvents: audit.filter(event => event.event_type === 'REQUESTED').length });
    for (const requirement of requirements) {
      const historical = requestDecisions.filter(decision => decision.capability === requirement.capability && decision.decision === 'APPROVE' && hasCapabilityAt(decision.principal_id, decision.capability, decision.decided_at)).length;
      const current = requestDecisions.filter(decision => decision.capability === requirement.capability && decision.decision === 'APPROVE' && hasCurrentCapability(decision.principal_id, decision.capability)).length;
      if (['APPROVED', 'EXECUTED', 'FAILED'].includes(request.status) && historical < Number(requirement.required_count)) issue(report.governanceViolations, 'GOVERNANCE_REQUIRED_APPROVALS_MISSING', { requestId: request.id, capability: requirement.capability, required: Number(requirement.required_count), validAtDecision: historical });
      if (request.status === 'APPROVED' && current < Number(requirement.required_count)) issue(report.governanceViolations, 'GOVERNANCE_APPROVED_WITH_REVOKED_APPROVAL', { requestId: request.id, capability: requirement.capability, required: Number(requirement.required_count), currentlyAuthorized: current });
    }
    if (request.status === 'REJECTED' && !requestDecisions.some(decision => decision.decision === 'REJECT')) issue(report.governanceViolations, 'GOVERNANCE_REJECTED_WITHOUT_REJECTION', { requestId: request.id });
    const terminal = ['EXECUTED', 'FAILED'].includes(request.status);
    if (terminal !== Boolean(request.executed_at && request.executor_id && request.result)) issue(report.governanceViolations, 'GOVERNANCE_EXECUTION_STATE_INCOMPLETE', { requestId: request.id, status: request.status });
    if (terminal) {
      const executor = governanceUsers.get(key(request.executor_id));
      const executionCapability = request.operation === 'RESUME_WRITES' || request.operation === 'SET_RISK_POLICY' ? 'INSTITUTION_ADMIN' : 'ACCOUNT_ADMIN';
      if (!executor || executor.role !== 'ADMIN' || !hasCapabilityAt(request.executor_id, executionCapability, request.executed_at)) issue(report.governanceViolations, 'GOVERNANCE_EXECUTOR_UNAUTHORIZED', { requestId: request.id, executorId: request.executor_id, capability: executionCapability });
      const result = obj(request.result);
      const outcome = obj(result.result);
      if (result.status !== request.status || result.requestId !== request.id) issue(report.governanceViolations, 'GOVERNANCE_EXECUTION_RESULT_INVALID', { requestId: request.id, status: request.status });
      if (request.operation === 'RESUME_WRITES') {
        if (request.operation_id || outcome.writesSuspended !== false) issue(report.governanceViolations, 'GOVERNANCE_RESUME_RESULT_INVALID', { requestId: request.id });
      } else if (request.operation === 'SET_RISK_POLICY') {
        const changes = policyChangeQ.rows.filter(change => key(change.governance_request_id) === key(request.id));
        const change = changes[0];
        const live = policyQ.rows.find(policy => policy.governance_request_id && key(policy.governance_request_id) === key(request.id));
        const reconstructed = live ? { accountId: live.account_id, currencyCode: live.currency_code, enabled: live.enabled, ruleCode: live.rule_code, scope: live.scope, sizeMultiple: live.size_multiple, thresholdCount: live.threshold_count, thresholdMinor: live.threshold_minor, timezone: live.timezone, windowSeconds: live.window_seconds } : null;
        const linked = request.status === 'EXECUTED' && change && key(change.policy_id) === key(outcome.policyId) && outcome.state === 'COMPLETED';
        if (request.operation_id || changes.length !== 1 || !change || stableJson(change.parameters) !== stableJson(request.parameters) || (request.status === 'EXECUTED' && !linked) || (live && stableJson(reconstructed) !== stableJson(request.parameters)))
          issue(report.governanceViolations, 'GOVERNANCE_RISK_POLICY_LINK_INVALID', { requestId: request.id, policyId: outcome.policyId ?? null, changeCount: changes.length });
      } else {
        const financial = idempotencyByOperation.get(key(request.operation_id));
        const action = adminByOperation.get(key(request.operation_id));
        const expectedOperation = request.operation === 'FREEZE_ACCOUNT' ? 'FREEZE' : 'UNFREEZE';
        const accountId = obj(request.parameters).accountId;
        const successful = request.status === 'EXECUTED';
        const operationInvalid = !request.operation_id || !financial || financial.operation !== expectedOperation || key(financial.actor_id) !== key(request.initiator_id) ||
          key(financial.resource_id) !== key(accountId) || key(outcome.operationId) !== key(request.operation_id) ||
          (successful && (!action || action.action_type !== expectedOperation || key(action.target_id) !== key(accountId) || key(action.actor_user_id) !== key(request.initiator_id))) ||
          (!successful && obj(financial.response_body).state !== 'REJECTED');
        if (operationInvalid) issue(report.governanceViolations, 'GOVERNANCE_FINANCIAL_OPERATION_LINK_INVALID', { requestId: request.id, operationId: request.operation_id, accountId });
      }
      if (!audit.some(event => event.event_type === 'EXECUTED' || event.event_type === 'EXECUTION_FAILED')) issue(report.governanceViolations, 'GOVERNANCE_EXECUTION_AUDIT_MISSING', { requestId: request.id, status: request.status });
    } else if (request.operation_id || request.executor_id || request.executed_at || request.result) {
      issue(report.governanceViolations, 'GOVERNANCE_NONTERMINAL_HAS_EXECUTION_DATA', { requestId: request.id, status: request.status });
    }
    const expectedAuditDecisionCount = requestDecisions.length;
    const recordedAuditDecisionCount = audit.filter(event => ['APPROVED', 'REJECTED'].includes(event.event_type)).length;
    if (expectedAuditDecisionCount !== recordedAuditDecisionCount) issue(report.governanceViolations, 'GOVERNANCE_DECISION_AUDIT_COUNT_MISMATCH', { requestId: request.id, decisions: expectedAuditDecisionCount, auditEvents: recordedAuditDecisionCount });
  }
  for (const audit of governanceAuditQ.rows) {
    if (audit.request_id && !governanceRequests.has(key(audit.request_id))) issue(report.governanceViolations, 'GOVERNANCE_AUDIT_ORPHAN_REQUEST', { requestId: audit.request_id });
    for (const [field, value] of [['requestingPrincipal', audit.requesting_principal], ['approvingPrincipal', audit.approving_principal], ['executingPrincipal', audit.executing_principal]])
      if (value && !governanceUsers.has(key(value))) issue(report.governanceViolations, 'GOVERNANCE_AUDIT_ORPHAN_PRINCIPAL', { requestId: audit.request_id, principalField: field });
  }
  for (const control of institutionalControlQ.rows) if (control.writes_suspended &&
    !governanceAuditQ.rows.some(event => event.event_type === 'EMERGENCY_SUSPEND' && event.outcome === 'SUSPENDED' && key(event.requesting_principal) === key(control.suspended_by) && event.recorded_at >= control.suspended_at))
    issue(report.governanceViolations, 'SUSPENSION_WITHOUT_AUDIT_EVIDENCE', { suspendedBy: control.suspended_by, suspendedAt: control.suspended_at });
}

// Independent of monetary_* functions. Simulated reserve rows are reported and never treated as external evidence.
async function verifyMonetary(client, report, issue) {
  const present = await client.query("SELECT to_regclass('freehold.monetary_supply') IS NOT NULL AS present");
  if (!present.rows[0].present) {
    report.monetary = { present: false, externalReserveOutcome: 'NOT_REQUIRED', simulatedEligibleReserves: '0', paymentStablecoinOutstanding: '0' };
    return;
  }
  const supplySql = `WITH issued AS (
      SELECT book_id,
        COALESCE(sum(amount_minor) FILTER (WHERE state = 'ISSUED'), 0) AS issued,
        COALESCE(sum(amount_minor) FILTER (WHERE state IN ('REQUESTED','PENDING_RESERVE_VERIFICATION','PENDING_APPROVAL','APPROVED','EXECUTING','UNKNOWN')), 0) AS pending_i
      FROM freehold.issuance_operations GROUP BY book_id
    ), redeemed AS (
      SELECT book_id,
        COALESCE(sum(amount_minor) FILTER (WHERE state = 'REDEEMED'), 0) AS redeemed,
        COALESCE(sum(amount_minor) FILTER (WHERE state IN ('REQUESTED','VALIDATING','UNITS_SECURED','PENDING_SETTLEMENT','SETTLEMENT_CONFIRMED','EXCEPTION','UNKNOWN')), 0) AS pending_r
      FROM freehold.redemption_operations GROUP BY book_id
    ), corr AS (
      SELECT book_id, COALESCE(sum(amount_minor), 0) AS corrections FROM freehold.supply_corrections GROUP BY book_id
    ), holders AS (
      SELECT book_id,
        COALESCE(sum(units) FILTER (WHERE holder_kind = 'CUSTOMER'), 0) AS customer,
        COALESCE(sum(units) FILTER (WHERE holder_kind = 'TREASURY'), 0) AS treasury,
        COALESCE(sum(units) FILTER (WHERE holder_kind = 'FROZEN'), 0) AS frozen,
        COALESCE(sum(units) FILTER (WHERE holder_kind = 'PENDING_REDEMPTION'), 0) AS pending_h
      FROM freehold.monetary_holders GROUP BY book_id
    )
    SELECT b.code AS book, s.outstanding::text AS "storedOutstanding",
      (COALESCE(i.issued,0) - COALESCE(r.redeemed,0) + COALESCE(c.corrections,0))::text AS "reconstructedOutstanding",
      (COALESCE(h.customer,0) + COALESCE(h.treasury,0) + COALESCE(h.frozen,0) + COALESCE(h.pending_h,0))::text AS "holderUnits"
    FROM freehold.monetary_books b
    JOIN freehold.monetary_supply s ON s.book_id = b.id
    LEFT JOIN issued i ON i.book_id = b.id
    LEFT JOIN redeemed r ON r.book_id = b.id
    LEFT JOIN corr c ON c.book_id = b.id
    LEFT JOIN holders h ON h.book_id = b.id
    WHERE s.outstanding IS DISTINCT FROM (COALESCE(i.issued,0) - COALESCE(r.redeemed,0) + COALESCE(c.corrections,0))
       OR s.outstanding IS DISTINCT FROM (COALESCE(h.customer,0) + COALESCE(h.treasury,0) + COALESCE(h.frozen,0) + COALESCE(h.pending_h,0))
       OR s.pending_issuance IS DISTINCT FROM COALESCE(i.pending_i,0)
       OR s.pending_redemption IS DISTINCT FROM COALESCE(r.pending_r,0)
       OR COALESCE(h.pending_h,0) IS DISTINCT FROM COALESCE(r.pending_r,0)
       OR s.issued_lifetime IS DISTINCT FROM COALESCE(i.issued,0)
       OR s.redeemed_lifetime IS DISTINCT FROM COALESCE(r.redeemed,0)
       OR s.customer_units IS DISTINCT FROM COALESCE(h.customer,0)
       OR s.treasury_units IS DISTINCT FROM COALESCE(h.treasury,0)
       OR s.frozen_units IS DISTINCT FROM COALESCE(h.frozen,0)
       OR s.corrections IS DISTINCT FROM COALESCE(c.corrections,0)
       OR b.cap_basis IS DISTINCT FROM 'OUTSTANDING'
       OR s.outstanding + COALESCE(i.pending_i,0) > b.authorized_max_outstanding
       OR b.live_issuance_enabled OR NOT b.simulation_only`;
  const identity = await client.query(`${supplySql} LIMIT 50`);
  for (const row of identity.rows) issue(report.accountingViolations, 'MONETARY_SUPPLY_IDENTITY', row);

  const journals = await client.query(`SELECT j.id AS "journalId", j.book_id AS "bookId"
    FROM freehold.monetary_journals j
    JOIN freehold.monetary_entries e ON e.journal_id = j.id
    GROUP BY j.id, j.book_id
    HAVING COALESCE(sum(e.amount_minor) FILTER (WHERE e.side = 'DEBIT'), 0)
        <> COALESCE(sum(e.amount_minor) FILTER (WHERE e.side = 'CREDIT'), 0)
        OR count(DISTINCT e.entity_id) <> 1
        OR bool_or(e.entity_id IS DISTINCT FROM j.entity_id)
    LIMIT 50`);
  for (const row of journals.rows) issue(report.accountingViolations, 'MONETARY_JOURNAL_UNBALANCED', row);

  const separation = await client.query(`SELECT i.id AS "issuanceId"
    FROM freehold.issuance_operations i
    JOIN freehold.monetary_books b ON b.id = i.book_id
    WHERE b.product_code = 'PAYMENT_STABLECOIN' AND i.state = 'ISSUED'
      AND (i.approver_id IS NULL OR i.executor_id IS NULL OR i.approver_id = i.requester_id
           OR i.executor_id = i.requester_id OR i.executor_id IS NOT DISTINCT FROM i.approver_id
           OR NOT EXISTS (
             SELECT 1 FROM freehold.monetary_audit a
             WHERE a.book_id = i.book_id AND a.action = 'ISSUE_EXECUTE' AND a.detail->>'issuanceId' = i.id::text
           ))
    LIMIT 50`);
  for (const row of separation.rows) issue(report.accountingViolations, 'MONETARY_ISSUANCE_SEPARATION', row);

  const chain = await client.query(`WITH nets AS (
      SELECT book_id,
        COALESCE(sum(observed_amount) FILTER (WHERE kind = 'ISSUE' AND finality = 'FINAL'), 0)
        - COALESCE(sum(observed_amount) FILTER (WHERE kind = 'BURN' AND finality = 'FINAL'), 0) AS net,
        count(*) FILTER (WHERE finality = 'FINAL' AND kind IN ('ISSUE','BURN')) AS finals
      FROM freehold.chain_observations GROUP BY book_id
    )
    SELECT b.code AS book, s.outstanding::text AS outstanding, n.net::text AS "finalNet"
    FROM nets n
    JOIN freehold.monetary_supply s ON s.book_id = n.book_id
    JOIN freehold.monetary_books b ON b.id = n.book_id
    WHERE n.finals > 0 AND n.net IS DISTINCT FROM s.outstanding
    LIMIT 50`);
  for (const row of chain.rows) issue(report.accountingViolations, 'MONETARY_CHAIN_SUPPLY_MISMATCH', row);

  const scope = await client.query(`SELECT id AS "reserveId", evidence_scope AS "evidenceScope"
    FROM freehold.reserve_assets WHERE evidence_scope IS DISTINCT FROM 'SIMULATED' LIMIT 50`);
  for (const row of scope.rows) issue(report.accountingViolations, 'MONETARY_RESERVE_SCOPE', row);
  const owner = await client.query(`SELECT r.id AS "reserveId"
    FROM freehold.reserve_assets r JOIN freehold.monetary_books b ON b.id = r.book_id
    WHERE r.legal_owner_entity_id IS DISTINCT FROM b.entity_id OR r.custodian_entity_id = r.legal_owner_entity_id
    LIMIT 50`);
  for (const row of owner.rows) issue(report.accountingViolations, 'MONETARY_RESERVE_OWNER', row);
  const duplicates = await client.query(`SELECT asset_ref AS "assetRef", count(*)::int AS copies
    FROM freehold.reserve_assets GROUP BY asset_ref HAVING count(*) > 1 LIMIT 50`);
  for (const row of duplicates.rows) issue(report.accountingViolations, 'MONETARY_RESERVE_DOUBLE_COUNT', row);

  const reports = await client.query(`SELECT id AS "reportId", state, submission_status AS "submissionStatus", certification_status AS "certificationStatus"
    FROM freehold.regulatory_reports
    WHERE state = 'SUBMITTED_WITH_EVIDENCE' OR submission_status IS DISTINCT FROM 'NOT_SUBMITTED'
       OR certification_status IS DISTINCT FROM 'NOT_CERTIFIED' OR external_evidence_status IS DISTINCT FROM 'UNAVAILABLE'
    LIMIT 50`);
  for (const row of reports.rows) issue(report.accountingViolations, 'MONETARY_FALSE_CERTIFICATION', row);
  const bank = await client.query(`SELECT id AS "eventId" FROM freehold.bank_events WHERE internal_journal_id IS NOT NULL LIMIT 50`);
  for (const row of bank.rows) issue(report.accountingViolations, 'MONETARY_BANK_JOURNAL_LINK', row);
  const live = await client.query(`SELECT code FROM freehold.legal_entities WHERE live_authorized OR NOT simulation_only LIMIT 50`);
  for (const row of live.rows) issue(report.accountingViolations, 'MONETARY_LIVE_ENTITY', row);

  const eligible = await client.query(`SELECT COALESCE(sum(r.valuation_minor), 0)::text AS eligible
    FROM freehold.reserve_assets r
    JOIN freehold.monetary_books b ON b.id = r.book_id
    WHERE b.product_code = 'PAYMENT_STABLECOIN' AND b.simulation_only AND NOT b.live_issuance_enabled
      AND r.evidence_state = 'VERIFIED' AND r.evidence_scope = 'SIMULATED' AND NOT r.encumbered
      AND r.verified_at > clock_timestamp() - interval '32 days'
      AND r.legal_owner_entity_id = b.entity_id AND r.custodian_entity_id <> r.legal_owner_entity_id
      AND r.valuation_minor <= r.quantity_minor
      AND (r.category IN ('USD_CASH','FED_BALANCE')
        OR (r.category = 'DEMAND_DEPOSIT_INSURED' AND r.insured_depository)
        OR (r.category = 'TREASURY_MAX_93_DAYS' AND r.maturity_date IS NOT NULL
            AND r.maturity_date >= r.valuation_date AND r.maturity_date <= r.valuation_date + 93))`);
  const outstanding = await client.query(`SELECT COALESCE(sum(s.outstanding), 0)::text AS outstanding
    FROM freehold.monetary_supply s
    JOIN freehold.monetary_books b ON b.id = s.book_id
    WHERE b.product_code = 'PAYMENT_STABLECOIN'`);
  const uncovered = await client.query(`SELECT b.code AS book, s.outstanding::text AS outstanding, e.eligible::text AS "simulatedEligible"
    FROM freehold.monetary_books b
    JOIN freehold.monetary_supply s ON s.book_id = b.id
    JOIN LATERAL (
      SELECT COALESCE(sum(r.valuation_minor), 0) AS eligible
      FROM freehold.reserve_assets r
      WHERE r.book_id = b.id AND r.evidence_state = 'VERIFIED' AND r.evidence_scope = 'SIMULATED' AND NOT r.encumbered
        AND r.verified_at > clock_timestamp() - interval '32 days'
        AND r.legal_owner_entity_id = b.entity_id AND r.custodian_entity_id <> r.legal_owner_entity_id
        AND (r.category IN ('USD_CASH','FED_BALANCE')
          OR (r.category = 'DEMAND_DEPOSIT_INSURED' AND r.insured_depository)
          OR (r.category = 'TREASURY_MAX_93_DAYS' AND r.maturity_date IS NOT NULL
              AND r.maturity_date >= r.valuation_date AND r.maturity_date <= r.valuation_date + 93))
    ) e ON true
    WHERE b.product_code = 'PAYMENT_STABLECOIN' AND s.outstanding > e.eligible
      AND NOT EXISTS (
        SELECT 1 FROM freehold.monetary_alerts a
        WHERE a.book_id = b.id AND a.code = 'RESERVE_DEFICIT' AND a.acknowledged_at IS NULL
      )
    LIMIT 50`);
  for (const row of uncovered.rows) issue(report.accountingViolations, 'MONETARY_DEFICIT_UNALERTED', row);

  const stablecoinOutstanding = outstanding.rows[0].outstanding;
  report.monetary = {
    present: true,
    paymentStablecoinOutstanding: stablecoinOutstanding,
    simulatedEligibleReserves: eligible.rows[0].eligible,
    simulatedReservesAreExternalEvidence: false,
    externalReserveOutcome: BigInt(stablecoinOutstanding) > 0n ? 'EXTERNAL_EVIDENCE_UNAVAILABLE' : 'NOT_REQUIRED',
  };
  report.externalReserveOutcome = report.monetary.externalReserveOutcome;
}

async function verifyInstitution(client, report, issue) {
  const present = await client.query(`SELECT to_regclass('freehold.institutions') IS NOT NULL AS present`);
  if (!present.rows[0].present) {
    report.institution = { present: false, externalEvidence: 'NOT_REQUIRED', accountingSeparateFromExternalEvidence: true };
    return;
  }
  const counts = await client.query(`SELECT
    (SELECT count(*) FROM freehold.institutions) AS institutions,
    (SELECT count(*) FROM freehold.institution_journals) AS journals,
    (SELECT count(*) FROM freehold.institution_ledger_accounts WHERE kind IN ('RESERVE','TREASURY') AND evidence_state = 'EXTERNAL_UNAVAILABLE') AS external_unavailable`);
  report.institution = {
    present: true,
    institutions: countValue(counts.rows[0].institutions),
    journals: countValue(counts.rows[0].journals),
    externalEvidence: BigInt(counts.rows[0].external_unavailable) > 0n ? 'EXTERNAL_EVIDENCE_UNAVAILABLE' : 'NOT_REQUIRED',
    simulatedInternalBalancesAreExternalEvidence: false,
    accountingSeparateFromExternalEvidence: true,
  };
  const queries = [
    ['INSTITUTION_JOURNAL_IMBALANCE', `SELECT j.id AS "journalId", j.institution_id AS "institutionId",
      coalesce(sum(e.amount_minor) FILTER (WHERE e.side='DEBIT'),0)::text AS "debitsMinor",
      coalesce(sum(e.amount_minor) FILTER (WHERE e.side='CREDIT'),0)::text AS "creditsMinor"
      FROM freehold.institution_journals j LEFT JOIN freehold.institution_entries e ON e.journal_id=j.id
      GROUP BY j.id, j.institution_id
      HAVING coalesce(sum(e.amount_minor) FILTER (WHERE e.side='DEBIT'),0) IS DISTINCT FROM coalesce(sum(e.amount_minor) FILTER (WHERE e.side='CREDIT'),0)`],
    ['INSTITUTION_ENTRY_SCOPE', `SELECT e.journal_id AS "journalId", e.account_id AS "accountId", j.institution_id AS "journalInstitutionId", a.institution_id AS "accountInstitutionId"
      FROM freehold.institution_entries e
      JOIN freehold.institution_journals j ON j.id=e.journal_id
      JOIN freehold.institution_ledger_accounts a ON a.id=e.account_id
      WHERE a.institution_id IS DISTINCT FROM j.institution_id OR a.currency_code IS DISTINCT FROM j.currency_code OR a.legal_entity_id IS DISTINCT FROM j.legal_entity_id`],
    ['INSTITUTION_BALANCE_MISMATCH', `WITH signed AS (
      SELECT e.account_id, CASE
        WHEN a.kind IN ('TREASURY','OPERATING','RESERVE','SETTLEMENT_RECEIVABLE') AND e.side='DEBIT' THEN e.amount_minor
        WHEN a.kind IN ('TREASURY','OPERATING','RESERVE','SETTLEMENT_RECEIVABLE') AND e.side='CREDIT' THEN -e.amount_minor
        WHEN a.kind IN ('CUSTOMER','CLEARING','SETTLEMENT_PAYABLE','SUSPENSE') AND e.side='CREDIT' THEN e.amount_minor
        WHEN a.kind IN ('CUSTOMER','CLEARING','SETTLEMENT_PAYABLE','SUSPENSE') AND e.side='DEBIT' THEN -e.amount_minor
        ELSE NULL END AS signed
      FROM freehold.institution_entries e JOIN freehold.institution_ledger_accounts a ON a.id=e.account_id)
      SELECT a.id AS "accountId", a.institution_id AS "institutionId", a.balance_minor::text AS "storedMinor", coalesce(s.total,0)::text AS "reconstructedMinor"
      FROM freehold.institution_ledger_accounts a
      LEFT JOIN (SELECT account_id, sum(signed) AS total FROM signed GROUP BY account_id) s ON s.account_id=a.id
      WHERE a.balance_minor IS DISTINCT FROM coalesce(s.total,0) OR EXISTS (SELECT 1 FROM signed x WHERE x.account_id=a.id AND x.signed IS NULL)`],
    ['INSTITUTION_SETTLED_WITHOUT_CONFIRMATION', `SELECT p.id AS "paymentId", p.institution_id AS "institutionId"
      FROM freehold.institution_payments p
      WHERE p.state='SETTLED' AND (
        (SELECT count(*) FROM freehold.institution_provider_events ev WHERE ev.payment_id=p.id AND ev.state='SETTLED' AND ev.signature_ok) <> 1
        OR p.settlement_journal_id IS NULL OR NOT p.signature_ok OR p.finality IS DISTINCT FROM 'SETTLED_SIMULATED')`],
    ['INSTITUTION_CONFIRMATION_STATE', `SELECT ev.id AS "providerEventId", ev.payment_id AS "paymentId", p.state
      FROM freehold.institution_provider_events ev JOIN freehold.institution_payments p ON p.id=ev.payment_id
      WHERE ev.state='SETTLED' AND p.state NOT IN ('SETTLED','RETURNED')`],
    ['INSTITUTION_DUPLICATE_PROVIDER_EVENT', `SELECT payment_id AS "paymentId", provider_event_id AS "providerEventId", count(*)::int AS "eventCount"
      FROM freehold.institution_provider_events GROUP BY payment_id, provider_event_id HAVING count(*) > 1`],
    ['INSTITUTION_SETTLEMENT_JOURNAL', `SELECT p.id AS "paymentId"
      FROM freehold.institution_payments p
      WHERE p.state='SETTLED' AND (SELECT count(*) FROM freehold.institution_journals j WHERE j.institution_id=p.institution_id AND j.idempotency_key='settle:'||p.id::text) <> 1`],
    ['INSTITUTION_ORPHAN_SETTLEMENT', `SELECT p.id AS "paymentId", p.settlement_journal_id AS "journalId"
      FROM freehold.institution_payments p
      WHERE p.settlement_journal_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM freehold.institution_journals j WHERE j.id=p.settlement_journal_id AND j.institution_id=p.institution_id)`],
    ['INSTITUTION_CLEARING_BALANCE', `SELECT a.id AS "accountId", a.institution_id AS "institutionId", a.balance_minor::text AS "storedMinor", coalesce(p.settled,0)::text AS "openSettledMinor"
      FROM freehold.institution_ledger_accounts a
      LEFT JOIN (
        SELECT institution_id, currency_code, legal_entity_id, sum(amount_minor) AS settled
        FROM freehold.institution_payments WHERE state='SETTLED'
        GROUP BY institution_id, currency_code, legal_entity_id
      ) p ON p.institution_id=a.institution_id AND p.currency_code=a.currency_code AND p.legal_entity_id=a.legal_entity_id
      WHERE a.kind='CLEARING' AND a.balance_minor IS DISTINCT FROM coalesce(p.settled,0)
        AND NOT EXISTS (
          SELECT 1 FROM freehold.institution_adjustments adj
          WHERE adj.state='POSTED' AND adj.institution_id=a.institution_id
            AND (adj.debit_account_id=a.id OR adj.credit_account_id=a.id))`],
    ['INSTITUTION_CROSS_ENTITY', `SELECT p.id AS "paymentId", p.legal_entity_id AS "paymentEntityId", a.legal_entity_id AS "accountEntityId"
      FROM freehold.institution_payments p JOIN freehold.institution_ledger_accounts a ON a.id=p.account_id
      WHERE p.legal_entity_id IS DISTINCT FROM a.legal_entity_id OR p.institution_id IS DISTINCT FROM a.institution_id OR p.currency_code IS DISTINCT FROM a.currency_code`],
    ['INSTITUTION_FINALITY', `SELECT id AS "paymentId", state, finality FROM freehold.institution_payments
      WHERE (state='SETTLED' AND finality IS DISTINCT FROM 'SETTLED_SIMULATED')
        OR (state='RETURNED' AND finality IS DISTINCT FROM 'SETTLED_SIMULATED')
        OR (state='SUBMITTED' AND finality IS DISTINCT FROM 'INSTRUCTION_ACCEPTED')
        OR (state IN ('ACKNOWLEDGED','PENDING_SETTLEMENT') AND finality IS DISTINCT FROM 'PROVIDER_ACKNOWLEDGED')
        OR (state IN ('CREATED','VALIDATING','PENDING_APPROVAL','READY_TO_SUBMIT','REJECTED','FAILED','UNKNOWN','CANCELLED') AND finality IS DISTINCT FROM 'NONE')
        OR (finality='SETTLED_SIMULATED' AND state NOT IN ('SETTLED','RETURNED'))`],
    ['INSTITUTION_WEBHOOK_EVENT', `SELECT e.id AS "eventId", e.event_type AS "eventType", e.institution_id AS "institutionId"
      FROM freehold.institution_webhook_events e
      LEFT JOIN freehold.institution_payments p ON p.id=e.payment_id
      WHERE (e.event_type='payment.settled' AND coalesce(e.body->>'state','') IS DISTINCT FROM 'SETTLED')
        OR (e.event_type='payment.unknown' AND coalesce(e.body->>'state','')='SETTLED')
        OR (e.payment_id IS NOT NULL AND (p.id IS NULL OR p.institution_id IS DISTINCT FROM e.institution_id))`],
    ['INSTITUTION_ADJUSTMENT_JOURNAL', `SELECT a.id AS "adjustmentId"
      FROM freehold.institution_adjustments a
      LEFT JOIN freehold.institution_journals j ON j.id=a.journal_id
      WHERE a.state='POSTED' AND (j.id IS NULL OR a.posted_by IS NULL OR a.posted_by=a.proposed_by OR j.institution_id IS DISTINCT FROM a.institution_id
        OR NOT EXISTS (
          SELECT 1 FROM freehold.institution_entries e WHERE e.journal_id=j.id
          HAVING coalesce(sum(e.amount_minor) FILTER (WHERE e.side='DEBIT'),0)=coalesce(sum(e.amount_minor) FILTER (WHERE e.side='CREDIT'),0)
            AND coalesce(sum(e.amount_minor) FILTER (WHERE e.side='DEBIT'),0)>0))`],
    ['INSTITUTION_INVOICE_TOTAL', `SELECT i.id AS "invoiceId", i.total_minor::text AS "totalMinor", coalesce(sum(l.amount_minor),0)::text AS "linesMinor"
      FROM freehold.institution_invoices i LEFT JOIN freehold.institution_invoice_lines l ON l.invoice_id=i.id
      GROUP BY i.id, i.total_minor, i.collected, i.state HAVING i.total_minor IS DISTINCT FROM coalesce(sum(l.amount_minor),0) OR i.collected OR i.state IS DISTINCT FROM 'SIMULATED_DRAFT'`],
    ['INSTITUTION_NEGATIVE_USAGE', `SELECT id AS "usageId", quantity::text AS quantity FROM freehold.institution_usage_records WHERE quantity < 0`],
    ['INSTITUTION_LIVE_AUTHORIZED', `SELECT id AS "institutionId" FROM freehold.institutions WHERE live_authorized OR NOT simulation_only OR status IS DISTINCT FROM 'SIMULATED_SANDBOX'`],
    ['INSTITUTION_RISK_MUTATED', `SELECT id AS "riskRunId" FROM freehold.institution_risk_runs WHERE mutated_accounts OR regulatory_capital_determination`],
    ['INSTITUTION_ISSUANCE_LINK', `SELECT l.institution_id AS "institutionId", l.issuance_id AS "issuanceId"
      FROM freehold.institution_issuance_links l
      WHERE NOT EXISTS (SELECT 1 FROM freehold.issuance_operations o WHERE o.id=l.issuance_id)`],
    ['INSTITUTION_EXTERNAL_ASSET_FLAG', `SELECT id AS "accountId" FROM freehold.institution_ledger_accounts WHERE counts_as_external_asset OR evidence_state NOT IN ('SIMULATED_INTERNAL','EXTERNAL_UNAVAILABLE')`],
  ];
  for (const [code, sql] of queries) {
    const result = await client.query(`${sql} LIMIT ${MAX_EVIDENCE + 1}`);
    for (const row of result.rows) issue(report.accountingViolations, code, row);
  }
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function networkPayload(row) {
  return `v1|${row.originInstitutionId}|${row.beneficiaryInstitutionId}|${row.originAccountId}|${row.beneficiaryAccountId}|${row.currency}|${row.amountMinor}|${row.idempotencyKey}|${row.purpose}`;
}

function networkSignatureOk(publicKeyHex, payload, signatureHex) {
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex ?? '') || !/^[0-9a-f]{128}$/.test(signatureHex ?? '')) return false;
  try {
    const key = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]);
    return verifyEd25519(null, Buffer.from(payload, 'utf8'), { key, format: 'der', type: 'spki' }, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

// Canonical payment bytes are duplicated here so this file does not import the API helper.
async function verifyNetwork(client, report, issue) {
  const present = await client.query("SELECT to_regclass('freehold.network_payments') IS NOT NULL AS present");
  if (!present.rows[0].present) {
    report.network = {
      present: false,
      claimsOutcome: 'NETWORK_CLAIMS_VERIFIED',
      externalSettlement: 'EXTERNAL_SETTLEMENT_UNAVAILABLE',
      balancedInternalPositionIsExternalSettlement: false,
    };
    return;
  }
  let networkDefects = 0;
  const mark = (code, row) => {
    networkDefects += 1;
    issue(report.accountingViolations, code, row);
  };
  const queries = [
    ['NETWORK_NET_SUM', `SELECT c.id AS "cycleId", coalesce(sum(p.net_minor),0)::text AS "reconstructedNetMinor", c.net_sum_minor::text AS "storedNetMinor"
      FROM freehold.network_cycles c LEFT JOIN freehold.network_cycle_positions p ON p.cycle_id=c.id
      WHERE c.status='FINALIZED'
      GROUP BY c.id HAVING coalesce(sum(p.net_minor),0) <> 0 OR c.net_sum_minor IS DISTINCT FROM 0`],
    ['NETWORK_POSITION', `WITH gross AS (
      SELECT o.cycle_id, ends.institution_id,
        coalesce(sum(o.amount_minor) FILTER (WHERE o.origin_institution_id=ends.institution_id),0) AS gross_out,
        coalesce(sum(o.amount_minor) FILTER (WHERE o.beneficiary_institution_id=ends.institution_id),0) AS gross_in
      FROM freehold.network_obligations o
      JOIN (
        SELECT cycle_id, origin_institution_id AS institution_id FROM freehold.network_obligations
        WHERE cycle_id IS NOT NULL AND status IN ('IN_CYCLE','SETTLED')
        UNION
        SELECT cycle_id, beneficiary_institution_id FROM freehold.network_obligations
        WHERE cycle_id IS NOT NULL AND status IN ('IN_CYCLE','SETTLED')
      ) ends ON ends.cycle_id=o.cycle_id AND ends.institution_id IN (o.origin_institution_id, o.beneficiary_institution_id)
      WHERE o.status IN ('IN_CYCLE','SETTLED') AND o.cycle_id IS NOT NULL
      GROUP BY o.cycle_id, ends.institution_id)
      SELECT coalesce(p.cycle_id, g.cycle_id) AS "cycleId", coalesce(p.institution_id, g.institution_id) AS "institutionId",
        p.gross_outgoing_minor::text AS "storedOutMinor", g.gross_out::text AS "reconstructedOutMinor",
        p.net_minor::text AS "storedNetMinor", (g.gross_in - g.gross_out)::text AS "reconstructedNetMinor"
      FROM freehold.network_cycle_positions p
      FULL JOIN gross g ON g.cycle_id=p.cycle_id AND g.institution_id=p.institution_id
      JOIN freehold.network_cycles c ON c.id=coalesce(p.cycle_id, g.cycle_id)
      WHERE (c.status='FINALIZED' AND (
          p.cycle_id IS NULL OR g.cycle_id IS NULL
          OR p.gross_outgoing_minor::numeric IS DISTINCT FROM g.gross_out
          OR p.gross_incoming_minor::numeric IS DISTINCT FROM g.gross_in
          OR p.net_minor::numeric IS DISTINCT FROM (g.gross_in - g.gross_out)))
        OR (c.status IS DISTINCT FROM 'FINALIZED' AND p.cycle_id IS NOT NULL)`],
    ['NETWORK_OBLIGATION_ONCE', `SELECT payment_id AS "paymentId", count(*)::int AS "obligationCount"
      FROM freehold.network_obligations GROUP BY payment_id HAVING count(*) > 1
      UNION ALL
      SELECT o.payment_id, 1 FROM freehold.network_obligations o
      JOIN freehold.network_payments p ON p.id=o.payment_id
      WHERE o.cycle_id IS NOT NULL AND p.cycle_id IS NOT NULL AND o.cycle_id IS DISTINCT FROM p.cycle_id`],
    ['NETWORK_INELIGIBLE_INCLUDED', `SELECT o.id AS "obligationId", o.payment_id AS "paymentId", o.status
      FROM freehold.network_obligations o
      JOIN freehold.network_cycles c ON c.id=o.cycle_id
      JOIN freehold.network_payments p ON p.id=o.payment_id
      WHERE c.status='FINALIZED' AND (NOT o.eligible OR o.status IN ('CANCELED','EXCLUDED') OR p.state IN ('CANCELLED','REJECTED'))`],
    ['NETWORK_OPEN_OBLIGATION', `SELECT id AS "obligationId" FROM freehold.network_obligations WHERE status='OPEN' AND cycle_id IS NOT NULL`],
    ['NETWORK_FINAL_JOURNAL', `SELECT p.id AS "paymentId", p.state
      FROM freehold.network_payments p
      WHERE p.state IN ('FINAL','REVERSED_BY_NEW_OPERATION') AND (
        p.origin_journal_id IS NULL OR p.beneficiary_journal_id IS NULL
        OR p.finality IS DISTINCT FROM 'SIMULATED_NET_FINAL'
        OR p.finality_mechanism IS DISTINCT FROM 'SIMULATED_NET_SETTLEMENT_NOT_EXTERNAL'
        OR NOT p.simulated_confirmation
        OR NOT EXISTS (
          SELECT 1 FROM freehold.institution_journals j
          JOIN freehold.institution_entries e ON e.journal_id=j.id
          WHERE j.id=p.origin_journal_id AND j.institution_id=p.origin_institution_id
            AND j.idempotency_key='netfinal:'||p.id::text||':origin' AND j.currency_code=p.currency_code
          GROUP BY j.id
          HAVING count(*) FILTER (WHERE e.account_id=p.origin_account_id AND e.side='DEBIT' AND e.amount_minor=p.amount_minor)=1
            AND count(*) FILTER (WHERE e.side='CREDIT' AND e.amount_minor=p.amount_minor)=1
            AND coalesce(sum(e.amount_minor) FILTER (WHERE e.side='DEBIT'),0)=coalesce(sum(e.amount_minor) FILTER (WHERE e.side='CREDIT'),0))
        OR NOT EXISTS (
          SELECT 1 FROM freehold.institution_journals j
          JOIN freehold.institution_entries e ON e.journal_id=j.id
          JOIN freehold.institution_ledger_accounts a ON a.id=e.account_id AND a.kind='SETTLEMENT_RECEIVABLE' AND a.institution_id=p.beneficiary_institution_id
          WHERE j.id=p.beneficiary_journal_id AND j.institution_id=p.beneficiary_institution_id
            AND j.idempotency_key='netfinal:'||p.id::text||':beneficiary' AND j.currency_code=p.currency_code
            AND e.side='DEBIT' AND e.amount_minor=p.amount_minor)
        OR NOT EXISTS (
          SELECT 1 FROM freehold.institution_entries e
          WHERE e.journal_id=p.beneficiary_journal_id AND e.account_id=p.beneficiary_account_id AND e.side='CREDIT' AND e.amount_minor=p.amount_minor)
        OR (p.state='REVERSED_BY_NEW_OPERATION' AND (
          p.reversal_origin_journal_id IS NULL OR p.reversal_beneficiary_journal_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM freehold.institution_journals j WHERE j.id=p.reversal_origin_journal_id AND j.idempotency_key='netreverse:'||p.id::text||':origin')
          OR NOT EXISTS (SELECT 1 FROM freehold.institution_journals j WHERE j.id=p.reversal_beneficiary_journal_id AND j.idempotency_key='netreverse:'||p.id::text||':beneficiary')
          OR NOT EXISTS (SELECT 1 FROM freehold.institution_journals j WHERE j.id=p.origin_journal_id))))`],
    ['NETWORK_PREMATURE_JOURNAL', `SELECT p.id AS "paymentId", p.state
      FROM freehold.network_payments p
      WHERE p.state NOT IN ('FINAL','REVERSED_BY_NEW_OPERATION') AND (
        p.origin_journal_id IS NOT NULL OR p.beneficiary_journal_id IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM freehold.institution_journals j
          WHERE j.idempotency_key IN ('netfinal:'||p.id::text||':origin','netfinal:'||p.id::text||':beneficiary')))`],
    ['NETWORK_MEMBER_ELIGIBILITY', `SELECT p.id AS "paymentId", p.state
      FROM freehold.network_payments p
      JOIN freehold.network_members mo ON mo.institution_id=p.origin_institution_id
      JOIN freehold.network_members mb ON mb.institution_id=p.beneficiary_institution_id
      WHERE p.state IN ('CREATED','VALIDATED','CLEARED','NETTED','SETTLEMENT_PENDING','SETTLEMENT_SUBMITTED','SETTLEMENT_CONFIRMED')
        AND (mo.status IS DISTINCT FROM 'ACTIVE_SIMULATION' OR mb.status IS DISTINCT FROM 'ACTIVE_SIMULATION')`],
    ['NETWORK_RULEBOOK', `SELECT m.institution_id AS "institutionId", m.status
      FROM freehold.network_members m
      WHERE m.status='ACTIVE_SIMULATION' AND (
        m.rulebook_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM freehold.network_rulebook_acceptances a
          JOIN freehold.network_rulebooks b ON b.id=a.rulebook_id
          WHERE a.institution_id=m.institution_id AND a.rulebook_id=m.rulebook_id AND b.status='ADOPTED'
            AND NOT b.enforceable_clearing_agreement AND b.simulation_only)
        OR NOT EXISTS (
          SELECT 1 FROM freehold.network_member_audit a
          WHERE a.institution_id=m.institution_id AND a.action='MEMBER_TRANSITION' AND a.to_status='ACTIVE_SIMULATION'))`],
    ['NETWORK_LIVE_AUTHORIZED', `SELECT id AS "objectId", 'member' AS kind FROM freehold.network_members WHERE live_authorized OR licensed_claim OR NOT simulation_only
      UNION ALL
      SELECT id, 'payment' FROM freehold.network_payments WHERE live_submission OR external_settlement
      UNION ALL
      SELECT id, 'instruction' FROM freehold.network_settlement_instructions WHERE external_settlement
      UNION ALL
      SELECT id, 'rulebook' FROM freehold.network_rulebooks WHERE enforceable_clearing_agreement OR NOT simulation_only`],
    ['NETWORK_PARTIAL_CYCLE', `SELECT c.id AS "cycleId", c.failure_reason AS "failureReason"
      FROM freehold.network_cycles c
      WHERE c.status='FAILED' AND (
        EXISTS (SELECT 1 FROM freehold.network_cycle_positions p WHERE p.cycle_id=c.id)
        OR EXISTS (SELECT 1 FROM freehold.network_obligations o WHERE o.cycle_id=c.id AND o.status='IN_CYCLE')
        OR EXISTS (SELECT 1 FROM freehold.network_payments p WHERE p.cycle_id=c.id AND p.state='CLEARED'))`],
    ['NETWORK_INSTRUCTION', `SELECT c.id AS "cycleId"
      FROM freehold.network_cycles c
      WHERE c.status='FINALIZED' AND (
        (SELECT count(*) FROM freehold.network_settlement_instructions i WHERE i.cycle_id=c.id)
        IS DISTINCT FROM (SELECT count(*) FROM freehold.network_cycle_positions p WHERE p.cycle_id=c.id))
      UNION ALL
      SELECT cycle_id FROM freehold.network_settlement_instructions
      WHERE (state IN ('FINAL','CONFIRMED_SIMULATED') AND NOT confirmation_simulated)
        OR (state='FINAL' AND NOT EXISTS (
          SELECT 1 FROM freehold.network_payments p WHERE p.cycle_id=network_settlement_instructions.cycle_id
            AND p.state IN ('FINAL','REVERSED_BY_NEW_OPERATION')))`],
    ['NETWORK_CURRENCY', `SELECT o.id AS "obligationId"
      FROM freehold.network_obligations o
      JOIN freehold.network_payments p ON p.id=o.payment_id
      WHERE o.currency_code IS DISTINCT FROM p.currency_code
      UNION ALL
      SELECT p.cycle_id FROM freehold.network_cycle_positions p
      JOIN freehold.network_cycles c ON c.id=p.cycle_id
      WHERE p.currency_code IS DISTINCT FROM c.currency_code
      UNION ALL
      SELECT o.cycle_id FROM freehold.network_obligations o
      JOIN freehold.network_cycles c ON c.id=o.cycle_id
      WHERE o.currency_code IS DISTINCT FROM c.currency_code`],
    ['NETWORK_WEBHOOK', `SELECT e.id AS "eventId", e.institution_id AS "institutionId"
      FROM freehold.institution_webhook_events e
      WHERE e.event_type='network.payment.final' AND (
        coalesce(e.body->>'state','') IS DISTINCT FROM 'FINAL'
        OR coalesce(e.body->>'simulated','') IS DISTINCT FROM 'true'
        OR coalesce(e.body->>'externalSettlement','') IS DISTINCT FROM 'false'
        OR coalesce(e.body->>'finality','') IS DISTINCT FROM 'SIMULATED_NET_FINAL')`],
    ['NETWORK_MESSAGE', `SELECT id AS "messageRowId", family FROM freehold.network_messages
      WHERE position(family IN body)=0 OR position(message_id IN body)=0
        OR family NOT IN ('pain.001.001.09','pacs.008.001.08','pacs.002.001.10','pacs.004.001.09','camt.053.001.08')`],
    ['NETWORK_DUPLICATE_REFERENCE', `SELECT origin_institution_id AS "originInstitutionId", idempotency_key AS "idempotencyKey", count(*)::int AS "paymentCount"
      FROM freehold.network_payments GROUP BY origin_institution_id, idempotency_key HAVING count(*)>1`],
    ['NETWORK_RISK_MUTATED', `SELECT id AS "riskRunId" FROM freehold.network_risk_runs WHERE mutated_accounts OR invented_funding OR regulatory_determination`],
  ];
  for (const [code, sql] of queries) {
    const result = await client.query(`${sql} LIMIT ${MAX_EVIDENCE + 1}`);
    for (const row of result.rows) mark(code, row);
  }
  const signed = await client.query(`SELECT p.id AS "paymentId",
      p.origin_institution_id AS "originInstitutionId", p.beneficiary_institution_id AS "beneficiaryInstitutionId",
      p.origin_account_id AS "originAccountId", p.beneficiary_account_id AS "beneficiaryAccountId",
      p.currency_code AS currency, p.amount_minor::text AS "amountMinor", p.idempotency_key AS "idempotencyKey",
      p.purpose, p.payload_sha256 AS "payloadSha256", p.signature_hex AS "signatureHex",
      c.public_key_hex AS "publicKeyHex", c.revoked_at AS "revokedAt", c.not_before AS "notBefore", c.not_after AS "notAfter",
      p.created_at AS "createdAt"
    FROM freehold.network_payments p
    LEFT JOIN freehold.network_certificates c ON c.id=p.certificate_id`);
  for (const row of signed.rows) {
    const payload = networkPayload(row);
    const hash = createHash('sha256').update(payload, 'utf8').digest('hex');
    if (hash !== row.payloadSha256) mark('NETWORK_PAYLOAD_HASH', { paymentId: row.paymentId });
    const createdAt = instant(row.createdAt);
    const notBefore = instant(row.notBefore);
    const notAfter = instant(row.notAfter);
    const revokedAt = row.revokedAt ? instant(row.revokedAt) : null;
    const validAtCreation = Number.isFinite(notBefore) && Number.isFinite(notAfter) && notBefore <= createdAt && createdAt < notAfter
      && (revokedAt === null || revokedAt > createdAt);
    if (!validAtCreation || !networkSignatureOk(row.publicKeyHex, payload, row.signatureHex)) {
      mark('NETWORK_SIGNATURE', { paymentId: row.paymentId });
    }
  }
  const unsettled = await client.query(`SELECT count(*)::text AS n FROM freehold.network_obligations WHERE status IN ('OPEN','IN_CYCLE')`);
  report.network = {
    present: true,
    claimsOutcome: networkDefects === 0 ? 'NETWORK_CLAIMS_VERIFIED' : 'MISMATCH',
    externalSettlement: 'EXTERNAL_SETTLEMENT_UNAVAILABLE',
    balancedInternalPositionIsExternalSettlement: false,
    simulatedConfirmationIsFinal: false,
    nettingStoredState: 'SETTLEMENT_PENDING_WITH_POSITION_ROWS',
    unsettledObligations: unsettled.rows[0].n,
    defects: networkDefects,
  };
}

async function verifyProgram(client, report, issue) {
  const mark = (code, evidence) => issue(report.accountingViolations, code, evidence);
  const before = report.accountingViolations.length;
  const queries = [
    ['PROGRAM_LIVE', `SELECT id AS "assetId" FROM freehold.program_assets WHERE live_authorized OR NOT simulation_only OR external_evidence IS DISTINCT FROM 'EXTERNAL_EVIDENCE_UNAVAILABLE' OR valuation_source IS DISTINCT FROM 'SIMULATED_INTERNAL'`],
    ['PROGRAM_POLICY_HASH', `SELECT id AS "policyId" FROM freehold.program_policies WHERE snapshot_hash IS NOT NULL AND snapshot_hash IS DISTINCT FROM encode(public.digest(convert_to(body::text, 'UTF8'), 'sha256'), 'hex')`],
    ['PROGRAM_POLICY_PRECEDENCE', `SELECT a.id AS "policyId", b.id AS "otherPolicyId" FROM freehold.program_policies a JOIN freehold.program_policies b ON a.id < b.id AND a.institution_id = b.institution_id AND a.domain = b.domain AND a.precedence = b.precedence AND a.status = 'APPROVED' AND b.status = 'APPROVED' AND a.effective_from < b.effective_until AND b.effective_from < a.effective_until AND a.effective_from <= now() AND a.effective_until > now() AND b.effective_from <= now() AND b.effective_until > now()`],
    ['PROGRAM_DEFINITION_HASH', `SELECT id AS "workflowId" FROM freehold.program_workflows WHERE definition_hash IS DISTINCT FROM encode(public.digest(convert_to(definition::text, 'UTF8'), 'sha256'), 'hex')`],
    ['PROGRAM_POLICY_PIN', `SELECT w.id AS "workflowId" FROM freehold.program_workflows w LEFT JOIN freehold.program_policies p ON p.id = w.policy_id WHERE w.status IN ('APPROVED','SCHEDULED','EXECUTING','COMPLETED','FAILED','EXPIRED','UNKNOWN') AND (w.policy_snapshot_hash IS NULL OR p.id IS NULL OR p.snapshot_hash IS DISTINCT FROM w.policy_snapshot_hash)`],
    ['PROGRAM_PARTIAL', `SELECT e.id AS "executionId", l.id AS "legId" FROM freehold.program_executions e JOIN freehold.program_legs l ON l.execution_id = e.id WHERE e.state = 'COMPLETED' AND e.atomicity = 'SINGLE_DATABASE' AND l.kind IN ('TRANSFER','HOLD','RELEASE','RETURN','REVERSAL','SETTLEMENT') AND (l.state <> 'POSTED' OR l.journal_id IS NULL OR NOT EXISTS (SELECT 1 FROM freehold.institution_entries en WHERE en.journal_id = l.journal_id GROUP BY en.journal_id HAVING sum(CASE WHEN en.side = 'DEBIT' THEN en.amount_minor ELSE -en.amount_minor END) = 0 AND count(*) = 2))`],
    ['PROGRAM_UNKNOWN_POSTED', `SELECT e.id AS "executionId" FROM freehold.program_executions e JOIN freehold.program_legs l ON l.execution_id = e.id WHERE e.state = 'UNKNOWN' AND l.journal_id IS NOT NULL`],
    ['PROGRAM_EXPIRED_POSTED', `SELECT e.id AS "executionId" FROM freehold.program_executions e JOIN freehold.program_legs l ON l.execution_id = e.id WHERE e.state = 'EXPIRED' AND l.journal_id IS NOT NULL`],
    ['PROGRAM_ESCROW_DOUBLE', `SELECT id AS "escrowId" FROM freehold.program_escrows WHERE released_minor > reserved_minor OR (status IN ('RELEASED','RETURNED') AND (release_journal_id IS NULL OR released_minor <> reserved_minor OR released_by IS NULL)) OR (status IN ('FUNDED','DISPUTED','EXPIRED','CANCELLED') AND (released_minor <> 0 OR release_journal_id IS NOT NULL))`],
    ['PROGRAM_ESCROW_JOURNAL', `SELECT e.id AS "escrowId" FROM freehold.program_escrows e WHERE (e.fund_journal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM freehold.institution_entries en WHERE en.journal_id = e.fund_journal_id GROUP BY en.journal_id HAVING sum(CASE WHEN en.side = 'DEBIT' THEN en.amount_minor ELSE -en.amount_minor END) = 0)) OR (e.release_journal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM freehold.institution_entries en WHERE en.journal_id = e.release_journal_id GROUP BY en.journal_id HAVING sum(CASE WHEN en.side = 'DEBIT' THEN en.amount_minor ELSE -en.amount_minor END) = 0))`],
    ['PROGRAM_TREASURY_SPLIT', `SELECT id AS "treasuryId" FROM freehold.program_treasury WHERE (kind = 'RECOMMENDATION' AND journal_id IS NOT NULL) OR (kind = 'EXECUTED' AND (journal_id IS NULL OR executed_by IS NULL OR recommendation_id IS NULL)) OR (movement IN ('QUEUE_PRIORITY','CONCENTRATION_ALERT','REDEMPTION_FORECAST','CASHFLOW_PROJECTION') AND kind <> 'RECOMMENDATION') OR (kind = 'EXECUTED' AND journal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM freehold.institution_entries en WHERE en.journal_id = program_treasury.journal_id GROUP BY en.journal_id HAVING sum(CASE WHEN en.side = 'DEBIT' THEN en.amount_minor ELSE -en.amount_minor END) = 0))`],
    ['PROGRAM_FUSD_SUPPLY', `SELECT id AS "requestId" FROM freehold.program_issuance_requests WHERE changes_supply OR monetary_journal_id IS NOT NULL`],
    ['PROGRAM_ASSET_SUPPLY', `SELECT a.id AS "assetId" FROM freehold.program_assets a WHERE a.supply_minor IS DISTINCT FROM COALESCE((SELECT sum(CASE WHEN j.kind = 'ISSUE' THEN j.quantity_minor WHEN j.kind IN ('REDEEM','RETIRE') THEN -j.quantity_minor ELSE 0 END) FROM freehold.program_asset_journals j WHERE j.asset_id = a.id), 0)`],
    ['PROGRAM_ASSET_POSITION', `WITH moves AS (SELECT asset_id, holder, sum(avail) AS avail, sum(held) AS held, sum(pledged) AS pledged FROM (SELECT asset_id, to_holder AS holder, quantity_minor AS avail, 0::bigint AS held, 0::bigint AS pledged FROM freehold.program_asset_journals WHERE kind = 'ISSUE' UNION ALL SELECT asset_id, from_holder, -quantity_minor, 0, 0 FROM freehold.program_asset_journals WHERE kind = 'TRANSFER' UNION ALL SELECT asset_id, to_holder, quantity_minor, 0, 0 FROM freehold.program_asset_journals WHERE kind = 'TRANSFER' UNION ALL SELECT asset_id, from_holder, -quantity_minor, quantity_minor, 0 FROM freehold.program_asset_journals WHERE kind = 'HOLD' UNION ALL SELECT asset_id, from_holder, quantity_minor, -quantity_minor, 0 FROM freehold.program_asset_journals WHERE kind = 'RELEASE' UNION ALL SELECT asset_id, from_holder, -quantity_minor, 0, quantity_minor FROM freehold.program_asset_journals WHERE kind = 'PLEDGE' UNION ALL SELECT asset_id, from_holder, quantity_minor, 0, -quantity_minor FROM freehold.program_asset_journals WHERE kind = 'UNPLEDGE' UNION ALL SELECT asset_id, from_holder, -quantity_minor, 0, 0 FROM freehold.program_asset_journals WHERE kind IN ('REDEEM','RETIRE')) m WHERE holder IS NOT NULL GROUP BY asset_id, holder) SELECT COALESCE(p.asset_id, moves.asset_id) AS "assetId", COALESCE(p.holder_institution_id, moves.holder) AS "holderId" FROM freehold.program_asset_positions p FULL JOIN moves ON moves.asset_id = p.asset_id AND moves.holder = p.holder_institution_id WHERE COALESCE(p.available_minor, 0) IS DISTINCT FROM COALESCE(moves.avail, 0) OR COALESCE(p.held_minor, 0) IS DISTINCT FROM COALESCE(moves.held, 0) OR COALESCE(p.pledged_minor, 0) IS DISTINCT FROM COALESCE(moves.pledged, 0)`],
    ['PROGRAM_COLLATERAL', `WITH encumbered AS (SELECT asset_id, pledgor_institution_id, sum(quantity_minor) AS qty FROM freehold.program_collateral WHERE status IN ('PLEDGED','DEFAULTED_SIMULATION') GROUP BY asset_id, pledgor_institution_id) SELECT COALESCE(e.asset_id, p.asset_id) AS "assetId", COALESCE(e.pledgor_institution_id, p.holder_institution_id) AS "holderId" FROM encumbered e FULL JOIN freehold.program_asset_positions p ON p.asset_id = e.asset_id AND p.holder_institution_id = e.pledgor_institution_id WHERE COALESCE(e.qty, 0) IS DISTINCT FROM COALESCE(p.pledged_minor, 0)`],
    ['PROGRAM_QUOTE_TRADE', `SELECT q.id AS "quoteId" FROM freehold.program_quotes q LEFT JOIN freehold.program_trades t ON t.quote_id = q.id WHERE (q.status = 'EXECUTED' AND t.id IS NULL) OR (q.kind = 'INDICATIVE' AND q.status = 'EXECUTED') OR (t.id IS NOT NULL AND (t.unit_price_minor <> q.unit_price_minor OR t.quantity_minor <> q.quantity_minor OR q.status <> 'EXECUTED'))`],
    ['PROGRAM_EXCHANGE_JOURNALS', `SELECT t.id AS "tradeId" FROM freehold.program_trades t WHERE NOT EXISTS (SELECT 1 FROM freehold.program_asset_journals j WHERE j.id = t.base_journal_id AND j.kind = 'TRANSFER' AND j.quantity_minor = t.quantity_minor) OR NOT EXISTS (SELECT 1 FROM freehold.program_asset_journals j WHERE j.id = t.quote_journal_id AND j.kind = 'TRANSFER' AND j.quantity_minor = t.quantity_minor * t.unit_price_minor)`],
    ['PROGRAM_COORDINATED', `SELECT e.id AS "executionId" FROM freehold.program_executions e WHERE e.atomicity = 'COORDINATED_NOT_ATOMIC' AND (e.state IS DISTINCT FROM 'UNKNOWN' OR EXISTS (SELECT 1 FROM freehold.program_legs l WHERE l.execution_id = e.id AND (l.journal_id IS NOT NULL OR l.state IS DISTINCT FROM 'AWAITING_EXTERNAL')))`],
    ['PROGRAM_AUDIT', `SELECT e.id AS "executionId" FROM freehold.program_executions e WHERE e.state = 'COMPLETED' AND NOT EXISTS (SELECT 1 FROM freehold.program_audit a WHERE a.object_id = e.id AND a.action IN ('WORKFLOW_EXECUTE','SETTLE_ATOMIC'))`],
  ];
  for (const [code, sql] of queries) {
    const result = await client.query(`${sql} LIMIT ${MAX_EVIDENCE + 1}`);
    for (const row of result.rows) mark(code, row);
  }
  const programDefects = report.accountingViolations.slice(before).filter(row => String(row.code).startsWith('PROGRAM_')).length;
  report.program = {
    present: true,
    externalEvidence: 'EXTERNAL_EVIDENCE_UNAVAILABLE',
    internalAccountingProvesExternalClaim: false,
    legalEscrow: false,
    distributedAtomicity: false,
    liveIssuance: false,
    defects: programDefects,
  };
}
