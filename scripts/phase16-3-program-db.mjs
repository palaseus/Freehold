import { Client } from 'pg';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const env = {};
for (const line of readFileSync('/tmp/opencode/freehold-p162/env', 'utf8').split('\n')) {
  const m = line.replace(/^export\s+/, '').match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^'|'$/g, '');
}
const admin = new Client({ connectionString: env.TEST_DATABASE_ADMIN_URL });
await admin.connect();
const out = { timestamp: new Date().toISOString(), tests: [] };
const rec = (name, ok, detail) => { out.tests.push({ name, ok, detail }); console.log(`${ok?'OK':'FAIL'} ${name}`); };
const tag = Date.now().toString(36);
const du1 = randomUUID(), du2 = randomUUID(), du3 = randomUUID();
await admin.query("INSERT INTO freehold.users(id,email_normalized,password_hash,role,status,auth_version) VALUES ($1,$2,'$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$hashhashhashhashhashhashhashhashhashha','ADMIN','ACTIVE',1),($3,$4,'$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$hashhashhashhashhashhashhashhashhashha','ADMIN','ACTIVE',1),($5,$6,'$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$hashhashhashhashhashhashhashhashhashha','ADMIN','ACTIVE',1)", [du1,`p163pd1-${tag}@example.test`, du2,`p163pd2-${tag}@example.test`, du3,`p163pd3-${tag}@example.test`]);
const i1 = (await admin.query("SELECT freehold.institution_open($1::uuid,$2::text,$3::text) AS item",[du1,`p1${tag.slice(-4)}`,'Prog Inst One'])).rows[0].item.institutionId;
// grant du2 governance in i1 so can approve
await admin.query("SELECT freehold.institution_grant($1::uuid,$2::uuid,$3::uuid,$4::text)",[du1,i1,du2,'GOVERNANCE']).catch(()=>{});
const ca1 = (await admin.query("SELECT freehold.institution_customer_open($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item",[du1,i1,`ca1-${tag}`,'CA1','USD'])).rows[0].item.accountId;
const ca2 = (await admin.query("SELECT freehold.institution_customer_open($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item",[du1,i1,`ca2-${tag}`,'CA2','USD'])).rows[0].item.accountId;
await admin.query("SELECT freehold.institution_fund_simulated($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::uuid)",[du1,i1,ca1,10000n,`fund-${tag}`,randomUUID()]);

function policyBody(domain, max, currency='USD') {
  return { language:'fh-policy-1', domain, maxExposureMinor:String(max), currency, currencies:[currency] };
}
async function setupPolicy(domain) {
  const body = policyBody(domain, '1000000');
  const pol = (await admin.query("SELECT freehold.program_policy_draft($1::uuid,$2::uuid,$3::text,$4::jsonb,$5::integer,$6::bigint,$7::text,$8::timestamptz,$9::timestamptz) AS item",[du1,i1,domain,body,10,1000000n,'USD',new Date(Date.now()-60000).toISOString(),new Date(Date.now()+86400000).toISOString()])).rows[0].item;
  const appr = await admin.query("SELECT freehold.program_policy_approve($1::uuid,$2::uuid) AS item",[du2,pol.policyId]).catch(async e => {
    // try du1 if du2 not member? grant may have failed; try approving as du1 after making du1 not creator? impossible. create via du3?
    return { error: e.message, code: e.code, where: e.where };
  });
  return { pol, appr: appr.error ? appr : appr.rows[0].item };
}
const pSettle = await setupPolicy('SETTLEMENT');
const pEscrow = await setupPolicy('ESCROW');
const pIssue = await setupPolicy('ISSUANCE');
rec('db_program_policy_setup', !pSettle.appr?.error && !pEscrow.appr?.error && !pIssue.appr?.error, {pSettle,pEscrow,pIssue});

