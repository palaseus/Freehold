import { Body, Controller, Get, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { Principal } from '../auth/auth.types';
import { SessionGuard, CsrfGuard } from '../auth/auth.guards';
import { AccountOwnershipGuard, OwnAccount } from '../account/ownership.guard';
import { CurrentPrincipal, FinancialApi, IdempotencyKey } from '../common/http';
import { CustomerTransferDto } from './transfer.dto';
import { TransferService } from './transfer.service';
import { DatabaseService } from '../database/database.service';
@ApiTags('transfers') @Controller('transfers')
@UseGuards(SessionGuard, CsrfGuard)
export class TransferController {
  constructor(private readonly transfers: TransferService, private readonly db: DatabaseService) {}
  @Get('resolve')
  async resolve(@CurrentPrincipal() principal: Principal, @IdempotencyKey() key: string) {
    const [row] = await this.db.transaction(principal, client => this.db.read<{ item: { found: boolean; status?: number; result?: unknown } }>(
      'SELECT freehold.customer_idempotency_get($1::uuid,$2::text,$3::text) AS item',
      [principal.user.id, 'TRANSFER', key], client));
    return row?.item ?? { found: false };
  }
  @Post() @HttpCode(200) @UseGuards(AccountOwnershipGuard) @OwnAccount('body', 'sourceAccountId') @FinancialApi()
  async execute(@CurrentPrincipal() principal: Principal, @Body() dto: CustomerTransferDto,
    @IdempotencyKey() key: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.transfers.execute(principal, dto, key);
    reply.code(result.status); return result.body;
  }
}
