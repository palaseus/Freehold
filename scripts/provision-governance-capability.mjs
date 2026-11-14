// Deployment-only capability provisioning. Never expose MIGRATION_DATABASE_URL to runtime containers.
import { Client } from 'pg';
const [principalId, capability, action] = process.argv.slice(2);
const grantor = process.env.GOVERNANCE_GRANTOR;
const connectionString = process.env.MIGRATION_DATABASE_URL;
const capabilities = new Set(['ACCOUNT_ADMIN','FINANCIAL_REVIEWER','SECURITY_ADMIN','AUDITOR','INSTITUTION_ADMIN','EMERGENCY_CONTROL']);
if (!connectionString || !grantor || !principalId || !capabilities.has(capability) || !['grant','revoke'].includes(action)) {
  throw new Error('Usage: GOVERNANCE_GRANTOR="ticket/operator reference" MIGRATION_DATABASE_URL=... node scripts/provision-governance-capability.mjs <admin-user-uuid> <capability> <grant|revoke>');
}
const client = new Client({ connectionString });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE freehold_owner');
  await client.query('SELECT freehold.governance_provision_capability($1::uuid,$2::text,$3::text,$4::boolean)', [principalId,capability,grantor,action==='grant']);
  await client.query('COMMIT');
  process.stdout.write(`Capability ${action} recorded for principal ${principalId}: ${capability}\n`);
} catch (error) { await client.query('ROLLBACK'); process.stderr.write(`Capability provisioning failed (${error?.code ?? 'internal'})\n`); process.exitCode=1; }
finally { await client.end(); }
