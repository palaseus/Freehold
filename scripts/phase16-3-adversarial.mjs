import { Client } from 'pg';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
mkdirSync('docs/evidence/phase16-3', { recursive: true });
const env = {};
for (const line of readFileSync('/tmp/opencode/freehold-p162/env', 'utf8').split('\n')) {
  const m = line.replace(/^export\s+/, '').match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^'|'$/g, '');
}
const admin = new Client({ connectionString: env.TEST_DATABASE_ADMIN_URL });
await admin.connect();
const api = new Client({ connectionString: env.DATABASE_URL }); // freehold_api
await api.connect();
const out = { timestamp: new Date().toISOString(), tests: [] };
const rec = (name, ok, detail) => { out.tests.push({ name, ok, detail }); console.log(`${ok?'OK':'FAIL'} ${name}`); };

const tag = Date.now().toString(36);
const u1 = randomUUID(), u2 = randomUUID();
await admin.query("INSERT INTO freehold.users(id,email_normalized,password_hash,role,status,auth_version) VALUES ($1,$2,'$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$hashhashhashhashhashhashhashhashhashha','ADMIN','ACTIVE',1),($3,$4,'$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$hashhashhashhashhashhashhashhashhashha','ADMIN','ACTIVE',1) ON CONFLICT DO NOTHING", [u1, `adv1-${tag}@example.test`, u2, `adv2-${tag}@example.test`]);
const inst1 = (await admin.query("SELECT freehold.institution_open($1::uuid,$2::text,$3::text) AS item", [u1, `a1${tag.slice(-4)}`, 'Adv Inst 1'])).rows[0].item;
const inst2 = (await admin.query("SELECT freehold.institution_open($1::uuid,$2::text,$3::text) AS item", [u2, `a2${tag.slice(-4)}`, 'Adv Inst 2'])).rows[0].item;
const i1 = inst1.institutionId, i2 = inst2.institutionId;
rec('setup_institutions', !!i1 && !!i2, {i1,i2});
const cust1 = (await admin.query("SELECT freehold.institution_customer_open($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item", [u1,i1,`c1-${tag}`,'C1','USD'])).rows[0].item;
const cust2 = (await admin.query("SELECT freehold.institution_customer_open($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item", [u2,i2,`c2-${tag}`,'C2','USD'])).rows[0].item;
rec('setup_customers', !!cust1?.accountId && !!cust2?.accountId, {cust1, cust2});
const fund = await admin.query("SELECT freehold.institution_fund_simulated($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::uuid) AS item", [u1,i1,cust1.accountId,1000n,`fund-${tag}`, randomUUID()]);
rec('setup_fund', !!fund.rows[0]?.item, fund.rows[0]?.item);

// 1) cross-tenant reads/writes as freehold_api role (no bound session)
const crossTenant = [
  ['cross_tenant_account_get', "SELECT freehold.institution_account_get($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid) AS item", [u2,i1,cust1.accountId]],
  ['cross_tenant_activity', "SELECT freehold.institution_activity($1::uuid,$2::uuid,$3::uuid) AS item", [u2,i1,cust1.accountId]],
  ['cross_tenant_fund', "SELECT freehold.institution_fund_simulated($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::uuid) AS item", [u2,i1,cust1.accountId,1n,`x-${tag}`,randomUUID()]],
  ['cross_tenant_payment_open', "SELECT freehold.institution_payment_open($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::text,$7::text,$8::uuid) AS item", [u2,i1,cust1.accountId,1n,'ACH',`xref-${tag}`,`xkey-${tag}`,randomUUID()]],
  ['cross_tenant_transfer', "SELECT freehold.institution_transfer($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::text,$7::uuid) AS item", [u2,i1,cust1.accountId,cust1.accountId,1n,`xt-${tag}`,randomUUID()]],
  ['cross_tenant_usage_record', "SELECT freehold.institution_usage_record($1::uuid,$2::uuid,$3::date,$4::text,$5::bigint,$6::text) AS item", [u2,i1,'2026-11-01','API_CALL',1n,`xu-${tag}`]],
];
for (const [name, sql, params] of crossTenant) {
  try { await api.query(sql, params); rec(name, false, 'unexpected success'); }
  catch (e) { rec(name, true, {code:e.code, message:e.message}); }
}

