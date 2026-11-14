import { ForbiddenException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { idempotencyKeyHash } from '../common/idempotency-hash';
import { DatabaseService } from '../database/database.service';
import { RestrictedFunctions } from '../database/restricted-functions.service';
import type { Principal } from '../auth/auth.types';
import { BalanceResponse } from './account.dto';
@Injectable()
export class AccountService {
  constructor(private readonly db: DatabaseService, private readonly functions: RestrictedFunctions) {}
  async assertOwned(account: string, principal: Principal, client?: PoolClient) {
    const read = async (bound: PoolClient) => {
      const [row] = await this.db.read<{ ok: boolean }>('SELECT freehold.customer_account_owns($1::uuid,$2::uuid) AS ok', [principal.user.id, account], bound);
      if (!row?.ok) throw new ForbiddenException('ACCOUNT_NOT_AUTHORIZED');
    };
    if (client) return read(client);
    return this.db.transaction(principal, read);
  }
  create(principal: Principal, currency: string, key: string) {
    const correlationId = randomUUID();
    return this.db.transaction(principal, c => this.functions.createAccount(c, principal.user.id, currency, key, correlationId), false,
      { operationType: 'CREATE_ACCOUNT', correlationId, idempotencyKeyHash: idempotencyKeyHash(key) });
  }
  list(principal: Principal) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ items: BalanceResponse[] }>('SELECT freehold.customer_account_list($1::uuid) AS items', [principal.user.id], client);
      return row?.items ?? [];
    });
  }
  async balances(account: string, principal: Principal) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ item: BalanceResponse | null }>('SELECT freehold.customer_account_get($1::uuid,$2::uuid) AS item', [principal.user.id, account], client);
      if (!row?.item) throw new ForbiddenException('ACCOUNT_NOT_AUTHORIZED');
      return row.item;
    });
  }
}
