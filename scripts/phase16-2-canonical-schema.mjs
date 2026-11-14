#!/usr/bin/env node
// Phase 16.2 canonical schema and runtime-role proof.
//
// Reads the disposable cluster catalog as the migration administrator and
// separately connects as freehold_api to prove the runtime identity and grant
// boundary. No connection string, password, role secret, or row data is written.
import { writeFile } from 'node:fs/promises';
import { Client } from 'pg';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;
const API_URL = process.env.DATABASE_URL;
const OUT = process.env.PHASE162_CANONICAL_SCHEMA_OUT ?? 'docs/evidence/phase16-2/canonical-schema.json';
if (!ADMIN_URL) throw new Error('TEST_DATABASE_ADMIN_URL is required');
if (!API_URL) throw new Error('DATABASE_URL is required to prove the API runtime identity');

const expectedRoles = ['freehold_api', 'freehold_worker', 'freehold_verifier', 'freehold_auth', 'freehold_scheduler'];
const criticalFunctions = [
  ['freehold.institution_transfer(uuid,text,text,text,uuid,uuid,uuid,bigint,text,uuid)', true],
  ['freehold.institution_credential_issue(uuid,uuid,text[],integer)', true],
  ['freehold.institution_account_get(uuid,text,text,text,uuid,uuid)', true],
  ['freehold.institution_open(uuid,text,text)', true],
  ['freehold._institution_post(uuid,uuid,text,text,text,uuid,text,jsonb)', false],
  ['freehold._institution_request_hash(text,jsonb)', false],
  ['freehold._institution_actor(uuid,text,text,text,uuid,text)', false],
  ['freehold._require_bound_session(uuid)', false],
];

const admin = new Client({ connectionString: ADMIN_URL, application_name: 'freehold-phase16.2-schema-proof' });
const api = new Client({ connectionString: API_URL, application_name: 'freehold-phase16.2-api-identity-proof' });
const evidence = {
  reportType: 'freehold.phase16.2.canonical-schema',
  generatedAt: new Date().toISOString(),
  gitRevision: process.env.PHASE162_GIT_REVISION ?? null,
  database: null,
  migrations: null,
  schema: null,
  roles: null,
  apiRuntimeIdentity: null,
  functionBoundary: null,
  checks: [],
  outcome: 'FAIL',
};

const check = (name, pass, detail) => {
  evidence.checks.push({ name, status: pass ? 'PASS' : 'FAIL', ...(detail === undefined ? {} : { detail }) });
  if (!pass) throw new Error(`${name}: ${JSON.stringify(detail)}`);
};