// 2) unauthorized SECURITY DEFINER helper invocation as API role
const helperCalls = [
  ['helper__institution_actor', "SELECT freehold._institution_actor($1::uuid,NULL,NULL,NULL,$2::uuid,'accounts:read')", [u1,i1]],
  ['helper__institution_post', "SELECT freehold._institution_post($1::uuid,$2::uuid,'USD','TEST',$3::text,$4::uuid,'m','[]'::jsonb)", [i1, (await admin.query("SELECT legal_entity_id FROM freehold.institution_ledger_accounts WHERE institution_id=$1 LIMIT 1",[i1])).rows[0].legal_entity_id, `h-${tag}`, randomUUID()]],
  ['helper__program_asset_move', "SELECT freehold._program_asset_move(gen_random_uuid(),'ISSUE',$1::text,NULL,NULL,1)", [`k-${tag}`]],
  ['helper__network_writer', "SELECT freehold._network_writer()", []],
];
for (const [name, sql, params] of helperCalls) {
  try { await api.query(sql, params); rec(name, false, 'unexpected success'); }
  catch (e) { rec(name, true, {code:e.code, message:e.message}); }
}

// 3) unauthorized institution onboarding as API role (no bound session context / not authorized)
try { await api.query("SELECT freehold.institution_open($1::uuid,$2::text,$3::text) AS item", [u2,`bad${tag.slice(-3)}`,'Bad']); rec('unauthorized_onboarding', false, 'unexpected success'); }
catch (e) { rec('unauthorized_onboarding', true, {code:e.code, message:e.message}); }

// 4) app.institution_id GUC forgery - can be set but no authorization relies on it
try {
  await api.query("SELECT set_config('app.institution_id',$1,true)", [i1]);
  // attempt cross-tenant read still must fail (relies on membership, not GUC)
  try { await api.query("SELECT freehold.institution_account_get($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid) AS item", [u2,i1,cust1.accountId]); rec('guc_forgery_no_effect', false, 'read succeeded after setting GUC'); }
  catch (e) { rec('guc_forgery_no_effect', true, {note:'set_config succeeded but authorization not GUC-based', readError: {code:e.code,message:e.message}}); }
} catch (e) { rec('guc_forgery_no_effect', true, {note:'GUC not settable', error:{code:e.code,message:e.message}}); }

// 5) connection-pool tenant leakage/scoping: set_config(...,true) is local to transaction; in autocommit it does not persist across statements/transactions.
await api.query("BEGIN");
await api.query("SELECT set_config('app.institution_id',$1,true)", [i1]);
const gin = await api.query("SELECT current_setting('app.institution_id', true) AS v");
await api.query("COMMIT");
const gout = await api.query("SELECT current_setting('app.institution_id', true) AS v");
rec('guc_local_scoping_observed', gin.rows[0].v===i1 && gout.rows[0].v===null, {inTx: gin.rows[0].v, afterTx: gout.rows[0].v});

// 6) different institutions same idempotency key - must be independent
const k = `same-${tag}`;
const f1 = await admin.query("SELECT freehold.institution_fund_simulated($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::uuid) AS item", [u1,i1,cust1.accountId,10n,k,randomUUID()]);
const f2 = await admin.query("SELECT freehold.institution_fund_simulated($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::uuid) AS item", [u2,i2,cust2.accountId,10n,k,randomUUID()]);
rec('same_key_different_institutions_independent', !!f1.rows[0]?.item && !!f2.rows[0]?.item && f1.rows[0].item.journalId !== f2.rows[0].item.journalId, {f1:f1.rows[0].item, f2:f2.rows[0].item});

writeFileSync('docs/evidence/phase16-3/adversarial-db.json', JSON.stringify(out, null, 2));
await admin.end(); await api.end();
console.log('done');
