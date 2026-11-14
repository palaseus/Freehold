import { BadRequestException, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { writeJsonLog } from '../common/structured-log';
import { DatabaseService } from '../database/database.service';
import type { Principal } from '../auth/auth.types';
import { StatementQueryDto } from './statement.dto';
import { statementCsv, statementPdf, type AccountStatement } from './statement-document';

@Injectable()
export class StatementService {
  constructor(private readonly db: DatabaseService) {}
  async read(principal: Principal, accountId: string, query: StatementQueryDto): Promise<AccountStatement> {
    let beforeTime: string | null = null;
    let beforeId: string | null = null;
    if (query.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString()) as { time?: string; id?: string };
        if (typeof decoded.time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(decoded.time) || !isUUID(decoded.id)) throw new Error();
        beforeTime = decoded.time;
        beforeId = decoded.id ?? null;
      } catch { throw new BadRequestException('INVALID_CURSOR'); }
    }
    const statement = await this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ statement: AccountStatement }>(
        'SELECT freehold.account_statement($1::uuid,$2::uuid,$3::timestamptz,$4::timestamptz,$5::integer,$6::timestamptz,$7::uuid) AS statement',
        [principal.user.id, accountId, query.from, query.to, query.limit ?? 100, beforeTime, beforeId], client);
      return row!.statement;
    });
    const nextCursor = statement.nextCursorTime && statement.nextCursorId
      ? Buffer.from(JSON.stringify({ time: statement.nextCursorTime, id: statement.nextCursorId })).toString('base64url') : null;
    writeJsonLog({ level: 'info', service: 'api', event: 'statement_read', actor_id: principal.user.id,
      account_id: accountId, outcome: 'COMPLETED', line_count: statement.lines.length });
    return { ...statement, nextCursor } as AccountStatement & { nextCursor: string | null };
  }
  async csv(principal: Principal, accountId: string, query: StatementQueryDto) {
    return statementCsv(await this.read(principal, accountId, query));
  }
  async pdf(principal: Principal, accountId: string, query: StatementQueryDto) {
    return statementPdf(await this.read(principal, accountId, query));
  }
  limits(principal: Principal, accountId: string) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ limits: unknown }>(
        'SELECT freehold.account_applicable_limits($1::uuid,$2::uuid) AS limits', [principal.user.id, accountId], client);
      return row?.limits ?? [];
    });
  }
}
