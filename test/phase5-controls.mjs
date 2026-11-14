import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';

const admin = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
const api = new Client({ connectionString: process.env.DATABASE_URL });
const api2 = new Client({ connectionString: process.env.DATABASE_URL });
const auth = new Client({ connectionString: process.env.AUTH_DATABASE_URL });

const bind = async (userId, twoFactor = null) => {
  const secret = randomBytes(32);
  await admin.query('SELECT freehold.auth_bind_session($1::uuid,1,$2::bytea,$3::timestamptz,3600)', [userId, secret, twoFactor]);
  return secret.toString('hex');
};
const call = async (client, secret, sql, args) => {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('freehold.session_secret',$1,true)`, [secret]);
    const row = (await client.query(sql, args)).rows[0];
    await client.query('COMMIT');
    return row;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* keep the original database error */ }
    throw error;
  }
};

test('transaction limits, statements, and session binding hold on a disposable ledger', async () => {
  await Promise.all([admin.connect(), api.connect(), api2.connect(), auth.connect()]);
  const institution = randomUUID();
  const reviewer = randomUUID();
  const customer = randomUUID();
  const peer = randomUUID();
  const source = randomUUID();
  const destination = randomUUID();
  const jpy = randomUUID();
  const kwd = randomUUID();
  const hash = 'phase5-unused-password-hash';
  try {
    await admin.query('UPDATE freehold.ledger_settings SET sandbox_enabled=true WHERE singleton');
    await admin.query(`INSERT INTO freehold.users(id,email_normalized,password_hash,role) VALUES
      ($1,$2,$5,'ADMIN'),($3,$4,$5,'ADMIN'),($6,$7,$5,'USER'),($8,$9,$5,'USER')`,
      [institution, `p5-inst-${institution}@example.test`, reviewer, `p5-rev-${reviewer}@example.test`, hash, customer, `p5-cus-${customer}@example.test`, peer, `p5-peer-${peer}@example.test`]);
    await admin.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)', [institution, 'INSTITUTION_ADMIN', 'phase5 policy initiator']);
    await admin.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)', [reviewer, 'FINANCIAL_REVIEWER', 'phase5 policy approver']);
    await admin.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)', [institution, 'AUDITOR', 'phase5 report reader']);
    await admin.query('BEGIN');
    await admin.query(`INSERT INTO freehold.accounts(id,owner_user_id,currency_code) VALUES
      ($1,$2,'USD'),($3,$4,'USD'),($5,$2,'JPY'),($6,$2,'KWD')`, [source, customer, destination, peer, jpy, kwd]);
    await admin.query('COMMIT');
    const secret = await bind(customer);
    await assert.rejects(api.query('SELECT freehold.execute_internal_transfer($1,$2,$3,$4,1,$5,$6)', [customer, source, destination, 'USD', randomUUID(), randomUUID()]), { code: '42501' });
    await assert.rejects(auth.query('SELECT id FROM freehold.accounts'), { code: '42501' });
    await assert.rejects(auth.query('SELECT freehold.execute_internal_transfer($1,$2,$3,$4,1,$5,$6)', [customer, source, destination, 'USD', randomUUID(), randomUUID()]), { code: '42501' });

    await admin.query('SELECT freehold.sandbox_fund_account($1,$2,100,$3,$4,$5)', [institution, source, `p5-fund-${randomUUID()}`, 'phase5 usd', randomUUID()]);
    const policyKey = `p5-daily-${randomUUID()}`;
    const created = (await admin.query('SELECT freehold.governance_create_risk_policy_request($1,$2::jsonb,$3,$4) AS request',
      [institution, JSON.stringify({ scope: 'ACCOUNT', accountId: source, ruleCode: 'DAILY_OUTGOING_LIMIT', enabled: true, thresholdMinor: '10', timezone: 'UTC' }), 'Cap this account at 10 minor units per UTC day', policyKey])).rows[0].request;
    await admin.query(`SELECT freehold.governance_decide($1,$2,'APPROVE')`, [reviewer, created.requestId]);
    const executed = (await admin.query('SELECT freehold.governance_execute($1,$2,$3,$4) AS result', [institution, created.requestId, policyKey, randomUUID()])).rows[0].result;
    assert.equal(executed.status, 'EXECUTED');
    await assert.rejects(admin.query('SELECT freehold.governance_create_risk_policy_request($1,$2::jsonb,$3,$4)',
      [institution, JSON.stringify({ scope: 'INSTITUTION', ruleCode: 'DAILY_OUTGOING_LIMIT', enabled: true, thresholdMinor: '10', timezone: 'America/New_York' }), 'reject non-UTC', randomUUID()]),
      error => error.code === '22023' && error.message === 'INVALID_RISK_POLICY');

    const transfer = (client, amount, key) => call(client, secret,
      'SELECT freehold.execute_internal_transfer($1,$2,$3,$4,$5::bigint,$6,$7) AS result',
      [customer, source, destination, 'USD', amount, key, randomUUID()]);
    const [first, second] = await Promise.all([transfer(api, '6', `p5-a-${randomUUID()}`), transfer(api2, '6', `p5-b-${randomUUID()}`)]);
    const states = [first.result, second.result];
    assert.equal(states.filter(result => result.state === 'COMPLETED').length, 1);
    assert.equal(states.filter(result => result.state === 'REJECTED' && result.error === 'LIMIT_DAILY_OUTGOING').length, 1);
    const completed = (await admin.query(`SELECT coalesce(sum(amount_minor),0)::text AS amount FROM freehold.transfers
      WHERE source_account_id=$1 AND state='COMPLETED' AND created_at > clock_timestamp() - interval '10 minutes'`, [source])).rows[0].amount;
    assert.equal(completed, '6');
    const within = (await transfer(api, '4', `p5-c-${randomUUID()}`)).result;
    assert.equal(within.state, 'COMPLETED', JSON.stringify(within));

    const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const beforeJournals = (await admin.query('SELECT count(*)::text AS count FROM freehold.ledger_journals')).rows[0].count;
    const statement = (await call(api, secret,
      'SELECT freehold.account_statement($1,$2,$3,$4,100,NULL,NULL) AS statement',
      [customer, source, from, to])).statement;
    assert.equal(statement.currency, 'USD');
    assert.equal(statement.minorUnitExponent, 2);
    assert.equal(BigInt(statement.closingAvailableMinor) - BigInt(statement.openingAvailableMinor), BigInt(statement.creditAvailableMinor) - BigInt(statement.debitAvailableMinor));
    const afterJournals = (await admin.query('SELECT count(*)::text AS count FROM freehold.ledger_journals')).rows[0].count;
    assert.equal(afterJournals, beforeJournals);
    await assert.rejects(call(api, secret, 'SELECT freehold.account_statement($1,$2,$3,$4,100,NULL,NULL)', [peer, source, from, to]), { code: '42501' });

    const previousMax = (await admin.query('SELECT max_operation_minor::text AS max FROM freehold.ledger_settings')).rows[0].max;
    await admin.query('UPDATE freehold.ledger_settings SET max_operation_minor=9223372036854775807');
    try {
      const huge = '9007199254740993';
      await admin.query('SELECT freehold.sandbox_fund_account($1,$2,$3::bigint,$4,$5,$6)', [institution, jpy, huge, `p5-jpy-${randomUUID()}`, 'phase5 jpy', randomUUID()]);
      await admin.query('SELECT freehold.sandbox_fund_account($1,$2,1000,$3,$4,$5)', [institution, kwd, `p5-kwd-${randomUUID()}`, 'phase5 kwd', randomUUID()]);
      const yen = (await call(api, secret, 'SELECT freehold.account_statement($1,$2,$3,$4,20,NULL,NULL) AS statement', [customer, jpy, from, to])).statement;
      const dinar = (await call(api, secret, 'SELECT freehold.account_statement($1,$2,$3,$4,20,NULL,NULL) AS statement', [customer, kwd, from, to])).statement;
      assert.equal(yen.minorUnitExponent, 0);
      assert.equal(yen.closingAvailableMinor, huge);
      assert.equal(dinar.minorUnitExponent, 3);
      assert.equal(dinar.closingAvailableMinor, '1000');
      assert.notEqual(yen.currency, dinar.currency);
    } finally {
      await admin.query('UPDATE freehold.ledger_settings SET max_operation_minor=$1::bigint', [previousMax]);
    }
    const emptyFrom = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const emptyTo = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const empty = (await call(api, secret, 'SELECT freehold.account_statement($1,$2,$3,$4,20,NULL,NULL) AS statement', [customer, source, emptyFrom, emptyTo])).statement;
    assert.equal(empty.lines.length, 0);
    assert.equal(empty.openingAvailableMinor, empty.closingAvailableMinor);
    const report = (await admin.query('SELECT freehold.institutional_report($1) AS report', [institution])).rows[0].report;
    const currencies = new Set(report.liabilities.map(row => row.currency));
    assert.ok(currencies.has('USD') && currencies.has('JPY') && currencies.has('KWD'));
    assert.equal(report.fundingRatio, undefined);
    assert.equal(report.externalAssets.status, 'UNAVAILABLE');
    assert.equal(report.liabilities.some(row => row.currency === 'JPY' && row.customerLiabilityMinor === '9007199254740993'), true);
  } finally {
    await Promise.all([admin.end(), api.end(), api2.end(), auth.end()]);
  }
});
