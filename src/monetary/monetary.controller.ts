import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../auth/auth.types';
import { CsrfGuard, SessionGuard } from '../auth/auth.guards';
import { CurrentPrincipal, IdempotencyKey } from '../common/http';
import {
  MonetaryActivateDto, BankEventDto, BankOpenDto, CapRequestDto, CapitalDto, ChainObserveDto, ConversionDto,
  DisclosureAckDto, EncumberDto, EvidenceNoteDto, EvidenceOpenDto, FhuIssueDto, FreezeDto, GrantDto,
  IssueRequestDto, PartnerCheckDto, PartnerOpenDto, RedeemRequestDto, ReorgDto, ReportDraftDto,
  ReportTransitionDto, ReserveProposeDto, ReserveReviewDto, RestrictionDto, ScreenDto, SettlementDto, SuspendDto,
} from './monetary.dto';
import { MonetaryService } from './monetary.service';

@ApiTags('monetary') @ApiCookieAuth('session')
@Controller('monetary') @UseGuards(SessionGuard, CsrfGuard)
export class MonetaryController {
  constructor(private readonly monetary: MonetaryService) {}

  @Get('overview') overview(@CurrentPrincipal() principal: Principal) { return this.monetary.overview(principal); }

  @Get('activity') activity(@CurrentPrincipal() principal: Principal) { return this.monetary.activity(principal); }

  @Post('bank-accounts') @HttpCode(200)
  bankOpen(@CurrentPrincipal() principal: Principal, @Body() dto: BankOpenDto, @IdempotencyKey() key: string) {
    return this.monetary.bankOpen(principal, dto, key);
  }

  @Post('bank-events') @HttpCode(200)
  bankEvent(@CurrentPrincipal() principal: Principal, @Body() dto: BankEventDto, @IdempotencyKey() key: string) {
    return this.monetary.bankEvent(principal, dto, key);
  }

  @Post('conversions') @HttpCode(200)
  conversion(@CurrentPrincipal() principal: Principal, @Body() dto: ConversionDto, @IdempotencyKey() key: string) {
    return this.monetary.conversion(principal, dto, key);
  }

  @Post('issuance') @HttpCode(200)
  issue(@CurrentPrincipal() principal: Principal, @Body() dto: IssueRequestDto, @IdempotencyKey() key: string) {
    return this.monetary.issueRequest(principal, dto, key);
  }

  @Post('issuance/:id/verify') @HttpCode(200)
  issueVerify(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.monetary.issueVerify(principal, id); }

  @Post('issuance/:id/approve') @HttpCode(200)
  issueApprove(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.monetary.issueApprove(principal, id); }

  @Post('issuance/:id/execute') @HttpCode(200)
  issueExecute(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.monetary.issueExecute(principal, id); }

  @Post('issuance/:id/unknown') @HttpCode(200)
  issueUnknown(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.monetary.issueUnknown(principal, id); }

  @Post('issuance/:id/resolve') @HttpCode(200)
  issueResolve(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.monetary.issueResolve(principal, id); }

  @Post('redemptions') @HttpCode(200)
  redeem(@CurrentPrincipal() principal: Principal, @Body() dto: RedeemRequestDto, @IdempotencyKey() key: string) {
    return this.monetary.redeemRequest(principal, dto, key);
  }

  @Post('redemptions/:id/settlement') @HttpCode(200)
  redeemSettlement(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SettlementDto) {
    return this.monetary.redeemSettlement(principal, id, dto.outcome);
  }

  @Post('redemptions/:id/finalize') @HttpCode(200)
  redeemFinalize(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.monetary.redeemFinalize(principal, id); }

  @Post('redemptions/:id/unknown') @HttpCode(200)
  redeemUnknown(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.monetary.redeemUnknown(principal, id); }

  @Post('redemptions/:id/resolve') @HttpCode(200)
  redeemResolve(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.monetary.redeemResolve(principal, id); }

  @Post('reserves') @HttpCode(200)
  reserve(@CurrentPrincipal() principal: Principal, @Body() dto: ReserveProposeDto, @IdempotencyKey() key: string) {
    return this.monetary.reservePropose(principal, dto, key);
  }

  @Post('reserves/:id/review') @HttpCode(200)
  reserveReview(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReserveReviewDto) {
    return this.monetary.reserveReview(principal, id, dto.decision);
  }

  @Post('reserves/:id/encumber') @HttpCode(200)
  reserveEncumber(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EncumberDto) {
    return this.monetary.reserveEncumber(principal, id, dto.encumbered);
  }

  @Post('reserves/:id/stale') @HttpCode(200)
  reserveStale(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.monetary.reserveStale(principal, id); }

