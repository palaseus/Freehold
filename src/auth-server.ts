import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual, createDecipheriv } from 'node:crypto';
import { Pool } from 'pg';
import { createClient } from 'redis';
import * as argon2 from 'argon2';
import { Secret, TOTP } from 'otpauth';
import { assertProductionLedger, assertProductionProcess } from './config/production-posture';
import { assertRuntimePrivileges } from './database/runtime-privileges';

const token = process.env.AUTH_INTERNAL_TOKEN ?? '';
const authUrl = process.env.AUTH_DATABASE_URL ?? '';
const redisUrl = process.env.REDIS_URL ?? '';
const totpKey = Buffer.from(process.env.TOTP_ENCRYPTION_KEY ?? '', 'base64');
const ttlSeconds = 12 * 60 * 60;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (process.env.DATABASE_URL) fail('Auth process must not hold DATABASE_URL');
if (!authUrl.startsWith('postgres')) fail('AUTH_DATABASE_URL is required');
if (!redisUrl.startsWith('redis')) fail('REDIS_URL is required');
if (token.length < 32) fail('AUTH_INTERNAL_TOKEN must have at least 32 characters');
if (totpKey.length !== 32) fail('TOTP_ENCRYPTION_KEY must encode 32 bytes');
try { assertProductionProcess('auth'); }
catch (error) { fail(error instanceof Error ? error.message : 'Production posture refused startup'); }

const pool = new Pool({ connectionString: authUrl, max: 4, connectionTimeoutMillis: 5000, options: '-c statement_timeout=5000' });
const redis = createClient({ url: redisUrl, socket: { connectTimeout: 5000 } });
redis.on('error', () => undefined);

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
function authorized(header: string | undefined): boolean {
  const expected = Buffer.from(token);
  const got = Buffer.from(header ?? '');
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

function send(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buf.length;
    if (length > 4096) throw Object.assign(new Error('large'), { status: 413 });
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function asBuffer(value: Buffer | string): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value.startsWith('\\x')) return Buffer.from(value.slice(2), 'hex');
  return Buffer.from(value, 'base64');
}
function decryptTotp(encrypted: Buffer): string {
  if (encrypted[0] !== 1 || encrypted.length < 30) throw new Error('envelope');
  const decipher = createDecipheriv('aes-256-gcm', totpKey, encrypted.subarray(1, 13));
  decipher.setAuthTag(encrypted.subarray(13, 29));
  return Buffer.concat([decipher.update(encrypted.subarray(29)), decipher.final()]).toString('utf8');
}

async function login(body: { email?: string; password?: string; totp?: string | null }, dummyHash: string) {
  const email = typeof body.email === 'string' ? body.email : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const bucket = `auth-login:${email}`;
  const attempts = Number(await redis.eval(
    "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],300) end; return n",
    { keys: [bucket], arguments: [] }));
  if (attempts > 10) return { status: 429, body: { code: 'LOGIN_RATE_LIMITED' } };
  const found = await pool.query<{ id: string; password_hash: string; status: string; role: string; auth_version: string; totp_secret_encrypted: Buffer | null }>(
    'SELECT * FROM freehold.auth_find_credentials($1::text)', [email]);
  const user = found.rows[0];
  const valid = await argon2.verify(user?.password_hash?.startsWith('$argon2id$') ? user.password_hash : dummyHash, password).catch(() => false);
  if (!user || !valid || user.status !== 'ACTIVE') return { status: 401, body: { code: 'INVALID_CREDENTIALS' } };
  let twoFactorAt: number | null = null;
  if (user.totp_secret_encrypted) {
    const code = body.totp ?? '';
    if (!/^\d{6}$/.test(code)) return { status: 401, body: { code: 'INVALID_CREDENTIALS' } };
    let secret: string;
    try { secret = decryptTotp(asBuffer(user.totp_secret_encrypted)); }
    catch { return { status: 401, body: { code: 'INVALID_CREDENTIALS' } }; }
    const timestamp = Date.now();
    const totp = new TOTP({ secret: Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: 30 });
    const delta = totp.validate({ token: code, timestamp, window: 1 });
    const counter = totp.counter({ timestamp }) + (delta ?? 0);
    const consumed = delta !== null && (await redis.set(`totp-used:${user.id}:${counter}`, '1', { NX: true, EX: 120 })) === 'OK';
    if (!consumed) return { status: 401, body: { code: 'INVALID_CREDENTIALS' } };
    twoFactorAt = timestamp;
  }
  const dbSecret = randomBytes(32);
  await pool.query('SELECT freehold.auth_bind_session($1::uuid,$2::bigint,$3::bytea,$4::timestamptz,$5::integer)',
    [user.id, user.auth_version, dbSecret, twoFactorAt === null ? null : new Date(twoFactorAt), ttlSeconds]);
  return { status: 200, body: { userId: user.id, authVersion: String(user.auth_version), twoFactorAt, dbSecret: dbSecret.toString('hex'), role: user.role } };
}

