import { Injectable, OnModuleInit, OnModuleDestroy, ServiceUnavailableException, HttpException } from '@nestjs/common';
import { createClient } from 'redis';
import { createHash, randomBytes } from 'node:crypto';
import { Config } from '../config/config.module';
import type { SessionRecord } from './auth.types';

@Injectable()
export class SessionService implements OnModuleInit, OnModuleDestroy {
  private readonly redis;
  constructor(private readonly config: Config) {
    this.redis = createClient({ url: config.redisUrl, disableOfflineQueue: true, commandOptions: { timeout: 5000 },
      socket: { connectTimeout: 5000, reconnectStrategy: retries => retries > 10 ? false : Math.min(100 * retries, 2000) } });
    // No Redis error payloads: connection strings can contain credentials.
    this.redis.on('error', () => undefined);
  }
  async onModuleInit() { await this.redis.connect(); }
  async onModuleDestroy() { if (this.redis.isOpen) this.redis.destroy(); }
  private async run<T>(work: () => Promise<T>): Promise<T> {
    if (!this.redis.isReady) throw new ServiceUnavailableException('AUTH_STORAGE_UNAVAILABLE');
    try { return await work(); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('AUTH_STORAGE_UNAVAILABLE');
    }
  }
  private key(token: string) { return `session:${createHash('sha256').update(token).digest('hex')}`; }
  async issue(userId: string, authVersion: string, twoFactorAt: number | null, dbSecret: string) {
    const token = randomBytes(32).toString('base64url');
    const record: SessionRecord = { userId, authVersion, twoFactorAt, dbSecret,
      csrfToken: randomBytes(32).toString('base64url'), expiresAt: Date.now() + this.config.sessionTtlSeconds * 1000 };
    await this.run(() => this.redis.set(this.key(token), JSON.stringify(record), { EX: this.config.sessionTtlSeconds }));
    return { token, record };
  }
  async load(token: string): Promise<SessionRecord | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const raw = await this.run(() => this.redis.get(this.key(token)));
    if (!raw) return null;
    try {
      const r: SessionRecord = JSON.parse(raw);
      if (typeof r.userId !== 'string' || typeof r.authVersion !== 'string' || typeof r.csrfToken !== 'string' ||
        typeof r.dbSecret !== 'string' || !/^[0-9a-f]{64}$/.test(r.dbSecret) ||
        typeof r.expiresAt !== 'number' || r.expiresAt <= Date.now() ||
        (r.twoFactorAt !== null && (typeof r.twoFactorAt !== 'number' || r.twoFactorAt > Date.now()))) return null;
      return r;
    } catch { return null; }
  }
  async revoke(token: string) { await this.run(() => this.redis.del(this.key(token))); }
  async consumeTotp(userId: string, counter: number): Promise<boolean> {
    return (await this.run(() => this.redis.set(`totp-used:${userId}:${counter}`, '1', { NX: true, EX: 120 }))) === 'OK';
  }
  async throttleLogin(email: string) {
    // All browser requests reach the API from the same Next proxy address. Do
    // not use that shared socket IP or trust caller-supplied forwarding headers.
    // The normalized account bucket is atomic and applies across proxy instances.
    const key = `login-limit:${createHash('sha256').update(`email:${email}`).digest('hex')}`;
    const attempts = await this.run(() => this.redis.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],300) end; return n",
      { keys: [key], arguments: [] }));
    if (Number(attempts) > 10) throw new HttpException({ code: 'LOGIN_RATE_LIMITED' }, 429);
  }
}
