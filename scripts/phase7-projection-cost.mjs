#!/usr/bin/env node
// Times direct execute_internal_transfer calls on a disposable database.
// Shows whether commit-time account checks get slower as one account's history grows.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { refuseEvidenceOverwrite } from './lib/evidence-output.mjs';
import { performance } from 'node:perf_hooks';
import pg from 'pg';

const url = process.env.PHASE7_ADMIN_URL;
const out = process.env.PHASE7_COST_OUT ?? 'docs/evidence/projection-cost-latest.json';
refuseEvidenceOverwrite(out);
if (!url || !/127\.0\.0\.1|localhost/.test(url) || !url.includes('disposable')) {
  throw new Error('Refusing a database that is not a loopback disposable cost probe');
}
const total = Number(process.env.PHASE7_COST_TRANSFERS ?? 2000);
if (!Number.isInteger(total) || total < 200 || total > 20000) throw new Error('PHASE7_COST_TRANSFERS must be 200..20000');
const client = new pg.Client({ connectionString: url });
await client.connect();
const admin = randomUUID();
const customer = randomUUID();
const payee = randomUUID();
const hash = '$argon2id$v=19$m=65536,t=3,p=4$cHJvdGVjdGlvbi1jb3N0$protection-cost-not-a-login';
await client.query('UPDATE freehold.ledger_settings SET sandbox_enabled=true WHERE singleton');
await client.query(
  `INSERT INTO freehold.users(id,email_normalized,password_hash,role) VALUES ($1,$2,$3,'ADMIN'),($4,$5,$3,'USER'),($6,$7,$3,'USER')`,
  [admin, `cost-admin-${admin}@example.test`, hash, customer, `cost-user-${customer}@example.test`, payee, `cost-payee-${payee}@example.test`],
);
await client.query('SELECT freehold.create_account($1,$2,$3,$4)', [customer, 'USD', `acct-${customer}`, randomUUID()]);
await client.query('SELECT freehold.create_account($1,$2,$3,$4)', [payee, 'USD', `acct-${payee}`, randomUUID()]);
const accounts = [
  (await client.query('SELECT id FROM freehold.accounts WHERE owner_user_id=$1', [customer])).rows[0].id,
  (await client.query('SELECT id FROM freehold.accounts WHERE owner_user_id=$1', [payee])).rows[0].id,
];
await client.query('SELECT freehold.sandbox_fund_account($1,$2,$3,$4,$5,$6)', [admin, accounts[0], 100000000, `fund-${randomUUID()}`, 'projection cost probe', randomUUID()]);
const batch = async (count) => {
  const started = performance.now();
  for (let i = 0; i < count; i += 1) {
    await client.query('SELECT freehold.execute_internal_transfer($1,$2,$3,$4,1,$5,$6)', [customer, accounts[0], accounts[1], 'USD', randomUUID(), randomUUID()]);
  }
  return Math.round((performance.now() - started) * 1000) / 1000;
};
const first = await batch(100);
const middleCount = Math.max(0, total - 200);
if (middleCount) await batch(middleCount);
const last = await batch(100);
const explain = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
  SELECT coalesce(sum(CASE WHEN la.bucket='AVAILABLE' THEN CASE e.side WHEN 'CREDIT' THEN e.amount_minor::numeric ELSE -e.amount_minor::numeric END ELSE 0 END),0)
  FROM freehold.ledger_accounts la
  LEFT JOIN freehold.ledger_entries e ON e.ledger_account_id=la.id
  WHERE la.customer_account_id=$1`, [accounts[0]]);
const latestJournal = (await client.query('SELECT id FROM freehold.ledger_journals ORDER BY recorded_at DESC LIMIT 1')).rows[0].id;
const deltaExplain = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
  SELECT coalesce(sum(e.amount_minor),0)
  FROM freehold.ledger_entries e
  JOIN freehold.ledger_accounts la ON la.id=e.ledger_account_id
  WHERE e.journal_id=$1 AND la.customer_account_id=$2`, [latestJournal, accounts[0]]);
const journals = (await client.query('SELECT count(*)::int AS n FROM freehold.ledger_journals')).rows[0].n;
const entries = (await client.query('SELECT count(*)::int AS n FROM freehold.ledger_entries WHERE ledger_account_id IN (SELECT id FROM freehold.ledger_accounts WHERE customer_account_id=$1)', [accounts[0]])).rows[0].n;
const report = {
  generatedAt: new Date().toISOString(),
  reportType: 'freehold.phase7-projection-cost',
  sourceRevision: 'unknown',
  signature: null,
  transfers: total,
  journals,
  sourceAccountEntries: entries,
  first100Ms: first,
  last100Ms: last,
  first100PerSecond: Math.round((100000 / first) * 1000) / 1000,
  last100PerSecond: Math.round((100000 / last) * 1000) / 1000,
  explain: explain.rows.map(row => row['QUERY PLAN']),
  deltaExplain: deltaExplain.rows.map(row => row['QUERY PLAN']),
};
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`PASS projection cost first100 ${first} ms last100 ${last} ms entries ${entries}`);
await client.end();