async function register(body: { email?: string; passwordHash?: string; totpEncryptedBase64?: string | null }) {
  if (typeof body.email !== 'string' || typeof body.passwordHash !== 'string' || !body.passwordHash.startsWith('$argon2id$')) {
    return { status: 400, body: { code: 'INVALID_REQUEST' } };
  }
  const totp = body.totpEncryptedBase64 ? Buffer.from(body.totpEncryptedBase64, 'base64') : null;
  try {
    const inserted = await pool.query<{ id: string }>('SELECT freehold.register_user($1::text,$2::text,$3::bytea) AS id', [body.email, body.passwordHash, totp]);
    return { status: 201, body: { userId: inserted.rows[0]?.id } };
  } catch (error) {
    const pg = error as { code?: string; message?: string };
    if (pg.code === '23505' && pg.message === 'EMAIL_UNAVAILABLE') return { status: 409, body: { code: 'EMAIL_UNAVAILABLE' } };
    return { status: 503, body: { code: 'AUTH_SERVICE_UNAVAILABLE' } };
  }
}

async function revoke(body: { dbSecret?: string }) {
  if (typeof body.dbSecret !== 'string' || !/^[0-9a-f]{64}$/.test(body.dbSecret)) return { status: 400, body: { code: 'INVALID_REQUEST' } };
  await pool.query('SELECT freehold.auth_revoke_session($1::bytea)', [Buffer.from(body.dbSecret, 'hex')]);
  return { status: 204, body: {} };
}

async function main() {
  const dummyHash = await argon2.hash(randomBytes(32).toString('hex'), { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
  const client = await pool.connect();
  try {
    await assertRuntimePrivileges(client, 'auth');
    await assertProductionLedger(client);
  } finally { client.release(); }
  await redis.connect();
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === 'GET' && req.url === '/health') { send(res, 200, { status: 'ok' }); return; }
        if (req.method === 'GET' && req.url === '/ready') {
          try {
            await pool.query('SELECT 1');
            await assertProductionLedger(pool);
            send(res, 200, { status: 'accepting' });
          } catch {
            send(res, 503, { status: 'unavailable' });
          }
          return;
        }
        if (!authorized(headerValue(req.headers['x-freehold-auth-token']))) { send(res, 401, { code: 'INVALID_CREDENTIALS' }); return; }
        const body = await readBody(req) as Record<string, unknown>;
        const route = req.method === 'POST' ? req.url : '';
        const result = route === '/v1/internal/login' ? await login(body, dummyHash)
          : route === '/v1/internal/register' ? await register(body)
          : route === '/v1/internal/revoke' ? await revoke(body)
          : { status: 404, body: { code: 'NOT_FOUND' } };
        if (result.status === 204) { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return; }
        send(res, result.status, result.body);
      } catch {
        if (!res.headersSent) send(res, 503, { code: 'AUTH_SERVICE_UNAVAILABLE' });
      }
    })();
  });
  const port = Number(process.env.AUTH_PORT ?? 3002);
  const host = process.env.AUTH_BIND_HOST ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const bound = address && typeof address === 'object' ? address.port : port;
  process.stdout.write(`AUTH_LISTENING ${bound}\n`);
}

main().catch(() => fail('Auth process failed to start'));