const sk = `settle-${tag}`;
const legs = JSON.stringify([{institutionId:i1,debitAccount:ca1,creditAccount:ca2,amountMinor:'10'}]);
try {
  const sr1 = (await admin.query("SELECT freehold.program_settle_atomic($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::jsonb) AS item",[du1,i1,sk,new Date(Date.now()+3600000).toISOString(),legs])).rows[0].item;
  const sr2 = (await admin.query("SELECT freehold.program_settle_atomic($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::jsonb) AS item",[du1,i1,sk,new Date(Date.now()+3600000).toISOString(),legs])).rows[0].item;
  rec('db_settle_atomic_replay', sr1.executionId===sr2.executionId && sr2.duplicate===true, {s1:sr1,s2:sr2});
  try { await admin.query("SELECT freehold.program_settle_atomic($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::jsonb) AS item",[du1,i1,sk,new Date(Date.now()+3600000).toISOString(), JSON.stringify([{institutionId:i1,debitAccount:ca1,creditAccount:ca2,amountMinor:'11'}])]); rec('db_settle_atomic_conflict', false, 'no conflict'); }
  catch(e){ rec('db_settle_atomic_conflict', e.message==='PROGRAM_IDEMPOTENCY_CONFLICT', {code:e.code,message:e.message}); }
  const se = await admin.query("SELECT count(*)::int c FROM freehold.program_executions WHERE institution_id=$1 AND idempotency_key=$2",[i1,sk]);
  const lc = await admin.query("SELECT count(*)::int c FROM freehold.program_legs WHERE execution_id=$1",[sr1.executionId]);
  const jc = await admin.query("SELECT count(*)::int c FROM freehold.institution_journals j JOIN freehold.program_legs l ON l.journal_id=j.id WHERE l.execution_id=$1",[sr1.executionId]);
  rec('db_settle_atomic_single_effect', se.rows[0].c===1 && lc.rows[0].c===1 && jc.rows[0].c===1, {exec:se.rows[0], legs:lc.rows[0], journals:jc.rows[0]});
} catch(e){ rec('db_settle_atomic_tests', false, {code:e.code,message:e.message,where:e.where}); }

const ek = `escrow-${tag}`;
const conditions = JSON.stringify({language:'fh-workflow-1', release:'AUTHORIZED'});
try {
  const er1 = (await admin.query("SELECT freehold.program_escrow_fund($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::uuid,$6::text,$7::jsonb,$8::timestamptz,$9::text) AS item",[du1,i1,ca1,50n,i1,'benef-ref',conditions,new Date(Date.now()+86400000).toISOString(),ek])).rows[0].item;
  const er2 = (await admin.query("SELECT freehold.program_escrow_fund($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::uuid,$6::text,$7::jsonb,$8::timestamptz,$9::text) AS item",[du1,i1,ca1,50n,i1,'benef-ref',conditions,new Date(Date.now()+86400000).toISOString(),ek])).rows[0].item;
  rec('db_escrow_fund_replay', er1.escrowId===er2.escrowId && er2.duplicate===true, {e1:er1,e2:er2});
  try { await admin.query("SELECT freehold.program_escrow_fund($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::uuid,$6::text,$7::jsonb,$8::timestamptz,$9::text) AS item",[du1,i1,ca1,51n,i1,'benef-ref',conditions,new Date(Date.now()+86400000).toISOString(),ek]); rec('db_escrow_fund_conflict', false, 'no conflict'); }
  catch(e){ rec('db_escrow_fund_conflict', e.message==='PROGRAM_IDEMPOTENCY_CONFLICT', {code:e.code,message:e.message}); }
  const ec = await admin.query("SELECT count(*)::int c FROM freehold.program_escrows WHERE institution_id=$1 AND idempotency_key=$2",[i1,ek]);
  rec('db_escrow_single_effect', ec.rows[0].c===1, {escrows:ec.rows[0]});
} catch(e){ rec('db_escrow_tests', false, {code:e.code,message:e.message,where:e.where}); }

const fusdBook = (await admin.query("SELECT id FROM freehold.monetary_books WHERE product_code='PAYMENT_STABLECOIN' LIMIT 1")).rows[0]?.id;
if (fusdBook) {
  const fk = `fusd-${tag}`;
  try {
    const fr1 = (await admin.query("SELECT freehold.program_fusd_request($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::timestamptz) AS item",[du1,i1,fusdBook,100n,fk,null])).rows[0].item;
    const fr2 = (await admin.query("SELECT freehold.program_fusd_request($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::timestamptz) AS item",[du1,i1,fusdBook,100n,fk,null])).rows[0].item;
    rec('db_fusd_replay', fr1.requestId===fr2.requestId && fr2.duplicate===true, {f1:fr1,f2:fr2});
    try { await admin.query("SELECT freehold.program_fusd_request($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::timestamptz) AS item",[du1,i1,fusdBook,101n,fk,null]); rec('db_fusd_conflict', false, 'no conflict'); }
    catch(e){ rec('db_fusd_conflict', e.message==='PROGRAM_IDEMPOTENCY_CONFLICT', {code:e.code,message:e.message}); }
    const fc = await admin.query("SELECT count(*)::int c FROM freehold.program_issuance_requests WHERE book_id=$1 AND idempotency_key=$2",[fusdBook,fk]);
    rec('db_fusd_single_effect', fc.rows[0].c===1, fc.rows[0]);
  } catch(e){ rec('db_fusd_tests', false, {code:e.code,message:e.message,where:e.where}); }
} else { rec('db_fusd_tests_skipped', true, {note:'no payment stablecoin book'}); }

writeFileSync('docs/evidence/phase16-3/program-db.json', JSON.stringify(out, null, 2));
await admin.end();
console.log('done');
