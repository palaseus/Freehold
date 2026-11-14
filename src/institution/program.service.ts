import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Principal } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class ProgramService {
  constructor(private readonly db: DatabaseService) {}

  correlation(header: string | undefined) {
    if (header && /^[0-9a-f-]{36}$/i.test(header)) return header;
    return randomUUID();
  }

  private async work(principal: Principal, correlationId: string, sql: string, params: unknown[]) {
    const item = await this.db.transaction(principal, async client => this.read(client, sql, params));
    return this.withCorrelation(item, correlationId);
  }

  private async read(client: PoolClient, sql: string, params: unknown[]) {
    const [row] = await this.db.read<{ item: unknown }>(sql, params, client);
    return row?.item ?? null;
  }

  private withCorrelation(item: unknown, correlationId: string) {
    if (item && typeof item === 'object' && !Array.isArray(item)) return { ...(item as Record<string, unknown>), correlationId };
    return { result: item, correlationId };
  }

  private minor(value: string, label: string) {
    if (!/^(0|[1-9][0-9]{0,18})$/.test(value)) throw new BadRequestException({ code: 'INVALID_REQUEST', field: label });
    return value;
  }

  dashboard(principal: Principal, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.program_dashboard($1::uuid) AS item', [principal.user.id]);
  }

  policyDraft(principal: Principal, institutionId: string, domain: string, body: Record<string, unknown>, precedence: number, maxExposureMinor: string, currency: string, effectiveFrom: string, effectiveUntil: string, correlationId: string) {
    return this.work(principal, correlationId,
      'SELECT freehold.program_policy_draft($1::uuid,$2::uuid,$3::text,$4::jsonb,$5::integer,$6::bigint,$7::text,$8::timestamptz,$9::timestamptz) AS item',
      [principal.user.id, institutionId, domain, JSON.stringify(body), precedence, this.minor(maxExposureMinor, 'maxExposureMinor'), currency, effectiveFrom, effectiveUntil]);
  }

  policyApprove(principal: Principal, policyId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.program_policy_approve($1::uuid,$2::uuid) AS item', [principal.user.id, policyId]);
  }

  policyRetire(principal: Principal, policyId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.program_policy_retire($1::uuid,$2::uuid) AS item', [principal.user.id, policyId]);
  }

  workflowDraft(principal: Principal, institutionId: string, definition: Record<string, unknown>, maxExposureMinor: string, currency: string, deadline: string, idempotencyKey: string, requiredApprovals: number, correlationId: string) {
    return this.work(principal, correlationId,
      'SELECT freehold.program_workflow_draft($1::uuid,$2::uuid,$3::jsonb,$4::bigint,$5::text,$6::timestamptz,$7::text,$8::integer) AS item',
      [principal.user.id, institutionId, JSON.stringify(definition), this.minor(maxExposureMinor, 'maxExposureMinor'), currency, deadline, idempotencyKey, requiredApprovals]);
  }

  workflowSubmit(principal: Principal, workflowId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.program_workflow_submit($1::uuid,$2::uuid) AS item', [principal.user.id, workflowId]);
  }

  workflowApprove(principal: Principal, workflowId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.program_workflow_approve($1::uuid,$2::uuid) AS item', [principal.user.id, workflowId]);
  }

  workflowExecute(principal: Principal, workflowId: string, idempotencyKey: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.program_workflow_execute($1::uuid,$2::uuid,$3::text) AS item', [principal.user.id, workflowId, idempotencyKey]);
  }

  workflowCancel(principal: Principal, workflowId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.program_workflow_cancel($1::uuid,$2::uuid) AS item', [principal.user.id, workflowId]);
  }

  workflowPreview(principal: Principal, workflowId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.program_workflow_preview($1::uuid,$2::uuid) AS item', [principal.user.id, workflowId]);
  }

  workflowGet(principal: Principal, workflowId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.program_workflow_get($1::uuid,$2::uuid) AS item', [principal.user.id, workflowId]);
  }

  settle(principal: Principal, institutionId: string, idempotencyKey: string, deadline: string, legs: unknown[], correlationId: string) {
    if (!Array.isArray(legs) || legs.length < 1 || legs.length > 16) throw new BadRequestException({ code: 'INVALID_REQUEST' });
    return this.work(principal, correlationId,
      'SELECT freehold.program_settle_atomic($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::jsonb) AS item',
      [principal.user.id, institutionId, idempotencyKey, deadline, JSON.stringify(legs)]);
  }

  coordinate(principal: Principal, institutionId: string, idempotencyKey: string, legs: unknown[], correlationId: string) {
    if (!Array.isArray(legs)) throw new BadRequestException({ code: 'INVALID_REQUEST' });
    return this.work(principal, correlationId,
      'SELECT freehold.program_settle_coordinate($1::uuid,$2::uuid,$3::text,$4::jsonb) AS item',
      [principal.user.id, institutionId, idempotencyKey, JSON.stringify(legs)]);
  }

  escrowFund(principal: Principal, institutionId: string, sourceAccountId: string, amountMinor: string, beneficiaryInstitutionId: string, beneficiaryRef: string, conditions: Record<string, unknown>, expiresAt: string, idempotencyKey: string, correlationId: string) {
    return this.work(principal, correlationId,
      'SELECT freehold.program_escrow_fund($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::uuid,$6::text,$7::jsonb,$8::timestamptz,$9::text) AS item',
      [principal.user.id, institutionId, sourceAccountId, this.minor(amountMinor, 'amountMinor'), beneficiaryInstitutionId, beneficiaryRef, JSON.stringify(conditions), expiresAt, idempotencyKey]);
  }

  escrowRelease(principal: Principal, escrowId: string, toAccountId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.program_escrow_release($1::uuid,$2::uuid,$3::uuid) AS item', [principal.user.id, escrowId, toAccountId]);
  }

  escrowReturn(principal: Principal, escrowId: string, idempotencyKey: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.program_escrow_return($1::uuid,$2::uuid,$3::text) AS item', [principal.user.id, escrowId, idempotencyKey]);
  }

  escrowDispute(principal: Principal, escrowId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.program_escrow_dispute($1::uuid,$2::uuid) AS item', [principal.user.id, escrowId]);
  }

  treasuryRecommend(principal: Principal, institutionId: string, movement: string, amountMinor: string, currency: string, fromKind: string | undefined, toKind: string | undefined, correlationId: string) {
    return this.work(principal, correlationId,
      'SELECT freehold.program_treasury_recommend($1::uuid,$2::uuid,$3::text,$4::bigint,$5::text,$6::text,$7::text) AS item',
      [principal.user.id, institutionId, movement, this.minor(amountMinor, 'amountMinor'), currency, fromKind ?? null, toKind ?? null]);
  }

  treasuryApprove(principal: Principal, treasuryId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.program_treasury_approve($1::uuid,$2::uuid) AS item', [principal.user.id, treasuryId]);
  }

  treasuryExecute(principal: Principal, treasuryId: string, idempotencyKey: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.program_treasury_execute($1::uuid,$2::uuid,$3::text) AS item', [principal.user.id, treasuryId, idempotencyKey]);
  }

  treasuryMonitor(principal: Principal, institutionId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.program_treasury_monitor($1::uuid,$2::uuid) AS item', [principal.user.id, institutionId]);
  }

  assetRegister(principal: Principal, institutionId: string, assetType: string, code: string, denomination: string, correlationId: string) {
    return this.work(principal, correlationId,
      'SELECT freehold.program_asset_register($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item',
      [principal.user.id, institutionId, assetType, code, denomination]);
  }

  assetAuthorize(principal: Principal, assetId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.program_asset_authorize($1::uuid,$2::uuid) AS item', [principal.user.id, assetId]);
  }

  assetIssue(principal: Principal, institutionId: string, assetId: string, quantityMinor: string, idempotencyKey: string, correlationId: string) {
    return this.work(principal, correlationId,
      'SELECT freehold.program_asset_issue($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text) AS item',
      [principal.user.id, institutionId, assetId, this.minor(quantityMinor, 'quantityMinor'), idempotencyKey]);
  }

  assetTransfer(principal: Principal, fromInstitutionId: string, assetId: string, toInstitutionId: string, quantityMinor: string, idempotencyKey: string, correlationId: string) {
    return this.work(principal, correlationId,
      'SELECT freehold.program_asset_transfer($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::text) AS item',
      [principal.user.id, fromInstitutionId, assetId, toInstitutionId, this.minor(quantityMinor, 'quantityMinor'), idempotencyKey]);
  }

  quoteOpen(principal: Principal, institutionId: string, baseAssetId: string, quoteAssetId: string, unitPriceMinor: string, quantityMinor: string, kind: string, expiresAt: string, correlationId: string) {
    return this.work(principal, correlationId,
      'SELECT freehold.program_quote_open($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::bigint,$7::text,$8::timestamptz) AS item',
      [principal.user.id, institutionId, baseAssetId, quoteAssetId, this.minor(unitPriceMinor, 'unitPriceMinor'), this.minor(quantityMinor, 'quantityMinor'), kind, expiresAt]);
  }

  quoteExecute(principal: Principal, buyerInstitutionId: string, quoteId: string, unitPriceMinor: string, idempotencyKey: string, correlationId: string) {
    return this.work(principal, correlationId,
      'SELECT freehold.program_quote_execute($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text) AS item',
      [principal.user.id, buyerInstitutionId, quoteId, this.minor(unitPriceMinor, 'unitPriceMinor'), idempotencyKey]);
  }

  exchangeAdmit(principal: Principal, institutionId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.program_exchange_admit($1::uuid,$2::uuid) AS item', [principal.user.id, institutionId]);
  }

  collateralPledge(principal: Principal, institutionId: string, assetId: string, quantityMinor: string, haircutBps: number, arrangementKey: string, correlationId: string) {
    return this.work(principal, correlationId,
      'SELECT freehold.program_collateral_pledge($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::integer,$6::text) AS item',
      [principal.user.id, institutionId, assetId, this.minor(quantityMinor, 'quantityMinor'), haircutBps, arrangementKey]);
  }

  collateralRelease(principal: Principal, collateralId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.program_collateral_release($1::uuid,$2::uuid) AS item', [principal.user.id, collateralId]);
  }

  fusdRequest(principal: Principal, institutionId: string, bookId: string, amountMinor: string, idempotencyKey: string, notBefore: string | undefined, correlationId: string) {
    return this.work(principal, correlationId,
      'SELECT freehold.program_fusd_request($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::timestamptz) AS item',
      [principal.user.id, institutionId, bookId, this.minor(amountMinor, 'amountMinor'), idempotencyKey, notBefore ?? null]);
  }

  suspend(principal: Principal, institutionId: string, suspend: boolean, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.program_suspend($1::uuid,$2::uuid,$3::boolean) AS item', [principal.user.id, institutionId, suspend]);
  }

  activate(principal: Principal, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.program_activate_live($1::uuid) AS item', [principal.user.id]);
  }
}
