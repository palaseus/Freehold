import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createCipheriv, randomBytes, createDecipheriv } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { Config } from '../config/config.module';
import { SessionService } from './session.service';
@Injectable()
export class TotpService {
  constructor(private readonly config: Config, private readonly sessions: SessionService) {}
  encrypt(secret: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.config.totpKey, iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]);
  }
  verifyEnrollment(secret: string, token: string | undefined) {
    if (!token || new TOTP({ secret: Secret.fromBase32(secret) }).validate({ token, window: 1 }) === null) {
      throw new UnauthorizedException('INVALID_TOTP');
    }
  }
  async verify(userId: string, encrypted: Buffer, token: string | undefined): Promise<number> {
    if (!token || !/^\d{6}$/.test(token)) throw new UnauthorizedException('INVALID_CREDENTIALS');
    // Provisioned envelope: version(1)=1 | IV(12) | GCM tag(16) | ciphertext.
    // Key lives outside PostgreSQL. Registration can enroll TOTP with a proof.
    if (encrypted[0] !== 1 || encrypted.length < 30) throw new Error('Invalid TOTP secret envelope');
    const decipher = createDecipheriv('aes-256-gcm', this.config.totpKey, encrypted.subarray(1, 13));
    decipher.setAuthTag(encrypted.subarray(13, 29));
    const secret = Buffer.concat([decipher.update(encrypted.subarray(29)), decipher.final()]).toString('utf8');
    const timestamp = Date.now();
    const totp = new TOTP({ secret: Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: 30 });
    const delta = totp.validate({ token, timestamp, window: 1 });
    if (delta === null || !await this.sessions.consumeTotp(userId, totp.counter({ timestamp }) + delta)) {
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }
    return timestamp;
  }
}
