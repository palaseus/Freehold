import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../auth/auth.types';
import { CsrfGuard, SessionGuard } from '../auth/auth.guards';
import { CurrentPrincipal } from '../common/http';
import {
  NetworkAcceptDto, NetworkApplyDto, NetworkCertificateDto, NetworkCertificateRevokeDto, NetworkConfirmDto, NetworkCurrenciesDto, NetworkCycleDto,
  NetworkCycleIdDto, NetworkLiquidityDto, NetworkMessageDto, NetworkPaymentDto, NetworkPaymentIdDto, NetworkRulebookDto,
  NetworkRulebookIdDto, NetworkStressDto, NetworkTransitionDto,
} from './network.dto';
import { NetworkService } from './network.service';

@ApiTags('institution') @ApiCookieAuth('session')
@Controller('institution/network') @UseGuards(SessionGuard, CsrfGuard)
export class NetworkController {
  constructor(private readonly network: NetworkService) {}
  private cid(header?: string) { return this.network.correlation(header); }

  @Get('dashboard')
  dashboard(@CurrentPrincipal() principal: Principal, @Headers('x-correlation-id') header?: string) {
    return this.network.dashboard(principal, this.cid(header));
  }

  @Get('payments/:institutionId/:paymentId')
  payment(@CurrentPrincipal() principal: Principal, @Param('institutionId', ParseUUIDPipe) institutionId: string, @Param('paymentId', ParseUUIDPipe) paymentId: string, @Headers('x-correlation-id') header?: string) {
    return this.network.payment(principal, institutionId, paymentId, this.cid(header));
  }

  @Get('cycles/:cycleId')
  cycle(@CurrentPrincipal() principal: Principal, @Param('cycleId', ParseUUIDPipe) cycleId: string, @Headers('x-correlation-id') header?: string) {
    return this.network.cycle(principal, cycleId, this.cid(header));
  }

  @Post('members/apply') @HttpCode(200)
  apply(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkApplyDto, @Headers('x-correlation-id') header?: string) {
    return this.network.apply(principal, dto.institutionId, this.cid(header));
  }

  @Post('members/transition') @HttpCode(200)
  transition(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkTransitionDto, @Headers('x-correlation-id') header?: string) {
    return this.network.transition(principal, dto.institutionId, dto.toStatus, this.cid(header));
  }

  @Post('members/currencies') @HttpCode(200)
  currencies(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkCurrenciesDto, @Headers('x-correlation-id') header?: string) {
    return this.network.currencies(principal, dto.institutionId, dto.currencies, this.cid(header));
  }

  @Post('rulebooks') @HttpCode(200)
  propose(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkRulebookDto, @Headers('x-correlation-id') header?: string) {
    return this.network.propose(principal, dto.versionLabel, dto.body, this.cid(header));
  }

  @Post('rulebooks/adopt') @HttpCode(200)
  adopt(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkRulebookIdDto, @Headers('x-correlation-id') header?: string) {
    return this.network.adopt(principal, dto.rulebookId, this.cid(header));
  }

  @Post('rulebooks/accept') @HttpCode(200)
  accept(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkAcceptDto, @Headers('x-correlation-id') header?: string) {
    return this.network.accept(principal, dto.institutionId, dto.rulebookId, this.cid(header));
  }

  @Post('certificates') @HttpCode(200)
  certificate(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkCertificateDto, @Headers('x-correlation-id') header?: string) {
    return this.network.registerCertificate(principal, dto.institutionId, dto.publicKeyHex, dto.notBefore, dto.notAfter, this.cid(header));
  }

  @Post('certificates/revoke') @HttpCode(200)
  revokeCertificate(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkCertificateRevokeDto, @Headers('x-correlation-id') header?: string) {
    return this.network.revokeCertificate(principal, dto.institutionId, dto.certificateId, this.cid(header));
  }

  @Post('liquidity') @HttpCode(200)
  liquidity(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkLiquidityDto, @Headers('x-correlation-id') header?: string) {
    return this.network.liquidity(principal, dto.institutionId, dto.openingMinor, dto.capacityMinor, dto.netDebitLimitMinor, this.cid(header));
  }

  @Post('payments') @HttpCode(200)
  paymentOpen(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkPaymentDto, @Headers('x-correlation-id') header?: string) {
    return this.network.openPayment(principal, dto, this.cid(header));
  }

  @Post('payments/validate') @HttpCode(200)
  validate(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkPaymentIdDto, @Headers('x-correlation-id') header?: string) {
    return this.network.validate(principal, dto.paymentId, this.cid(header));
  }

  @Post('payments/cancel') @HttpCode(200)
  cancel(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkPaymentIdDto, @Headers('x-correlation-id') header?: string) {
    return this.network.cancel(principal, dto.paymentId, this.cid(header));
  }

  @Post('payments/reject') @HttpCode(200)
  reject(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkPaymentIdDto, @Headers('x-correlation-id') header?: string) {
    return this.network.reject(principal, dto.paymentId, this.cid(header));
  }

  @Post('cycles') @HttpCode(200)
  build(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkCycleDto, @Headers('x-correlation-id') header?: string) {
    return this.network.build(principal, dto.kind, dto.currency, dto.memberIds, this.cid(header));
  }

  @Post('cycles/finalize') @HttpCode(200)
  finalizeCycle(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkCycleIdDto, @Headers('x-correlation-id') header?: string) {
    return this.network.finalizeCycle(principal, dto.cycleId, this.cid(header));
  }

  @Post('settlements/submit') @HttpCode(200)
  submit(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkCycleIdDto, @Headers('x-correlation-id') header?: string) {
    return this.network.submit(principal, dto.cycleId, this.cid(header));
  }

  @Post('settlements/confirm') @HttpCode(200)
  confirm(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkConfirmDto, @Headers('x-correlation-id') header?: string) {
    return this.network.confirm(principal, dto.cycleId, dto.signature, this.cid(header));
  }

  @Post('settlements/unknown') @HttpCode(200)
  unknown(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkCycleIdDto, @Headers('x-correlation-id') header?: string) {
    return this.network.unknown(principal, dto.cycleId, this.cid(header));
  }

  @Post('settlements/finalize') @HttpCode(200)
  finalizeSettlement(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkCycleIdDto, @Headers('x-correlation-id') header?: string) {
    return this.network.finalizeSettlement(principal, dto.cycleId, this.cid(header));
  }

  @Post('settlements/reverse') @HttpCode(200)
  reverse(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkPaymentIdDto, @Headers('x-correlation-id') header?: string) {
    return this.network.reverse(principal, dto.paymentId, this.cid(header));
  }

  @Post('messages') @HttpCode(200)
  message(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkMessageDto, @Headers('x-correlation-id') header?: string) {
    return this.network.message(principal, dto.paymentId, dto.family, dto.messageId, dto.body, this.cid(header));
  }

  @Post('risk') @HttpCode(200)
  stress(@CurrentPrincipal() principal: Principal, @Body() dto: NetworkStressDto, @Headers('x-correlation-id') header?: string) {
    return this.network.stress(principal, dto.institutionId, dto.scenario, this.cid(header));
  }

  @Post('activation') @HttpCode(200)
  activate(@CurrentPrincipal() principal: Principal, @Headers('x-correlation-id') header?: string) {
    return this.network.activate(principal, this.cid(header));
  }
}
