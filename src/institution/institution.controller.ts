import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../auth/auth.types';
import { CsrfGuard, SessionGuard } from '../auth/auth.guards';
import { CurrentPrincipal, IdempotencyKey } from '../common/http';
import {
  InstitutionActivateDto, AdjustmentPostDto, AdjustmentProposeDto, BillingPlanDto, ComplianceDto, CredentialIssueDto, CredentialRevokeDto,
  CustomerOpenDto, DisputeNoteDto, DisputeOpenDto, DisputeResolveDto, FundDto, InstitutionGrantDto, InstitutionOpenDto,
  InstitutionPolicyDto, InvoiceDto, IssuanceLinkDto, PaymentOpenDto, PaymentTransitionDto, RiskDto, InstitutionTransferDto, TreasuryOpenDto,
  UsageDto, WebhookAttemptDto, WebhookOpenDto, WebhookRotateDto, WebhookSubscribeDto,
} from './institution.dto';
import { InstitutionService } from './institution.service';

@ApiTags('institution') @ApiCookieAuth('session')
@Controller('institution') @UseGuards(SessionGuard, CsrfGuard)
export class InstitutionController {
  constructor(private readonly institution: InstitutionService) {}
  private cid(header?: string) { return this.institution.correlation(header); }

  @Get('institutions')
  list(@CurrentPrincipal() principal: Principal, @Headers('x-correlation-id') header?: string) {
    return this.institution.list(principal, this.cid(header));
  }

  @Post('institutions') @HttpCode(200)
  open(@CurrentPrincipal() principal: Principal, @Body() dto: InstitutionOpenDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.open(principal, dto.code, dto.legalName, this.cid(header));
  }

  @Post('members') @HttpCode(200)
  grant(@CurrentPrincipal() principal: Principal, @Body() dto: InstitutionGrantDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.grant(principal, dto.institutionId, dto.memberId, dto.capability, this.cid(header));
  }

  @Post('policies') @HttpCode(200)
  policy(@CurrentPrincipal() principal: Principal, @Body() dto: InstitutionPolicyDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.policy(principal, dto.institutionId, dto.code, dto.thresholdMinor, this.cid(header));
  }

  @Post('credentials') @HttpCode(200)
  issue(@CurrentPrincipal() principal: Principal, @Body() dto: CredentialIssueDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.issueCredential(principal, dto.institutionId, dto.scopes, dto.ttlSeconds, this.cid(header));
  }

  @Post('credentials/revoke') @HttpCode(200)
  revoke(@CurrentPrincipal() principal: Principal, @Body() dto: CredentialRevokeDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.revokeCredential(principal, dto.institutionId, dto.keyId, this.cid(header));
  }

  @Post('customers') @HttpCode(200)
  customer(@CurrentPrincipal() principal: Principal, @Body() dto: CustomerOpenDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.openCustomer(principal, dto.institutionId, dto.externalRef, dto.displayName, dto.currency, this.cid(header));
  }

  @Post('funding') @HttpCode(200)
  fund(@CurrentPrincipal() principal: Principal, @Body() dto: FundDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.fund(principal, dto.institutionId, dto.accountId, dto.amountMinor, dto.idempotencyKey, this.cid(header));
  }

  @Post('transfers') @HttpCode(200)
  transfer(@CurrentPrincipal() principal: Principal, @Body() dto: InstitutionTransferDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.transfer(principal, dto.institutionId, dto.fromAccountId, dto.toAccountId, dto.amountMinor, dto.idempotencyKey, dto.correlationId ?? this.cid(header));
  }

  @Get('accounts/:institutionId/:accountId')
  account(@CurrentPrincipal() principal: Principal, @Param('institutionId', ParseUUIDPipe) institutionId: string, @Param('accountId', ParseUUIDPipe) accountId: string, @Headers('x-correlation-id') header?: string) {
    return this.institution.account(principal, institutionId, accountId, this.cid(header));
  }

  @Get('accounts/:institutionId/:accountId/activity')
  activity(@CurrentPrincipal() principal: Principal, @Param('institutionId', ParseUUIDPipe) institutionId: string, @Param('accountId', ParseUUIDPipe) accountId: string, @Headers('x-correlation-id') header?: string) {
    return this.institution.activity(principal, institutionId, accountId, this.cid(header));
  }

  @Post('treasury/accounts') @HttpCode(200)
  treasuryOpen(@CurrentPrincipal() principal: Principal, @Body() dto: TreasuryOpenDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.openTreasury(principal, dto.institutionId, dto.kind, dto.currency, dto.custodianLabel ?? null, this.cid(header));
  }

  @Get('treasury/:institutionId')
  treasury(@CurrentPrincipal() principal: Principal, @Param('institutionId', ParseUUIDPipe) institutionId: string, @Headers('x-correlation-id') header?: string) {
    return this.institution.treasury(principal, institutionId, this.cid(header));
  }

  @Post('payments') @HttpCode(200)
  payment(@CurrentPrincipal() principal: Principal, @Body() dto: PaymentOpenDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.openPayment(principal, dto.institutionId, dto.accountId, dto.amountMinor, dto.rail, dto.externalRef, dto.idempotencyKey, dto.correlationId ?? this.cid(header));
  }

