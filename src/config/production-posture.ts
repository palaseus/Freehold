// Process boot gate. A listening process is not a deployment certificate.
// scripts/deployment-check.mjs is the only READY signal, and it stays
// NOT_READY until WAL, heartbeats, and an independent backup are measured.

type Service = 'api' | 'auth' | 'worker' | 'scheduler';
type Posture = { sandboxEnabled?: boolean; demoEnabled?: boolean };
type QueryClient = { query: (sql: string) => Promise<{ rows: Array<{ posture?: Posture }> }> };

const OWN_URL: Record<Service, string> = {
  api: 'DATABASE_URL',
  auth: 'AUTH_DATABASE_URL',
  worker: 'WORKER_DATABASE_URL',
  scheduler: 'SCHEDULER_DATABASE_URL',
};
const OWN_ROLE: Record<Service, string> = {
  api: 'freehold_api',
  auth: 'freehold_auth',
  worker: 'freehold_worker',
  scheduler: 'freehold_scheduler',
};
const DATABASE_URLS = ['DATABASE_URL', 'AUTH_DATABASE_URL', 'WORKER_DATABASE_URL', 'SCHEDULER_DATABASE_URL', 'MIGRATION_DATABASE_URL', 'VERIFY_DATABASE_URL', 'CHECK_DATABASE_URL'];
const MONETARY_LIVE_ENV = ['MONETARY_LIVE_ISSUANCE', 'FUSD_LIVE', 'ENABLE_STABLECOIN', 'LIVE_REDEMPTION', 'EXTERNAL_SETTLEMENT', 'MONETARY_ACTIVATION_TOKEN'];

export function assertProductionProcess(service: Service): void {
  for (const key of MONETARY_LIVE_ENV) {
    if (process.env[key]) throw new Error(`Monetary activation env ${key} is refused`);
  }
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.MONETARY_SIMULATOR_HMAC_KEY) throw new Error('Production refuses MONETARY_SIMULATOR_HMAC_KEY');
  if (process.env.DEMO_MODE === 'true') throw new Error('Production refuses DEMO_MODE');
  if (process.env.DEMO_BOOTSTRAP_TOKEN) throw new Error('Production refuses DEMO_BOOTSTRAP_TOKEN');
  if (process.env.DEMO_USER_PASSWORD) throw new Error('Production refuses DEMO_USER_PASSWORD');
  for (const key of DATABASE_URLS) {
    if (key !== OWN_URL[service] && process.env[key]) throw new Error(`Production ${service} must not hold ${key}`);
  }
  const databaseUrl = process.env[OWN_URL[service]];
  if (!databaseUrl) throw new Error(`Production ${service} is missing ${OWN_URL[service]}`);
  const database = new URL(databaseUrl);
  if (database.username !== OWN_ROLE[service]) throw new Error(`Production ${service} must connect as ${OWN_ROLE[service]}`);
  if (!database.password || database.password.length < 16) throw new Error('Production database password must have at least 16 characters');
  if (database.searchParams.get('sslmode') !== 'verify-full') throw new Error('Production database connections require sslmode=verify-full');
  if (service === 'api' || service === 'auth') {
    let password = '';
    try { password = new URL(process.env.REDIS_URL ?? '').password; } catch { password = ''; }
    if (password.length < 16) throw new Error('Production Redis requires a password of at least 16 characters');
  }
  if (service === 'api' && (process.env.COOKIE_SECURE === 'false' || !(process.env.APP_ORIGIN ?? '').startsWith('https://'))) {
    throw new Error('Production requires HTTPS origin and secure cookies');
  }
}

export function assertPosture(posture: Posture | undefined): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (posture?.sandboxEnabled !== false || posture?.demoEnabled !== false) {
    throw new Error('Production ledger has sandbox or demo enabled');
  }
}

export async function assertProductionLedger(client: QueryClient): Promise<void> {
  if (process.env.NODE_ENV !== 'production') return;
  const result = await client.query('SELECT freehold.runtime_posture() AS posture');
  assertPosture(result.rows[0]?.posture);
}
