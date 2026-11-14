import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../auth/auth.types';
import { CsrfGuard, SessionGuard } from '../auth/auth.guards';
import { CurrentPrincipal } from '../common/http';
import {
  ProgramAssetIdDto, ProgramAssetIssueDto, ProgramAssetRegisterDto, ProgramAssetTransferDto, ProgramCollateralIdDto,
  ProgramCollateralPledgeDto, ProgramCoordinateDto, ProgramEscrowFundDto, ProgramEscrowIdDto, ProgramEscrowKeyDto,
  ProgramEscrowReleaseDto, ProgramFusdRequestDto, ProgramInstitutionDto, ProgramPolicyDraftDto, ProgramPolicyIdDto,
  ProgramQuoteExecuteDto, ProgramQuoteOpenDto, ProgramSettleDto, ProgramSuspendDto, ProgramTreasuryExecuteDto,
  ProgramTreasuryIdDto, ProgramTreasuryRecommendDto, ProgramWorkflowDraftDto, ProgramWorkflowExecuteDto, ProgramWorkflowIdDto,
} from './program.dto';
import { ProgramService } from './program.service';

@ApiTags('institution') @ApiCookieAuth('session')
@Controller('institution/program') @UseGuards(SessionGuard, CsrfGuard)
export class ProgramController {
  constructor(private readonly program: ProgramService) {}
  private cid(header?: string) { return this.program.correlation(header); }

  @Get('dashboard')
  dashboard(@CurrentPrincipal() principal: Principal, @Headers('x-correlation-id') header?: string) {
    return this.program.dashboard(principal, this.cid(header));
  }

  @Get('workflows/:workflowId')
  workflow(@CurrentPrincipal() principal: Principal, @Param('workflowId', ParseUUIDPipe) workflowId: string, @Headers('x-correlation-id') header?: string) {
    return this.program.workflowGet(principal, workflowId, this.cid(header));
  }

  @Get('treasury/:institutionId')
  treasury(@CurrentPrincipal() principal: Principal, @Param('institutionId', ParseUUIDPipe) institutionId: string, @Headers('x-correlation-id') header?: string) {
    return this.program.treasuryMonitor(principal, institutionId, this.cid(header));
  }

  @Post('policies') @HttpCode(200)
  policyDraft(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramPolicyDraftDto, @Headers('x-correlation-id') header?: string) {
    return this.program.policyDraft(principal, dto.institutionId, dto.domain, dto.body, dto.precedence, dto.maxExposureMinor, dto.currency, dto.effectiveFrom, dto.effectiveUntil, this.cid(header));
  }

  @Post('policies/approve') @HttpCode(200)
  policyApprove(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramPolicyIdDto, @Headers('x-correlation-id') header?: string) {
    return this.program.policyApprove(principal, dto.policyId, this.cid(header));
  }

  @Post('policies/retire') @HttpCode(200)
  policyRetire(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramPolicyIdDto, @Headers('x-correlation-id') header?: string) {
    return this.program.policyRetire(principal, dto.policyId, this.cid(header));
  }

  @Post('workflows') @HttpCode(200)
  workflowDraft(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramWorkflowDraftDto, @Headers('x-correlation-id') header?: string) {
    return this.program.workflowDraft(principal, dto.institutionId, dto.definition, dto.maxExposureMinor, dto.currency, dto.deadline, dto.idempotencyKey, dto.requiredApprovals, this.cid(header));
  }

  @Post('workflows/submit') @HttpCode(200)
  workflowSubmit(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramWorkflowIdDto, @Headers('x-correlation-id') header?: string) {
    return this.program.workflowSubmit(principal, dto.workflowId, this.cid(header));
  }

  @Post('workflows/approve') @HttpCode(200)
  workflowApprove(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramWorkflowIdDto, @Headers('x-correlation-id') header?: string) {
    return this.program.workflowApprove(principal, dto.workflowId, this.cid(header));
  }

  @Post('workflows/execute') @HttpCode(200)
  workflowExecute(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramWorkflowExecuteDto, @Headers('x-correlation-id') header?: string) {
    return this.program.workflowExecute(principal, dto.workflowId, dto.idempotencyKey, this.cid(header));
  }

  @Post('workflows/cancel') @HttpCode(200)
  workflowCancel(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramWorkflowIdDto, @Headers('x-correlation-id') header?: string) {
    return this.program.workflowCancel(principal, dto.workflowId, this.cid(header));
  }

  @Post('workflows/preview') @HttpCode(200)
  workflowPreview(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramWorkflowIdDto, @Headers('x-correlation-id') header?: string) {
    return this.program.workflowPreview(principal, dto.workflowId, this.cid(header));
  }

  @Post('settlements') @HttpCode(200)
  settle(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramSettleDto, @Headers('x-correlation-id') header?: string) {
    return this.program.settle(principal, dto.institutionId, dto.idempotencyKey, dto.deadline, dto.legs, this.cid(header));
  }

  @Post('settlements/coordinate') @HttpCode(200)
  coordinate(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramCoordinateDto, @Headers('x-correlation-id') header?: string) {
    return this.program.coordinate(principal, dto.institutionId, dto.idempotencyKey, dto.legs, this.cid(header));
  }