try {
  await admin.connect();
  await api.connect();
  const dbInfo = await admin.query(
    `SELECT current_database() AS database, current_setting('server_version') AS server_version,
            current_setting('server_version_num') AS server_version_num`);
  evidence.database = dbInfo.rows[0];

  const migrations = await admin.query(
    `SELECT name, checksum, applied_at FROM freehold_deploy.migrations ORDER BY name`);
  const names = migrations.rows.map(row => row.name);
  const checksumSet = (await import('node:crypto')).createHash('sha256')
    .update(JSON.stringify(migrations.rows.map(row => [row.name, row.checksum]))).digest('hex');
  evidence.migrations = {
    count: migrations.rows.length,
    names,
    checksumSet,
    latest: names.at(-1) ?? null,
    phase16_2: migrations.rows.filter(row => row.name.includes('phase16_2_')).map(row => ({ name: row.name, checksum: row.checksum, appliedAt: row.applied_at })),
  };
  check('canonical migrations applied', migrations.rows.length >= 34, migrations.rows.length);
  check('migration 028 applied', names.includes('028_phase16_2_tenant_authorization.sql'), names.at(-7));
  check('migration 029 applied', names.includes('029_phase16_2_institution_idempotency.sql'), names.at(-6));
  check('migration 030 applied', names.includes('030_phase16_2_institution_payment_idempotency.sql'), names.at(-5));
  check('migration 031 applied', names.includes('031_phase16_2_network_payment_idempotency.sql'), names.at(-4));
  check('migration 032 applied', names.includes('032_phase16_2_program_idempotency.sql'), names.at(-3));
  check('migration 033 applied', names.includes('033_phase16_2_institution_usage_idempotency.sql'), names.at(-2));
  check('migration 034 applied', names.includes('034_phase16_2_institution_usage_execute_privileges.sql'), names.at(-1));

  const tables = await admin.query(
    `SELECT c.relname AS table, c.relrowsecurity AS rls_enabled
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'freehold' AND c.relkind IN ('r','p') ORDER BY c.relname`);
  const rlsEnabled = tables.rows.filter(row => row.rls_enabled).map(row => row.table);
  const setContext = await admin.query(
    `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'freehold' AND p.proname = 'set_institution_context'`);
  const callerSettableContext = await admin.query(
    `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'freehold' AND (p.prosrc ILIKE '%app.institution_id%' OR p.prosrc ILIKE '%set_institution_context%')`);
  const requestHash = await admin.query(
    `SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'freehold' AND table_name = 'institution_journals' AND column_name = 'request_hash'`);
  const requestHashConstraint = await admin.query(
    `SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'freehold' AND t.relname = 'institution_journals' AND c.conname = 'institution_journals_request_hash_check'`);
  evidence.schema = {
    tableCount: tables.rows.length,
    tables: tables.rows.map(row => row.table),
    rlsEnabledTables: rlsEnabled,
    rlsEnabledCount: rlsEnabled.length,
    setInstitutionContextFunctions: setContext.rows[0].n,
    callerSettableInstitutionContextReferences: callerSettableContext.rows[0].n,
    institutionJournalsRequestHash: requestHash.rows[0] ?? null,
    institutionJournalsRequestHashConstraint: requestHashConstraint.rows[0].n,
  };
  check('canonical tables exist', tables.rows.length >= 40, tables.rows.length);
  check('no caller-settable RLS context', rlsEnabled.length === 0 && setContext.rows[0].n === 0 && callerSettableContext.rows[0].n === 0,
    { rlsEnabled, setContext: setContext.rows[0].n, references: callerSettableContext.rows[0].n });
  check('institution journal request_hash is present and constrained',
    requestHash.rows[0]?.data_type === 'text' && requestHash.rows[0]?.is_nullable === 'YES' && requestHashConstraint.rows[0].n === 1,
    { column: requestHash.rows[0], constraint: requestHashConstraint.rows[0].n });

  const roles = await admin.query(
    `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit
       FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`, [[...expectedRoles, 'freehold_app', 'freehold_owner']]);
  const roleMap = Object.fromEntries(roles.rows.map(row => [row.rolname, row]));
  const memberships = await admin.query(
    `SELECT r.rolname AS role, m.rolname AS member FROM pg_auth_members a
       JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
      WHERE m.rolname = ANY($1::text[]) OR r.rolname = ANY($1::text[]) ORDER BY r.rolname, m.rolname`,
    [[...expectedRoles, 'freehold_app']]);
  evidence.roles = {
    roles: roleMap,
    memberships: memberships.rows,
    runtimeRolesPresent: expectedRoles.every(name => roleMap[name]?.rolcanlogin === true),
    appGroupIsNologin: roleMap.freehold_app?.rolcanlogin === false,
    runtimeRolesHaveNoSuperuserOrBypass: expectedRoles.every(name => roleMap[name] &&
      roleMap[name].rolsuper === false && roleMap[name].rolcreatedb === false && roleMap[name].rolcreaterole === false &&
      roleMap[name].rolreplication === false && roleMap[name].rolbypassrls === false),
  };
  check('all five runtime login roles exist', evidence.roles.runtimeRolesPresent, expectedRoles.map(name => roleMap[name]));
  check('freehold_app is an inert NOLOGIN group', evidence.roles.appGroupIsNologin, roleMap.freehold_app);
  check('runtime roles are least-privilege login roles', evidence.roles.runtimeRolesHaveNoSuperuserOrBypass, roleMap);

  const grants = await admin.query(
    `SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'freehold_api' AND table_schema = 'freehold'
      ORDER BY table_name, privilege_type`);
  const apiSelectTables = grants.rows.filter(row => row.privilege_type === 'SELECT').map(row => row.table_name);
  const apiWriteGrants = grants.rows.filter(row => ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].includes(row.privilege_type));
  const writePrivilegesStillHeld = await admin.query(
    `SELECT c.relname AS table, p.privilege
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) AS p(privilege)
      WHERE n.nspname = 'freehold' AND c.relkind IN ('r','p')
        AND has_table_privilege('freehold_api', c.oid, p.privilege)
      ORDER BY c.relname, p.privilege`);
  evidence.apiTableGrants = {
    selectTables: apiSelectTables,
    writeGrants: apiWriteGrants,
    writePrivilegesStillHeld: writePrivilegesStillHeld.rows,
  };
  check('API has only currencies SELECT on canonical tables', apiSelectTables.length === 1 && apiSelectTables[0] === 'currencies' && apiWriteGrants.length === 0,
    evidence.apiTableGrants);
  check('API holds no table write privilege', writePrivilegesStillHeld.rows.length === 0, writePrivilegesStillHeld.rows);

  const functions = await admin.query(
    `SELECT p.oid::regprocedure::text AS signature, p.prosecdef AS security_definer,
            pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
            has_function_privilege('freehold_api', p.oid, 'EXECUTE') AS api_can_execute
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'freehold' AND p.proname IN (
        'institution_transfer','institution_credential_issue','institution_account_get','institution_open',
        '_institution_post','_institution_request_hash','_institution_actor','_require_bound_session')
      ORDER BY p.oid::regprocedure::text`);
  const functionMap = Object.fromEntries(functions.rows.map(row => [row.signature, row]));
  evidence.functionBoundary = {
    functions: functions.rows,
    critical: criticalFunctions.map(([signature, shouldExecute]) => ({
      signature, shouldExecute, found: !!functionMap[signature],
      actualExecute: functionMap[signature]?.api_can_execute ?? null,
      securityDefiner: functionMap[signature]?.security_definer ?? null,
      owner: functionMap[signature]?.owner ?? null,
      config: functionMap[signature]?.config ?? null,
    })),
  };
  for (const [signature, shouldExecute] of criticalFunctions) {
    const row = functionMap[signature];
    check(`function boundary ${signature}`, !!row && row.api_can_execute === shouldExecute,
      { expectedApiExecute: shouldExecute, actual: row ?? null });
    check(`function owner is freehold_owner: ${signature}`, row?.owner === 'freehold_owner', row?.owner ?? null);
  }
  check('tenant boundary functions are SECURITY DEFINER', evidence.functionBoundary.critical
    .filter(item => /institution_(transfer|credential_issue|account_get|open)\(/.test(item.signature))
    .every(item => item.securityDefiner === true), evidence.functionBoundary.critical);
  check('tenant boundary functions pin a safe search_path', evidence.functionBoundary.critical
    .filter(item => /institution_(transfer|credential_issue|account_get|open)\(/.test(item.signature))
    .every(item => Array.isArray(item.config) && item.config.some(value => value.startsWith('search_path='))), evidence.functionBoundary.critical);

  const apiIdentity = await api.query(
    `SELECT current_user, session_user, current_database() AS database,
            current_setting('server_version') AS server_version,
            current_setting('search_path') AS search_path,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
            (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls,
            (SELECT rolinherit FROM pg_roles WHERE rolname = current_user) AS inherit,
            has_table_privilege(current_user, 'freehold.currencies', 'SELECT') AS can_read_currencies,
            has_table_privilege(current_user, 'freehold.institutions', 'SELECT') AS can_read_institutions,
            has_table_privilege(current_user, 'freehold.institutions', 'INSERT') AS can_insert_institutions,
            has_function_privilege(current_user, 'freehold.institution_transfer(uuid,text,text,text,uuid,uuid,uuid,bigint,text,uuid)', 'EXECUTE') AS can_transfer,
            has_function_privilege(current_user, 'freehold._institution_post(uuid,uuid,text,text,text,uuid,text,jsonb)', 'EXECUTE') AS can_call_internal_post`);
  evidence.apiRuntimeIdentity = apiIdentity.rows[0];
  check('API connects as freehold_api', evidence.apiRuntimeIdentity.current_user === 'freehold_api' && evidence.apiRuntimeIdentity.session_user === 'freehold_api',
    evidence.apiRuntimeIdentity);
  check('API runtime is not superuser and cannot bypass RLS', evidence.apiRuntimeIdentity.superuser === false && evidence.apiRuntimeIdentity.bypass_rls === false,
    evidence.apiRuntimeIdentity);
  check('API can execute reviewed financial functions', evidence.apiRuntimeIdentity.can_transfer === true, evidence.apiRuntimeIdentity);
  check('API cannot call internal posting helper', evidence.apiRuntimeIdentity.can_call_internal_post === false, evidence.apiRuntimeIdentity);
  check('API has no direct institution table read or write', evidence.apiRuntimeIdentity.can_read_institutions === false && evidence.apiRuntimeIdentity.can_insert_institutions === false,
    evidence.apiRuntimeIdentity);

  evidence.outcome = evidence.checks.every(item => item.status === 'PASS') ? 'PASS' : 'FAIL';
} catch (error) {
  evidence.error = error instanceof Error ? error.message : 'unknown';
  evidence.outcome = 'FAIL';
  process.exitCode = 1;
} finally {
  await writeFile(OUT, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 }).catch(writeError => {
    process.stderr.write(`Failed to write canonical schema evidence: ${writeError instanceof Error ? writeError.message : 'unknown'}\n`);
    process.exitCode = 1;
  });
  await admin.end().catch(() => undefined);
  await api.end().catch(() => undefined);
}
if (evidence.outcome === 'PASS') process.stdout.write('Phase 16.2 canonical schema evidence: PASS\n');
else process.stderr.write(`Phase 16.2 canonical schema evidence: ${evidence.outcome} ${evidence.error ?? ''}\n`);
