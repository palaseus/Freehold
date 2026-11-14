#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { LEDGER_VERIFIER_VERSION, verifyLedger } from './lib/ledger-verifier.mjs';

const connectionString = process.env.VERIFY_DATABASE_URL;
const outputIndex = process.argv.indexOf('--out');
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
const timeoutMs = Number(process.env.VERIFY_STATEMENT_TIMEOUT_MS ?? 300000);
const errorReport = (code, message) => ({
  reportType: 'freehold.independent-ledger-verification', verificationRunId: randomUUID(),
  algorithmVersion: LEDGER_VERIFIER_VERSION, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
  database: null, schemaMigrationVersion: null,
  snapshot: { isolation: 'REPEATABLE READ', readOnly: true, startsAt: null },
  counts: { accounts: 0, journalEntries: 0, operations: 0, journals: 0, governanceRequests: 0 },
  perCurrencyTotals: [], projectionDiscrepancies: [], referentialIntegrityViolations: [],
  idempotencyInconsistencies: [], accountingViolations: [], operationalEventViolations: [], governanceViolations: [],
  outcome: 'ERROR', error: { code, message }, evidenceTruncated: false, violationCount: 0,
});
let report;
if (!connectionString) {
  report = errorReport('CONFIGURATION','VERIFY_DATABASE_URL is required.');
} else {
  let client;
  try {
    const parsed = new URL(connectionString);
    if (decodeURIComponent(parsed.username) !== 'freehold_verifier') throw new Error('Verifier must connect as freehold_verifier.');
    client = new Client({ connectionString, application_name: 'freehold-independent-ledger-verifier' });
    await client.connect();
    report = await verifyLedger(client, { statementTimeoutMs: timeoutMs });
  } catch (error) {
    report = errorReport('CONNECTION_OR_CONFIGURATION',error?.message === 'Verifier must connect as freehold_verifier.' || error?.message === 'Verifier database grants do not match the reviewed read-only allowlist.' ? error.message : 'Verifier could not connect or complete; diagnostic details are restricted to process logs.');
  } finally { if (client) await client.end().catch(() => {}); }
}

const json = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, json, { mode: 0o600 });
else process.stdout.write(json);
if (report.outcome !== 'VERIFIED') process.exitCode = report.outcome === 'MISMATCH' ? 2 : report.outcome === 'INCOMPLETE' ? 3 : 4;