  @Post('escrows') @HttpCode(200)
  escrowFund(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramEscrowFundDto, @Headers('x-correlation-id') header?: string) {
    return this.program.escrowFund(principal, dto.institutionId, dto.sourceAccountId, dto.amountMinor, dto.beneficiaryInstitutionId, dto.beneficiaryRef, dto.conditions, dto.expiresAt, dto.idempotencyKey, this.cid(header));
  }

  @Post('escrows/release') @HttpCode(200)
  escrowRelease(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramEscrowReleaseDto, @Headers('x-correlation-id') header?: string) {
    return this.program.escrowRelease(principal, dto.escrowId, dto.toAccountId, this.cid(header));
  }

  @Post('escrows/return') @HttpCode(200)
  escrowReturn(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramEscrowKeyDto, @Headers('x-correlation-id') header?: string) {
    return this.program.escrowReturn(principal, dto.escrowId, dto.idempotencyKey, this.cid(header));
  }

  @Post('escrows/dispute') @HttpCode(200)
  escrowDispute(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramEscrowIdDto, @Headers('x-correlation-id') header?: string) {
    return this.program.escrowDispute(principal, dto.escrowId, this.cid(header));
  }

  @Post('treasury/recommendations') @HttpCode(200)
  treasuryRecommend(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramTreasuryRecommendDto, @Headers('x-correlation-id') header?: string) {
    return this.program.treasuryRecommend(principal, dto.institutionId, dto.movement, dto.amountMinor, dto.currency, dto.fromKind, dto.toKind, this.cid(header));
  }

  @Post('treasury/approve') @HttpCode(200)
  treasuryApprove(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramTreasuryIdDto, @Headers('x-correlation-id') header?: string) {
    return this.program.treasuryApprove(principal, dto.treasuryId, this.cid(header));
  }

  @Post('treasury/execute') @HttpCode(200)
  treasuryExecute(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramTreasuryExecuteDto, @Headers('x-correlation-id') header?: string) {
    return this.program.treasuryExecute(principal, dto.treasuryId, dto.idempotencyKey, this.cid(header));
  }

  @Post('assets') @HttpCode(200)
  assetRegister(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramAssetRegisterDto, @Headers('x-correlation-id') header?: string) {
    return this.program.assetRegister(principal, dto.institutionId, dto.assetType, dto.code, dto.denomination, this.cid(header));
  }

  @Post('assets/authorize') @HttpCode(200)
  assetAuthorize(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramAssetIdDto, @Headers('x-correlation-id') header?: string) {
    return this.program.assetAuthorize(principal, dto.assetId, this.cid(header));
  }

  @Post('assets/issue') @HttpCode(200)
  assetIssue(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramAssetIssueDto, @Headers('x-correlation-id') header?: string) {
    return this.program.assetIssue(principal, dto.institutionId, dto.assetId, dto.quantityMinor, dto.idempotencyKey, this.cid(header));
  }

  @Post('assets/transfer') @HttpCode(200)
  assetTransfer(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramAssetTransferDto, @Headers('x-correlation-id') header?: string) {
    return this.program.assetTransfer(principal, dto.fromInstitutionId, dto.assetId, dto.toInstitutionId, dto.quantityMinor, dto.idempotencyKey, this.cid(header));
  }

  @Post('exchange/admit') @HttpCode(200)
  admit(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramInstitutionDto, @Headers('x-correlation-id') header?: string) {
    return this.program.exchangeAdmit(principal, dto.institutionId, this.cid(header));
  }

  @Post('quotes') @HttpCode(200)
  quoteOpen(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramQuoteOpenDto, @Headers('x-correlation-id') header?: string) {
    return this.program.quoteOpen(principal, dto.institutionId, dto.baseAssetId, dto.quoteAssetId, dto.unitPriceMinor, dto.quantityMinor, dto.kind, dto.expiresAt, this.cid(header));
  }

  @Post('quotes/execute') @HttpCode(200)
  quoteExecute(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramQuoteExecuteDto, @Headers('x-correlation-id') header?: string) {
    return this.program.quoteExecute(principal, dto.buyerInstitutionId, dto.quoteId, dto.unitPriceMinor, dto.idempotencyKey, this.cid(header));
  }

  @Post('collateral') @HttpCode(200)
  pledge(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramCollateralPledgeDto, @Headers('x-correlation-id') header?: string) {
    return this.program.collateralPledge(principal, dto.institutionId, dto.assetId, dto.quantityMinor, dto.haircutBps, dto.arrangementKey, this.cid(header));
  }

  @Post('collateral/release') @HttpCode(200)
  collateralRelease(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramCollateralIdDto, @Headers('x-correlation-id') header?: string) {
    return this.program.collateralRelease(principal, dto.collateralId, this.cid(header));
  }

  @Post('fusd/requests') @HttpCode(200)
  fusd(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramFusdRequestDto, @Headers('x-correlation-id') header?: string) {
    return this.program.fusdRequest(principal, dto.institutionId, dto.bookId, dto.amountMinor, dto.idempotencyKey, dto.notBefore, this.cid(header));
  }

  @Post('suspension') @HttpCode(200)
  suspend(@CurrentPrincipal() principal: Principal, @Body() dto: ProgramSuspendDto, @Headers('x-correlation-id') header?: string) {
    return this.program.suspend(principal, dto.institutionId, dto.suspend, this.cid(header));
  }

  @Post('activation') @HttpCode(200)
  activate(@CurrentPrincipal() principal: Principal, @Headers('x-correlation-id') header?: string) {
    return this.program.activate(principal, this.cid(header));
  }
}
