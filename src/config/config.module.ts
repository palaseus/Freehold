import { Global, Injectable, Module } from '@nestjs/common';
import { assertProductionProcess } from './production-posture';

@Injectable()
export class Config {
  readonly databaseUrl = this.url('DATABASE_URL', ['postgres:', 'postgresql:']);
  readonly redisUrl = this.url('REDIS_URL', ['redis:', 'rediss:']);
  readonly authServiceUrl = this.url('AUTH_SERVICE_URL', ['http:', 'https:']);
  readonly authInternalToken = this.required('AUTH_INTERNAL_TOKEN');
  readonly totpKey = Buffer.from(this.required('TOTP_ENCRYPTION_KEY'), 'base64');
  readonly origin = new URL(process.env.APP_ORIGIN ?? 'http://localhost:3000').origin;
  readonly cookieSecure = process.env.COOKIE_SECURE !== 'false';
  readonly sessionTtlSeconds = 12 * 60 * 60;
  readonly recentTwoFactorMs = 5 * 60 * 1000;
  readonly demoMode = process.env.DEMO_MODE === 'true';
  readonly demoBootstrapToken = process.env.DEMO_BOOTSTRAP_TOKEN ?? '';
  readonly port = Number(process.env.PORT ?? 3000);

  constructor() {
    if (process.env.AUTH_DATABASE_URL) throw new Error('Financial API must not hold AUTH_DATABASE_URL');
    if (this.authInternalToken.length < 32) throw new Error('AUTH_INTERNAL_TOKEN must have at least 32 characters');
    if (this.demoMode && this.demoBootstrapToken.length < 32) throw new Error('Demo bootstrap token must have at least 32 characters');
    if (this.totpKey.length !== 32) throw new Error('TOTP_ENCRYPTION_KEY must encode 32 bytes');
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) throw new Error('Invalid PORT');
    if (process.env.NODE_ENV === 'production' && (!this.cookieSecure || !this.origin.startsWith('https://'))) {
      throw new Error('Production requires HTTPS origin and secure cookies');
    }
    assertProductionProcess('api');
  }
  private required(key: string): string {
    const value = process.env[key];
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  }
  private url(key: string, protocols: string[]): string {
    const value = this.required(key);
    if (!protocols.includes(new URL(value).protocol)) throw new Error(`Invalid ${key} protocol`);
    return value;
  }
}
@Global()
@Module({ providers: [Config], exports: [Config] })
export class ConfigModule {}
