import { Client } from 'pg';
const url = process.env.RESTORED_ADMIN_URL;
const entries = [
  ['freehold_api',process.env.API_DATABASE_PASSWORD],
  ['freehold_worker',process.env.WORKER_DATABASE_PASSWORD],
  ['freehold_verifier',process.env.VERIFIER_DATABASE_PASSWORD],
  ['freehold_auth',process.env.AUTH_DATABASE_PASSWORD],
  ['freehold_scheduler',process.env.SCHEDULER_DATABASE_PASSWORD],
];
if (!url || entries.some(([,p])=>!p || p.length<32)) throw new Error('Privileged restore URL and independent runtime passwords of at least 32 characters are required.');
const quote = value => `'${value.replaceAll("'","''")}'`;
const client = new Client({connectionString:url});
await client.connect();
try { for (const [role,password] of entries) await client.query(`ALTER ROLE ${role} PASSWORD ${quote(password)}`); }
finally { await client.end(); }