  @Post('payments/transition') @HttpCode(200)
  transition(@CurrentPrincipal() principal: Principal, @Body() dto: PaymentTransitionDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.transition(principal, dto.institutionId, dto.paymentId, dto.state, dto.providerEventId ?? null, dto.signature ?? null, this.cid(header));
  }

  @Post('risk') @HttpCode(200)
  risk(@CurrentPrincipal() principal: Principal, @Body() dto: RiskDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.risk(principal, dto.institutionId, dto.scenario, this.cid(header));
  }

  @Post('webhooks') @HttpCode(200)
  webhook(@CurrentPrincipal() principal: Principal, @Body() dto: WebhookOpenDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.openWebhook(principal, dto.institutionId, dto.url, this.cid(header));
  }

  @Post('webhooks/subscribe') @HttpCode(200)
  subscribe(@CurrentPrincipal() principal: Principal, @Body() dto: WebhookSubscribeDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.subscribe(principal, dto.institutionId, dto.endpointId, dto.eventType, this.cid(header));
  }

  @Post('webhooks/attempt') @HttpCode(200)
  attempt(@CurrentPrincipal() principal: Principal, @Body() dto: WebhookAttemptDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.attempt(principal, dto.institutionId, dto.deliveryId, dto.outcome, dto.secret ?? null, this.cid(header));
  }

  @Post('webhooks/rotate') @HttpCode(200)
  rotate(@CurrentPrincipal() principal: Principal, @Body() dto: WebhookRotateDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.rotateWebhook(principal, dto.institutionId, dto.endpointId, this.cid(header));
  }

  @Post('disputes') @HttpCode(200)
  dispute(@CurrentPrincipal() principal: Principal, @Body() dto: DisputeOpenDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.openDispute(principal, dto.institutionId, dto.paymentId ?? null, dto.note, this.cid(header));
  }

  @Post('disputes/notes') @HttpCode(200)
  disputeNote(@CurrentPrincipal() principal: Principal, @Body() dto: DisputeNoteDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.noteDispute(principal, dto.institutionId, dto.disputeId, dto.note, this.cid(header));
  }

  @Post('disputes/resolve') @HttpCode(200)
  resolve(@CurrentPrincipal() principal: Principal, @Body() dto: DisputeResolveDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.resolveDispute(principal, dto.institutionId, dto.disputeId, dto.state, dto.resolution ?? null, this.cid(header));
  }

  @Post('adjustments') @HttpCode(200)
  propose(@CurrentPrincipal() principal: Principal, @Body() dto: AdjustmentProposeDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.proposeAdjustment(principal, dto.institutionId, dto.disputeId ?? null, dto.debitAccountId, dto.creditAccountId, dto.amountMinor, this.cid(header));
  }

  @Post('adjustments/post') @HttpCode(200)
  postAdjustment(@CurrentPrincipal() principal: Principal, @Body() dto: AdjustmentPostDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.postAdjustment(principal, dto.institutionId, dto.adjustmentId, this.cid(header));
  }

  @Post('billing/plan') @HttpCode(200)
  plan(@CurrentPrincipal() principal: Principal, @Body() dto: BillingPlanDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.plan(principal, dto.institutionId, dto.monthlyMinor, dto.apiCallMinor, dto.transactionMinor, dto.complianceMinor, dto.reportMinor, this.cid(header));
  }

  @Post('billing/usage') @HttpCode(200)
  usage(@CurrentPrincipal() principal: Principal, @Body() dto: UsageDto, @IdempotencyKey() key: string, @Headers('x-correlation-id') header?: string) {
    return this.institution.usage(principal, dto.institutionId, dto.periodStart, dto.meter, dto.quantity, this.cid(header), key);
  }

  @Post('billing/invoices') @HttpCode(200)
  invoice(@CurrentPrincipal() principal: Principal, @Body() dto: InvoiceDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.invoice(principal, dto.institutionId, dto.periodStart, this.cid(header));
  }

  @Get('billing/forecast/:institutionId')
  forecast(@CurrentPrincipal() principal: Principal, @Param('institutionId', ParseUUIDPipe) institutionId: string, @Query('factor') factor = '10000', @Headers('x-correlation-id') header?: string) {
    return this.institution.forecast(principal, institutionId, factor, this.cid(header));
  }

  @Post('compliance') @HttpCode(200)
  compliance(@CurrentPrincipal() principal: Principal, @Body() dto: ComplianceDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.compliance(principal, dto.institutionId, dto.subject, this.cid(header));
  }

  @Post('issuance-links') @HttpCode(200)
  link(@CurrentPrincipal() principal: Principal, @Body() dto: IssuanceLinkDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.linkIssuance(principal, dto.institutionId, dto.issuanceId, this.cid(header));
  }

  @Get('health/:institutionId')
  health(@CurrentPrincipal() principal: Principal, @Param('institutionId', ParseUUIDPipe) institutionId: string, @Headers('x-correlation-id') header?: string) {
    return this.institution.health(principal, institutionId, this.cid(header));
  }

  @Post('activation') @HttpCode(200)
  activate(@CurrentPrincipal() principal: Principal, @Body() _dto: InstitutionActivateDto, @Headers('x-correlation-id') header?: string) {
    return this.institution.activate(principal, this.cid(header));
  }
}
