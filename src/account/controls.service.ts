import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { Principal } from '../auth/auth.types';

@Injectable()
export class ControlsService {
  constructor(private readonly db: DatabaseService) {}
  get(principal: Principal, accountId: string) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ controls: unknown }>('SELECT freehold.account_controls_get($1::uuid,$2::uuid) AS controls', [principal.user.id, accountId], client);
      return row?.controls;
    });
  }
  set(principal: Principal, accountId: string, patch: Record<string, unknown>) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ controls: unknown }>('SELECT freehold.account_controls_set($1::uuid,$2::uuid,$3::jsonb) AS controls', [principal.user.id, accountId, JSON.stringify(patch)], client);
      return row?.controls;
    });
  }
  trust(principal: Principal, accountId: string, destinationAccountId: string) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ controls: unknown }>('SELECT freehold.trusted_destination_add($1::uuid,$2::uuid,$3::uuid) AS controls', [principal.user.id, accountId, destinationAccountId], client);
      return row?.controls;
    });
  }
}
