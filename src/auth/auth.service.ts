import { BadRequestException, HttpException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Config } from '../config/config.module';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { TotpService } from './totp.service';
import { LoginDto, RegisterDto } from './auth.dto';

interface AuthLoginResult {
  userId: string;
  authVersion: string;
  twoFactorAt: number | null;
  dbSecret: string;
}
interface AuthRegisterResult { userId: string }

@Injectable()
export class AuthService {
  constructor(private readonly passwords: PasswordService, private readonly sessions: SessionService,
    private readonly totp: TotpService, private readonly config: Config) {}

  async register(dto: RegisterDto) {
    await this.sessions.throttleLogin(dto.email);
    if (dto.password.length < 12) throw new BadRequestException('PASSWORD_MINIMUM_12_CHARACTERS');
    if (dto.totp && !dto.totpSecret) throw new BadRequestException('TOTP_SECRET_REQUIRED');
    if (dto.totpSecret) this.totp.verifyEnrollment(dto.totpSecret, dto.totp);
    const passwordHash = await this.passwords.hash(dto.password);
    const result = await this.post<AuthRegisterResult>('/v1/internal/register', {
      email: dto.email,
      passwordHash,
      totpEncryptedBase64: dto.totpSecret ? this.totp.encrypt(dto.totpSecret).toString('base64') : null,
    });
    return { userId: result.userId };
  }

  async login(dto: LoginDto) {
    await this.sessions.throttleLogin(dto.email);
    const result = await this.post<AuthLoginResult>('/v1/internal/login', {
      email: dto.email, password: dto.password, totp: dto.totp ?? null,
    });
    if (!/^[0-9a-f]{64}$/.test(result.dbSecret) || !result.userId || !result.authVersion) {
      throw new ServiceUnavailableException('AUTH_SERVICE_UNAVAILABLE');
    }
    return this.sessions.issue(result.userId, result.authVersion, result.twoFactorAt, result.dbSecret);
  }

  async logout(token: string) {
    const record = await this.sessions.load(token);
    if (record) await this.post('/v1/internal/revoke', { dbSecret: record.dbSecret });
    await this.sessions.revoke(token);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.config.authServiceUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-freehold-auth-token': this.config.authInternalToken },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new ServiceUnavailableException('AUTH_SERVICE_UNAVAILABLE');
    }
    if (response.status === 401) throw new UnauthorizedException('INVALID_CREDENTIALS');
    if (response.status === 429) throw new HttpException({ code: 'LOGIN_RATE_LIMITED' }, 429);
    if (response.status === 400) {
      const payload = await response.json().catch(() => null) as { code?: string } | null;
      throw new BadRequestException(payload?.code ?? 'INVALID_REQUEST');
    }
    if (response.status === 409) {
      const conflict = new Error('EMAIL_UNAVAILABLE') as Error & { code: string };
      conflict.code = '23505';
      throw conflict;
    }
    if (response.status === 204) return undefined as T;
    if (!response.ok) throw new ServiceUnavailableException('AUTH_SERVICE_UNAVAILABLE');
    return response.json() as Promise<T>;
  }
}
