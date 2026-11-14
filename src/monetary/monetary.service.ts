import { BadRequestException, Injectable } from '@nestjs/common';
import type { Principal } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import type {
  BankEventDto, BankOpenDto, CapRequestDto, ChainObserveDto, ConversionDto, DisclosureAckDto, EvidenceOpenDto,
  FreezeDto, IssueRequestDto, PartnerOpenDto, RedeemRequestDto, ReportDraftDto, ReserveProposeDto, RestrictionDto, ScreenDto,
} from './monetary.dto';

@Injectable()
export class MonetaryService {
  constructor(private readonly db: DatabaseService) {}

  private item(principal: Principal, sql: string, params: unknown[]) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ item: unknown }>(sql, params, client);
      return row?.item ?? null;
    });
  }

  overview(principal: Principal) {
    return this.item(principal, 'SELECT freehold.monetary_overview($1::uuid) AS item', [principal.user.id]);
  }

  activity(principal: Principal) {
    return this.item(principal, 'SELECT freehold.monetary_customer_activity($1::uuid) AS item', [principal.user.id]);
  }

  bankOpen(principal: Principal, dto: BankOpenDto, key: string) {
    return this.item(principal, 'SELECT freehold.monetary_bank_open($1::uuid,$2::uuid,$3::text) AS item', [principal.user.id, dto.accountId, key]);
  }

  bankEvent(principal: Principal, dto: BankEventDto, key: string) {
    if (key !== dto.externalId) throw new BadRequestException('IDEMPOTENCY_KEY_MISMATCH');
    return this.item(
      principal,
      'SELECT freehold.monetary_bank_event($1::uuid,$2::uuid,$3::text,$4::text,$5::bigint,$6::text,$7::text) AS item',
      [principal.user.id, dto.bankAccountId, dto.kind, dto.externalId, dto.amountMinor, dto.state, dto.signature ?? null],
    );
  }

  conversion(principal: Principal, dto: ConversionDto, key: string) {
    return this.item(
      principal,
      'SELECT freehold.monetary_conversion_request($1::uuid,$2::uuid,$3::bigint,$4::text) AS item',
      [principal.user.id, dto.accountId, dto.amountMinor, key],
    );
  }

  issueRequest(principal: Principal, dto: IssueRequestDto, key: string) {
    return this.item(
      principal,
      'SELECT freehold.monetary_issue_request($1::uuid,$2::uuid,$3::bigint,$4::uuid,$5::text) AS item',
      [principal.user.id, dto.bookId, dto.amountMinor, dto.holderId ?? null, key],
    );
  }

  issueVerify(principal: Principal, id: string) {
    return this.item(principal, 'SELECT freehold.monetary_issue_verify($1::uuid,$2::uuid) AS item', [principal.user.id, id]);
  }

  issueApprove(principal: Principal, id: string) {
    return this.item(principal, 'SELECT freehold.monetary_issue_approve($1::uuid,$2::uuid) AS item', [principal.user.id, id]);
  }

  issueExecute(principal: Principal, id: string) {
    return this.item(principal, 'SELECT freehold.monetary_issue_execute($1::uuid,$2::uuid) AS item', [principal.user.id, id]);
  }

  issueUnknown(principal: Principal, id: string) {
    return this.item(principal, 'SELECT freehold.monetary_issue_mark_unknown($1::uuid,$2::uuid) AS item', [principal.user.id, id]);
  }

  issueResolve(principal: Principal, id: string) {
    return this.item(principal, 'SELECT freehold.monetary_issue_resolve_unknown($1::uuid,$2::uuid) AS item', [principal.user.id, id]);
  }

  redeemRequest(principal: Principal, dto: RedeemRequestDto, key: string) {
    return this.item(
      principal,
      'SELECT freehold.monetary_redeem_request($1::uuid,$2::uuid,$3::bigint,$4::text) AS item',
      [principal.user.id, dto.bookId, dto.amountMinor, key],
    );
  }

  redeemSettlement(principal: Principal, id: string, outcome: string) {
    return this.item(principal, 'SELECT freehold.monetary_redeem_settlement($1::uuid,$2::uuid,$3::text) AS item', [principal.user.id, id, outcome]);
  }

  redeemFinalize(principal: Principal, id: string) {
    return this.item(principal, 'SELECT freehold.monetary_redeem_finalize($1::uuid,$2::uuid) AS item', [principal.user.id, id]);
  }

  redeemUnknown(principal: Principal, id: string) {
    return this.item(principal, 'SELECT freehold.monetary_redeem_mark_unknown($1::uuid,$2::uuid) AS item', [principal.user.id, id]);
  }

  redeemResolve(principal: Principal, id: string) {
    return this.item(principal, 'SELECT freehold.monetary_redeem_resolve_unknown($1::uuid,$2::uuid) AS item', [principal.user.id, id]);
  }

  reservePropose(principal: Principal, dto: ReserveProposeDto, key: string) {
    return this.item(
      principal,
      'SELECT freehold.monetary_reserve_propose($1::uuid,$2::uuid,$3::text,$4::bigint,$5::text,$6::date,$7::text) AS item',
      [principal.user.id, dto.bookId, dto.category, dto.amountMinor, dto.assetRef, dto.maturityDate ?? null, key],
    );
  }

  reserveReview(principal: Principal, id: string, decision: string) {
    return this.item(principal, 'SELECT freehold.monetary_reserve_review($1::uuid,$2::uuid,$3::text) AS item', [principal.user.id, id, decision]);
  }

  reserveEncumber(principal: Principal, id: string, encumbered: boolean) {
    return this.item(principal, 'SELECT freehold.monetary_reserve_encumber($1::uuid,$2::uuid,$3::boolean) AS item', [principal.user.id, id, encumbered]);
  }

  reserveStale(principal: Principal, id: string) {
    return this.item(principal, 'SELECT freehold.monetary_reserve_mark_stale($1::uuid,$2::uuid) AS item', [principal.user.id, id]);
  }

  grant(principal: Principal, principalId: string, capability: string) {
    return this.item(principal, 'SELECT freehold.monetary_grant_capability($1::uuid,$2::uuid,$3::text) AS item', [principal.user.id, principalId, capability]);
  }

  suspend(principal: Principal, bookId: string, suspended: boolean) {
    return this.item(principal, 'SELECT freehold.monetary_suspend($1::uuid,$2::uuid,$3::boolean) AS item', [principal.user.id, bookId, suspended]);
  }

  capRequest(principal: Principal, dto: CapRequestDto, key: string) {
    return this.item(principal, 'SELECT freehold.monetary_cap_request($1::uuid,$2::uuid,$3::bigint,$4::text) AS item', [principal.user.id, dto.bookId, dto.proposedMax, key]);
  }

  capApprove(principal: Principal, id: string) {
    return this.item(principal, 'SELECT freehold.monetary_cap_approve($1::uuid,$2::uuid) AS item', [principal.user.id, id]);
  }

  reportDraft(principal: Principal, dto: ReportDraftDto) {
    return this.item(
      principal,
      'SELECT freehold.monetary_report_draft($1::uuid,$2::uuid,$3::date,$4::date) AS item',
      [principal.user.id, dto.bookId, dto.periodStart, dto.periodEnd],
    );
  }

  reportTransition(principal: Principal, id: string, state: string) {
    return this.item(principal, 'SELECT freehold.monetary_report_transition($1::uuid,$2::uuid,$3::text) AS item', [principal.user.id, id, state]);
  }

  activateLive(principal: Principal, reason: string) {
    return this.item(principal, 'SELECT freehold.monetary_activate_live($1::text) AS item', [reason]);
  }

  chainObserve(principal: Principal, dto: ChainObserveDto) {
    return this.item(
      principal,
      'SELECT freehold.monetary_chain_observe($1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::integer,$7::bigint) AS item',
      [principal.user.id, dto.bookId, dto.kind, dto.txRef, dto.finality, dto.confirmationDepth, dto.observedAmount],
    );
  }

  chainReorg(principal: Principal, txRef: string) {
    return this.item(principal, 'SELECT freehold.monetary_chain_reorg($1::uuid,$2::text) AS item', [principal.user.id, txRef]);
  }

  fhuIssue(principal: Principal, amountMinor: string, holderId: string | null, key: string) {
    return this.item(principal, 'SELECT freehold.monetary_fhu_issue($1::uuid,$2::bigint,$3::uuid,$4::text) AS item', [principal.user.id, amountMinor, holderId, key]);
  }

  screen(principal: Principal, dto: ScreenDto, key: string) {
    return this.item(principal, 'SELECT freehold.monetary_screen($1::uuid,$2::text,$3::text) AS item', [principal.user.id, dto.subjectRef, key]);
  }

  restriction(principal: Principal, dto: RestrictionDto) {
    return this.item(
      principal,
      'SELECT freehold.monetary_restriction_set($1::uuid,$2::uuid,$3::text,$4::text) AS item',
      [principal.user.id, dto.subjectUserId, dto.kind, dto.reason],
    );
  }

  freeze(principal: Principal, dto: FreezeDto) {
    return this.item(
      principal,
      'SELECT freehold.monetary_freeze_units($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::boolean) AS item',
      [principal.user.id, dto.bookId, dto.holderId, dto.amountMinor, dto.freeze],
    );
  }

  capital(principal: Principal, amountMinor: string, key: string) {
    return this.item(principal, 'SELECT freehold.monetary_record_capital($1::uuid,$2::bigint,$3::text) AS item', [principal.user.id, amountMinor, key]);
  }

  acknowledgeAlert(principal: Principal, id: string) {
    return this.item(principal, 'SELECT freehold.monetary_alert_acknowledge($1::uuid,$2::uuid) AS item', [principal.user.id, id]);
  }

  acknowledgeDisclosure(principal: Principal, dto: DisclosureAckDto) {
    return this.item(principal, 'SELECT freehold.monetary_disclosure_acknowledge($1::uuid,$2::text,$3::text) AS item', [principal.user.id, dto.product, dto.version]);
  }

  dashboard(principal: Principal) {
    return this.item(principal, 'SELECT freehold.monetary_institution_dashboard($1::uuid) AS item', [principal.user.id]);
  }

  evidenceExport(principal: Principal) {
    return this.item(principal, 'SELECT freehold.monetary_evidence_export($1::uuid) AS item', [principal.user.id]);
  }

  evidenceOpen(principal: Principal, dto: EvidenceOpenDto) {
    return this.item(
      principal,
      'SELECT freehold.monetary_evidence_open($1::uuid,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text,$8::text,$9::text) AS item',
      [principal.user.id, dto.controlId, dto.citation, dto.sourceTitle, dto.technicalControl, dto.testRef, dto.responsibleRole, dto.deficiency ?? '', dto.expiresOn ?? ''],
    );
  }

  evidenceNote(principal: Principal, id: string, note: string) {
    return this.item(principal, 'SELECT freehold.monetary_evidence_note($1::uuid,$2::uuid,$3::text) AS item', [principal.user.id, id, note]);
  }

  partnerList(principal: Principal) {
    return this.item(principal, 'SELECT freehold.monetary_partner_list($1::uuid) AS item', [principal.user.id]);
  }

  partnerOpen(principal: Principal, dto: PartnerOpenDto) {
    return this.item(principal, 'SELECT freehold.monetary_partner_open($1::uuid,$2::text,$3::text) AS item', [principal.user.id, dto.legalName, dto.entityKind]);
  }

  partnerCheck(principal: Principal, id: string, item: string) {
    return this.item(principal, 'SELECT freehold.monetary_partner_check($1::uuid,$2::uuid,$3::text) AS item', [principal.user.id, id, item]);
  }
}
