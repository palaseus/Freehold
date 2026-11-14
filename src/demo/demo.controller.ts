import { BadRequestException, Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { RegisterDto } from '../auth/auth.dto';
import { AdminGuard, CsrfGuard, OriginGuard, SessionGuard } from '../auth/auth.guards';
import { PasswordService } from '../auth/password.service';
import { TotpService } from '../auth/totp.service';
import type { Principal } from '../auth/auth.types';
import { Config } from '../config/config.module';
import { idempotencyKeyHash } from '../common/idempotency-hash';
import { CurrentPrincipal, FinancialApi, IdempotencyKey } from '../common/http';
import { DatabaseService } from '../database/database.service';
import { RestrictedFunctions } from '../database/restricted-functions.service';
import { DemoBootstrapGuard, DemoGuard } from './demo.guards';
import { DemoFundDto } from './demo.dto';
@ApiTags('demo') @Controller('demo')
export class DemoController {
  constructor(private readonly config: Config, private readonly db: DatabaseService, private readonly passwords: PasswordService,
    private readonly totp: TotpService, private readonly functions: RestrictedFunctions) {}
  @Post('bootstrap') @HttpCode(201) @UseGuards(DemoBootstrapGuard, OriginGuard)
  async bootstrap(@Body() dto: RegisterDto) {
    if (!dto.totpSecret || dto.password.length < 12) throw new BadRequestException('DEMO_ADMIN_REQUIRES_TOTP_AND_STRONG_PASSWORD');
    this.totp.verifyEnrollment(dto.totpSecret, dto.totp);
    const hash = await this.passwords.hash(dto.password);
    const [result] = await this.db.read<{ id: string }>('SELECT freehold.demo_bootstrap_admin($1::text,$2::text,$3::text,$4::bytea) AS id',
      [this.config.demoBootstrapToken, dto.email, hash, this.totp.encrypt(dto.totpSecret)]);
    return { userId: result!.id, sandbox: true };
  }
  @Post('accounts/:id/fund') @HttpCode(200) @UseGuards(DemoGuard, SessionGuard, CsrfGuard, AdminGuard) @FinancialApi()
  async fund(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DemoFundDto,
    @IdempotencyKey() key: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const correlationId = randomUUID();
    const result = await this.db.transaction(principal, c => this.functions.sandboxFund(c, principal.user.id, id, dto.amountMinor, key, dto.reason, correlationId), true,
      { operationType: 'SANDBOX_FUND', correlationId, idempotencyKeyHash: idempotencyKeyHash(key) });
    reply.code(result.status); return result.body;
  }
}