  @Post('capabilities') @HttpCode(200)
  grant(@CurrentPrincipal() principal: Principal, @Body() dto: GrantDto) { return this.monetary.grant(principal, dto.principalId, dto.capability); }

  @Post('books/:id/suspension') @HttpCode(200)
  suspend(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SuspendDto) {
    return this.monetary.suspend(principal, id, dto.suspended);
  }

  @Post('caps') @HttpCode(200)
  cap(@CurrentPrincipal() principal: Principal, @Body() dto: CapRequestDto, @IdempotencyKey() key: string) {
    return this.monetary.capRequest(principal, dto, key);
  }

  @Post('caps/:id/approve') @HttpCode(200)
  capApprove(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.monetary.capApprove(principal, id); }

  @Post('reports') @HttpCode(200)
  report(@CurrentPrincipal() principal: Principal, @Body() dto: ReportDraftDto) { return this.monetary.reportDraft(principal, dto); }

  @Post('reports/:id/transition') @HttpCode(200)
  reportTransition(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReportTransitionDto) {
    return this.monetary.reportTransition(principal, id, dto.state);
  }

  @Post('activation') @HttpCode(200)
  activate(@CurrentPrincipal() principal: Principal, @Body() dto: MonetaryActivateDto) { return this.monetary.activateLive(principal, dto.reason); }

  @Post('chain/observations') @HttpCode(200)
  observe(@CurrentPrincipal() principal: Principal, @Body() dto: ChainObserveDto) { return this.monetary.chainObserve(principal, dto); }

  @Post('chain/reorgs') @HttpCode(200)
  reorg(@CurrentPrincipal() principal: Principal, @Body() dto: ReorgDto) { return this.monetary.chainReorg(principal, dto.txRef); }

  @Post('fhu/issuance') @HttpCode(200)
  fhu(@CurrentPrincipal() principal: Principal, @Body() dto: FhuIssueDto, @IdempotencyKey() key: string) {
    return this.monetary.fhuIssue(principal, dto.amountMinor, dto.holderId ?? null, key);
  }

  @Post('screenings') @HttpCode(200)
  screen(@CurrentPrincipal() principal: Principal, @Body() dto: ScreenDto, @IdempotencyKey() key: string) {
    return this.monetary.screen(principal, dto, key);
  }

  @Post('restrictions') @HttpCode(200)
  restriction(@CurrentPrincipal() principal: Principal, @Body() dto: RestrictionDto) { return this.monetary.restriction(principal, dto); }

  @Post('freezes') @HttpCode(200)
  freeze(@CurrentPrincipal() principal: Principal, @Body() dto: FreezeDto) { return this.monetary.freeze(principal, dto); }

  @Post('capital') @HttpCode(200)
  capital(@CurrentPrincipal() principal: Principal, @Body() dto: CapitalDto, @IdempotencyKey() key: string) {
    return this.monetary.capital(principal, dto.amountMinor, key);
  }

  @Post('alerts/:id/acknowledge') @HttpCode(200)
  acknowledge(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.monetary.acknowledgeAlert(principal, id);
  }

  @Post('disclosures/acknowledge') @HttpCode(200)
  acknowledgeDisclosure(@CurrentPrincipal() principal: Principal, @Body() dto: DisclosureAckDto) {
    return this.monetary.acknowledgeDisclosure(principal, dto);
  }

  @Get('dashboard') dashboard(@CurrentPrincipal() principal: Principal) { return this.monetary.dashboard(principal); }

  @Get('evidence') evidence(@CurrentPrincipal() principal: Principal) { return this.monetary.evidenceExport(principal); }

  @Post('evidence') @HttpCode(200)
  evidenceOpen(@CurrentPrincipal() principal: Principal, @Body() dto: EvidenceOpenDto) {
    return this.monetary.evidenceOpen(principal, dto);
  }

  @Post('evidence/:id/notes') @HttpCode(200)
  evidenceNote(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EvidenceNoteDto) {
    return this.monetary.evidenceNote(principal, id, dto.note);
  }

  @Get('partners') partners(@CurrentPrincipal() principal: Principal) { return this.monetary.partnerList(principal); }

  @Post('partners') @HttpCode(200)
  partnerOpen(@CurrentPrincipal() principal: Principal, @Body() dto: PartnerOpenDto) {
    return this.monetary.partnerOpen(principal, dto);
  }

  @Post('partners/:id/checks') @HttpCode(200)
  partnerCheck(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PartnerCheckDto) {
    return this.monetary.partnerCheck(principal, id, dto.item);
  }
}
