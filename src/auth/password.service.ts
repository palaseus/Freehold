import { Injectable, OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
@Injectable()
export class PasswordService implements OnModuleInit {
  private dummyHash = '';
  async onModuleInit() { this.dummyHash = await this.hash(randomBytes(32).toString('hex')); }
  hash(password: string) {
    return argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
  }
  async verify(hash: string | undefined, password: string): Promise<boolean> {
    try { return await argon2.verify(hash?.startsWith('$argon2id$') ? hash : this.dummyHash, password); }
    catch { return false; }
  }
}
