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
const du1 = randomUUID(), du2 = randomUUID();
await admin.query("INSERT INTO freehold.users(id,email_normalized,password_hash,role,status,auth_version) VALUES ($1,$2,'$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$hashhashhashhashhashhashhashhashhashha','ADMIN','ACTIVE',1),($3,$4,'$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$hashhashhashhashhashhashhashhashhashha','ADMIN','ACTIVE',1)", [du1,`p163pe1-${tag}@example.test`, du2,`p163pe2-${tag}@example.test`]);
const i1 = (await admin.query("SELECT freehold.institution_open($1::uuid,$2::text,$3::text) AS item",[du1,`pe${tag.slice(-4)}`,'Prog Escrow Inst'])).rows[0].item.institutionId;
await admin.query("SELECT freehold.institution_grant($1::uuid,$2::uuid,$3::uuid,$4::text)",[du1,i1,du2,'GOVERNANCE']).catch(()=>{});
const ca1 = (await admin.query("SELECT freehold.institution_customer_open($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item",[du1,i1,`ca1-${tag}`,'CA1','USD'])).rows[0].item.accountId;
await admin.query("SELECT freehold.institution_fund_simulated($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::uuid)",[du1,i1,ca1,10000n,`fund-${tag}`,randomUUID()]);
function policyBody(domain, max, currency='USD') { return { language:'fh-policy-1', domain, maxExposureMinor:String(max), currency, currencies:[currency] }; }
const body = policyBody('ESCROW', '1000000');
const pol = (await admin.query("SELECT freehold.program_policy_draft($1::uuid,$2::uuid,$3::text,$4::jsonb,$5::integer,$6::bigint,$7::text,$8::timestamptz,$9::timestamptz) AS item",[du1,i1,'ESCROW',body,10,1000000n,'USD',new Date(Date.now()-60000).toISOString(),new Date(Date.now()+86400000).toISOString()])).rows[0].item;
await admin.query("SELECT freehold.program_policy_approve($1::uuid,$2::uuid)",[du2,pol.policyId]);
const ek = `escrow2-${tag}`;
const conditions = JSON.stringify({language:'fh-workflow-1', release:'AUTHORIZED'});
const expires = new Date(Date.now()+86400000).toISOString();
try {
  const er1 = (await admin.query("SELECT freehold.program_escrow_fund($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::uuid,$6::text,$7::jsonb,$8::timestamptz,$9::text) AS item",[du1,i1,ca1,50n,i1,'benef-ref',conditions,expires,ek])).rows[0].item;
  const er2 = (await admin.query("SELECT freehold.program_escrow_fund($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::uuid,$6::text,$7::jsonb,$8::timestamptz,$9::text) AS item",[du1,i1,ca1,50n,i1,'benef-ref',conditions,expires,ek])).rows[0].item;
  rec('db_escrow_fund_replay', er1.escrowId===er2.escrowId && er2.duplicate===true, {e1:er1,e2:er2});
  try { await admin.query("SELECT freehold.program_escrow_fund($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::uuid,$6::text,$7::jsonb,$8::timestamptz,$9::text) AS item",[du1,i1,ca1,51n,i1,'benef-ref',conditions,expires,ek]); rec('db_escrow_fund_conflict', false, 'no conflict'); }
  catch(e){ rec('db_escrow_fund_conflict', e.message==='PROGRAM_IDEMPOTENCY_CONFLICT', {code:e.code,message:e.message}); }
  const ec = await admin.query("SELECT count(*)::int c FROM freehold.program_escrows WHERE institution_id=$1 AND idempotency_key=$2",[i1,ek]);
  rec('db_escrow_single_effect', ec.rows[0].c===1, ec.rows[0]);
} catch(e){ rec('db_escrow_tests', false, {code:e.code,message:e.message,where:e.where}); }
writeFileSync('docs/evidence/phase16-3/program-escrow-db.json', JSON.stringify(out, null, 2));
await admin.end();
console.log('done');
