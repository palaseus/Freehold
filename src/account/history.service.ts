import { BadRequestException, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { Principal } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { HistoryQueryDto } from './history.dto';
interface Activity {
  id: string; journalId: string; kind: string; direction: 'DEBIT'|'CREDIT'; amountMinor: string;
  currency: string; effectiveAt: string; recordedAt: string; correlationId: string;
  counterpartyAccountId: string|null; cursorTime: string;
}
@Injectable()
export class HistoryService {
  constructor(private readonly db: DatabaseService) {}
  async list(account: string, principal: Principal, query: HistoryQueryDto) {
    let seek: { time: string; id: string } | null = null;
    if (query.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
        // Preserve PostgreSQL microseconds; JS Date roundtrips would lose records.
        if (decoded.account !== account || typeof decoded.time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(decoded.time) ||
            !Number.isFinite(Date.parse(decoded.time)) || !isUUID(decoded.id)) throw new Error();
        seek = decoded;
      } catch { throw new BadRequestException('INVALID_CURSOR'); }
    }
    const rows = await this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ items: Activity[] }>(
        'SELECT freehold.customer_account_activity($1::uuid,$2::uuid,$3::timestamptz,$4::uuid,$5::integer) AS items',
        [principal.user.id, account, seek?.time ?? null, seek?.id ?? null, query.limit + 1], client);
      return row?.items ?? [];
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor = rows.length > query.limit && last
      ? Buffer.from(JSON.stringify({ account, time: last.cursorTime, id: last.id })).toString('base64url') : null;
    return { items: page.map(({ cursorTime: _time, ...item }) => item), nextCursor };
  }
}
