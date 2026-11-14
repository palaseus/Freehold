import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { Principal } from '../auth/auth.types';
import { SessionGuard, CsrfGuard } from '../auth/auth.guards';
import { CurrentPrincipal, FinancialApi, IdempotencyKey } from '../common/http';
import { HistoryQueryDto } from './history.dto';
import { HistoryService } from './history.service';
import { AccountService } from './account.service';
import { BalanceResponse, CreateAccountDto } from './account.dto';
import { AccountOwnershipGuard, OwnAccount } from './ownership.guard';
import { StatementQueryDto } from './statement.dto';
import { StatementService } from './statement.service';
import { ControlsService } from './controls.service';
import { AccountControlPatchDto, TrustDestinationDto } from '../schedule/schedule.dto';
@ApiTags('accounts') @ApiCookieAuth('session')
@Controller('accounts') @UseGuards(SessionGuard, CsrfGuard)
export class AccountController {
  constructor(private readonly accounts: AccountService, private readonly history: HistoryService, private readonly statements: StatementService, private readonly controls: ControlsService) {}
  @Post() @HttpCode(200) @FinancialApi()
  async create(@CurrentPrincipal() principal: Principal, @Body() dto: CreateAccountDto,
    @IdempotencyKey() key: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.accounts.create(principal, dto.currency, key);
    reply.code(result.status); return result.body;
  }
  @Get() @ApiOkResponse({ type: [BalanceResponse] })
  list(@CurrentPrincipal() principal: Principal) { return this.accounts.list(principal); }
  @Get(':id/transactions') @UseGuards(AccountOwnershipGuard) @OwnAccount('params', 'id')
  transactions(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Query() query: HistoryQueryDto) {
    return this.history.list(id, principal, query);
  }
  @Get(':id/statement') @UseGuards(AccountOwnershipGuard) @OwnAccount('params', 'id')
  statement(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Query() query: StatementQueryDto) {
    return this.statements.read(principal, id, query);
  }
  @Get(':id/statement.csv') @UseGuards(AccountOwnershipGuard) @OwnAccount('params', 'id')
  async statementCsv(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Query() query: StatementQueryDto, @Res({ passthrough: false }) reply: FastifyReply) {
    const body = await this.statements.csv(principal, id, query);
    reply.header('content-disposition', `attachment; filename="statement-${id}.csv"`);
    reply.type('text/csv; charset=utf-8').send(body);
  }
  @Get(':id/statement.pdf') @UseGuards(AccountOwnershipGuard) @OwnAccount('params', 'id')
  async statementPdf(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Query() query: StatementQueryDto, @Res({ passthrough: false }) reply: FastifyReply) {
    const body = await this.statements.pdf(principal, id, query);
    reply.header('content-disposition', `attachment; filename="statement-${id}.pdf"`);
    reply.type('application/pdf').send(body);
  }
  @Get(':id/limits') @UseGuards(AccountOwnershipGuard) @OwnAccount('params', 'id')
  limits(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.statements.limits(principal, id);
  }
  @Get(':id/balances') @UseGuards(AccountOwnershipGuard) @OwnAccount('params', 'id')
  @ApiOkResponse({ type: BalanceResponse })
  balances(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.balances(id, principal);
  }
  @Get(':id/controls') @UseGuards(AccountOwnershipGuard) @OwnAccount('params', 'id')
  controlState(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.controls.get(principal, id);
  }
  @Post(':id/controls') @HttpCode(200) @UseGuards(AccountOwnershipGuard) @OwnAccount('params', 'id')
  setControls(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AccountControlPatchDto) {
    return this.controls.set(principal, id, dto as unknown as Record<string, unknown>);
  }
  @Post(':id/trusted-destinations') @HttpCode(200) @UseGuards(AccountOwnershipGuard) @OwnAccount('params', 'id')
  trust(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TrustDestinationDto) {
    return this.controls.trust(principal, id, dto.destinationAccountId);
  }
}
