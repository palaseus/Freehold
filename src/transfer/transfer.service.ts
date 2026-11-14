import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { idempotencyKeyHash } from '../common/idempotency-hash';
import { DatabaseService } from '../database/database.service';
import { RestrictedFunctions } from '../database/restricted-functions.service';
import { AccountService } from '../account/account.service';
import type { Principal } from '../auth/auth.types';
import { CustomerTransferDto } from './transfer.dto';
@Injectable()
export class TransferService {
  constructor(private readonly db: DatabaseService, private readonly functions: RestrictedFunctions, private readonly accounts: AccountService) {}
  execute(principal: Principal, dto: CustomerTransferDto, key: string) {
    const correlationId = randomUUID();
    return this.db.transaction(principal, async client => {
      // Defense in depth after the guard. Do NOT lock source first here: the
      // database function acquires all customer account locks in UUID order.
      await this.accounts.assertOwned(dto.sourceAccountId, principal, client);
      return this.functions.transfer(client, principal.user.id, dto.sourceAccountId, dto.destinationAccountId,
        dto.currency, dto.amountMinor, key, correlationId);
    }, false, { operationType: 'TRANSFER', correlationId, idempotencyKeyHash: idempotencyKeyHash(key) });
  }
}
