// All identity, account creation, transfers and funding go through REST. No pg,
// SQL imports, Redis access, ledger edits, or direct database credentials here.
import { createHash } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
const origin = (process.env.DEMO_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const token = process.env.DEMO_BOOTSTRAP_TOKEN;
if (!token || token.length < 32) throw new Error('Set DEMO_BOOTSTRAP_TOKEN (minimum 32 characters)');
const password = process.env.DEMO_USER_PASSWORD ?? '';
if (password.length < 12) throw new Error('Set DEMO_USER_PASSWORD to at least 12 characters. There is no built-in demo password.');
const secret = process.env.DEMO_TOTP_SECRET
  ? Secret.fromBase32(process.env.DEMO_TOTP_SECRET)
  : Secret.fromHex(createHash('sha256').update(`freehold-demo-totp:${token}`).digest('hex').slice(0, 40));
const totp = new TOTP({ secret });
async function request(path, { body, auth, key, bootstrap = false } = {}) {
  const response = await fetch(`${origin}/v1${path}`, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(20000),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(bootstrap ? { Authorization: `Bearer ${token}` } : {}),
      ...(auth ? { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}
function accepted(result, statuses = [200]) {
  if (!statuses.includes(result.response.status) || result.payload?.state === 'REJECTED') {
    throw new Error(`API request rejected: HTTP ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  return result.payload;
}
async function login(email, admin = false) {
  for (let attempt = 0; attempt < (admin ? 5 : 1); attempt++) {
    for (const offset of admin ? [30000, 0] : [0]) {
      const result = await request('/auth/login', { body: { email, password, ...(admin ? { totp: totp.generate({ timestamp: Date.now() + offset }) } : {}) } });
      if (result.response.status === 200) {
        return { cookie: result.response.headers.get('set-cookie').split(';')[0], csrf: result.payload.csrfToken };
      }
      if (!admin || result.response.status !== 401) accepted(result);
    }
    if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 8000));
  }
  throw new Error('No unused TOTP counter available; retry the seed after the current time window.');
}
const bootstrap = await request('/demo/bootstrap', { bootstrap: true,
  body: { email: 'operator@freehold.demo', password, totpSecret: secret.base32, totp: totp.generate() } });
accepted(bootstrap, [201]);
for (const email of ['alex@freehold.demo', 'sam@freehold.demo']) {
  const result = await request('/auth/register', { body: { email, password } });
  if (result.response.status !== 409 || result.payload?.code !== 'EMAIL_UNAVAILABLE') accepted(result, [201]);
}
const operator = await login('operator@freehold.demo', true);
const alex = await login('alex@freehold.demo');
const sam = await login('sam@freehold.demo');
const accounts = {};
for (const [name, auth, currencies] of [['alex', alex, ['USD', 'EUR', 'JPY']], ['sam', sam, ['USD', 'EUR']]]) {
  for (const currency of currencies) {
    const created = accepted(await request('/accounts', { body: { currency }, auth, key: `demo:v1:create:${name}:${currency}` }));
    accounts[`${name}${currency}`] = created.accountId;
  }
}
for (const [name, amountMinor] of [['alexUSD', '1284025'], ['alexEUR', '467250'], ['alexJPY', '180000'], ['samUSD', '185000'], ['samEUR', '120000']]) {
  accepted(await request(`/demo/accounts/${accounts[name]}/fund`, { auth: operator, key: `demo:v1:fund:${name}`,
    body: { amountMinor, reason: 'SANDBOX ONLY — public API demo funding; no external funds received' } }));
}
for (const [i, amount] of ['21500', '3250', '48000', '1250', '6850', '2400', '18900', '4200', '9500', '750', '12000', '3100', '1600', '8250', '4300', '12000', '980', '3100', '2500', '10900', '4650', '2350', '7600', '1800'].entries()) {
  const outgoing = i % 3 !== 1;
  accepted(await request('/transfers', { auth: outgoing ? alex : sam, key: `demo:v1:transfer:${i}`,
    body: { sourceAccountId: accounts[outgoing ? 'alexUSD' : 'samUSD'], destinationAccountId: accounts[outgoing ? 'samUSD' : 'alexUSD'], currency: 'USD', amountMinor: amount } }));
}
// Close seed sessions; the authenticator secret below is deliberately demo-only.
for (const auth of [operator, alex, sam]) {
  await fetch(`${origin}/v1/auth/logout`, { method: 'POST', headers: { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf } });
}
console.log(JSON.stringify({ sandbox: true, users: ['alex@freehold.demo', 'sam@freehold.demo', 'operator@freehold.demo'], password,
  operatorTotpSecret: secret.base32, operatorTotpNote: 'Use an authenticator. Seed login consumed a code; wait for a fresh counter before signing in.',
  workerLogCommand: 'docker compose --env-file .env.compose logs -f worker',
  workerNote: 'The worker logs consumed outbox events and runs ledger reconciliation every 30 seconds.', accounts }, null, 2));
