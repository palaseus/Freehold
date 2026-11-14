import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { Principal } from '../auth/auth.types';
import type { ScheduleCreateDto } from './schedule.dto';

@Injectable()
export class ScheduleService {
  constructor(private readonly db: DatabaseService) {}
  list(principal: Principal) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ items: unknown }>('SELECT freehold.scheduled_transfer_list($1::uuid,$2::integer) AS items', [principal.user.id, 50], client);
      return row?.items ?? [];
    });
  }
  create(principal: Principal, dto: ScheduleCreateDto, key: string) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ item: unknown }>(
        'SELECT freehold.scheduled_transfer_create($1::uuid,$2::uuid,$3::uuid,$4::text,$5::bigint,$6::text,$7::timestamptz,$8::text) AS item',
        [principal.user.id, dto.sourceAccountId, dto.destinationAccountId, dto.currency, dto.amountMinor, dto.cadence, dto.nextExecutionAt, key], client);
      return row?.item;
    });
  }
  cancel(principal: Principal, instructionId: string) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ item: unknown }>('SELECT freehold.scheduled_transfer_cancel($1::uuid,$2::uuid) AS item', [principal.user.id, instructionId], client);
      return row?.item;
    });
  }
}
