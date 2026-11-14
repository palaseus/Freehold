import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Principal } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';

const nil = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class InstitutionService {
  constructor(private readonly db: DatabaseService) {}

  private async sessionItem(principal: Principal, sql: string, params: unknown[], correlationId: string) {
    const item = await this.db.transaction(principal, async client => this.readItem(client, sql, params));
    return this.withCorrelation(item, correlationId);
  }

  private async credentialItem(sql: string, params: unknown[], correlationId: string) {
    const item = await this.db.credentialTransaction(async client => this.readItem(client, sql, params));
    return this.withCorrelation(item, correlationId);
  }

  private async readItem(client: PoolClient, sql: string, params: unknown[]) {
    const [row] = await this.db.read<{ item: unknown }>(sql, params, client);
    return row?.item ?? null;
  }

  private withCorrelation(item: unknown, correlationId: string) {
    if (item && typeof item === 'object' && !Array.isArray(item)) return { ...(item as Record<string, unknown>), correlationId };
    return { result: item, correlationId };
  }

  list(principal: Principal, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_list($1::uuid) AS item', [principal.user.id], correlationId);
  }

  open(principal: Principal, code: string, legalName: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_open($1::uuid,$2::text,$3::text) AS item', [principal.user.id, code, legalName], correlationId);
  }

  grant(principal: Principal, institutionId: string, memberId: string, capability: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_grant($1::uuid,$2::uuid,$3::uuid,$4::text) AS item', [principal.user.id, institutionId, memberId, capability], correlationId);
  }

  policy(principal: Principal, institutionId: string, code: string, thresholdMinor: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_policy_set($1::uuid,$2::uuid,$3::text,$4::bigint) AS item', [principal.user.id, institutionId, code, thresholdMinor], correlationId);
  }

  issueCredential(principal: Principal, institutionId: string, scopes: string[], ttlSeconds: number, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_credential_issue($1::uuid,$2::uuid,$3::text[],$4::integer) AS item', [principal.user.id, institutionId, scopes, ttlSeconds], correlationId);
  }

  revokeCredential(principal: Principal, institutionId: string, keyId: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_credential_revoke($1::uuid,$2::uuid,$3::text) AS item', [principal.user.id, institutionId, keyId], correlationId);
  }

  openCustomer(principal: Principal, institutionId: string, externalRef: string, displayName: string, currency: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_customer_open($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item', [principal.user.id, institutionId, externalRef, displayName, currency], correlationId);
  }

  fund(principal: Principal, institutionId: string, accountId: string, amountMinor: string, key: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_fund_simulated($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::uuid) AS item', [principal.user.id, institutionId, accountId, amountMinor, key, correlationId], correlationId);
  }

  transfer(principal: Principal, institutionId: string, fromAccountId: string, toAccountId: string, amountMinor: string, key: string, correlationId: string) {
    return this.sessionItem(
      principal,
      'SELECT freehold.institution_transfer($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::text,$7::uuid) AS item',
      [principal.user.id, institutionId, fromAccountId, toAccountId, amountMinor, key, correlationId],
      correlationId,
    );
  }

  account(principal: Principal, institutionId: string, accountId: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_account_get($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid) AS item', [principal.user.id, institutionId, accountId], correlationId);
  }

  activity(principal: Principal, institutionId: string, accountId: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_activity($1::uuid,$2::uuid,$3::uuid) AS item', [principal.user.id, institutionId, accountId], correlationId);
  }

  openTreasury(principal: Principal, institutionId: string, kind: string, currency: string, custodian: string | null, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_treasury_open($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item', [principal.user.id, institutionId, kind, currency, custodian], correlationId);
  }

  treasury(principal: Principal, institutionId: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_treasury_report($1::uuid,NULL,NULL,NULL,$2::uuid) AS item', [principal.user.id, institutionId], correlationId);
  }

  openPayment(principal: Principal, institutionId: string, accountId: string, amountMinor: string, rail: string, externalRef: string, key: string, correlationId: string) {
    return this.sessionItem(
      principal,
      'SELECT freehold.institution_payment_open($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::text,$7::text,$8::uuid) AS item',
      [principal.user.id, institutionId, accountId, amountMinor, rail, externalRef, key, correlationId],
      correlationId,
    );
  }

  transition(principal: Principal, institutionId: string, paymentId: string, state: string, eventId: string | null, signature: string | null, correlationId: string) {
    return this.sessionItem(
      principal,
      'SELECT freehold.institution_payment_transition($1::uuid,NULL,NULL,NULL,$2::uuid,$3::uuid,$4::text,$5::text,$6::text) AS item',
      [principal.user.id, institutionId, paymentId, state, eventId, signature],
      correlationId,
    );
  }

  risk(principal: Principal, institutionId: string, scenario: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_risk_run($1::uuid,$2::uuid,$3::text) AS item', [principal.user.id, institutionId, scenario], correlationId);
  }

  openWebhook(principal: Principal, institutionId: string, url: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_webhook_open($1::uuid,$2::uuid,$3::text) AS item', [principal.user.id, institutionId, url], correlationId);
  }

  subscribe(principal: Principal, institutionId: string, endpointId: string, eventType: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_webhook_subscribe($1::uuid,$2::uuid,$3::uuid,$4::text) AS item', [principal.user.id, institutionId, endpointId, eventType], correlationId);
  }

  attempt(principal: Principal, institutionId: string, deliveryId: string, outcome: string, secret: string | null, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_webhook_attempt($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text) AS item', [principal.user.id, institutionId, deliveryId, outcome, secret], correlationId);
  }

  rotateWebhook(principal: Principal, institutionId: string, endpointId: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_webhook_rotate($1::uuid,$2::uuid,$3::uuid) AS item', [principal.user.id, institutionId, endpointId], correlationId);
  }

  openDispute(principal: Principal, institutionId: string, paymentId: string | null, note: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_dispute_open($1::uuid,$2::uuid,$3::uuid,$4::text) AS item', [principal.user.id, institutionId, paymentId, note], correlationId);
  }

  noteDispute(principal: Principal, institutionId: string, disputeId: string, note: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_dispute_note($1::uuid,$2::uuid,$3::uuid,$4::text) AS item', [principal.user.id, institutionId, disputeId, note], correlationId);
  }

  resolveDispute(principal: Principal, institutionId: string, disputeId: string, state: string, resolution: string | null, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_dispute_resolve($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text) AS item', [principal.user.id, institutionId, disputeId, state, resolution], correlationId);
  }

  proposeAdjustment(principal: Principal, institutionId: string, disputeId: string | null, debit: string, credit: string, amountMinor: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_adjustment_propose($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bigint) AS item', [principal.user.id, institutionId, disputeId, debit, credit, amountMinor], correlationId);
  }

  postAdjustment(principal: Principal, institutionId: string, adjustmentId: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_adjustment_post($1::uuid,$2::uuid,$3::uuid) AS item', [principal.user.id, institutionId, adjustmentId], correlationId);
  }

  plan(principal: Principal, institutionId: string, monthly: string, api: string, tx: string, compliance: string, report: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_billing_plan($1::uuid,$2::uuid,$3::bigint,$4::bigint,$5::bigint,$6::bigint,$7::bigint) AS item', [principal.user.id, institutionId, monthly, api, tx, compliance, report], correlationId);
  }

  usage(principal: Principal, institutionId: string, period: string, meter: string, quantity: string, correlationId: string, idempotencyKey: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_usage_record($1::uuid,$2::uuid,$3::date,$4::text,$5::bigint,$6::text) AS item', [principal.user.id, institutionId, period, meter, quantity, idempotencyKey], correlationId);
  }

  invoice(principal: Principal, institutionId: string, period: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_invoice_draft($1::uuid,NULL,NULL,NULL,$2::uuid,$3::date) AS item', [principal.user.id, institutionId, period], correlationId);
  }

  forecast(principal: Principal, institutionId: string, factor: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_billing_forecast($1::uuid,$2::uuid,$3::bigint) AS item', [principal.user.id, institutionId, factor], correlationId);
  }

  compliance(principal: Principal, institutionId: string, subject: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_compliance_open($1::uuid,$2::uuid,$3::text) AS item', [principal.user.id, institutionId, subject], correlationId);
  }

  linkIssuance(principal: Principal, institutionId: string, issuanceId: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_issuance_link($1::uuid,$2::uuid,$3::uuid) AS item', [principal.user.id, institutionId, issuanceId], correlationId);
  }

  health(principal: Principal, institutionId: string, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_health($1::uuid,$2::uuid) AS item', [principal.user.id, institutionId], correlationId);
  }

  activate(principal: Principal, correlationId: string) {
    return this.sessionItem(principal, 'SELECT freehold.institution_activate_live($1::uuid) AS item', [principal.user.id], correlationId);
  }

  sandboxTransfer(keyId: string, secret: string, nonce: string, institutionId: string, fromAccountId: string, toAccountId: string, amountMinor: string, idempotencyKey: string, correlationId: string) {
    return this.credentialItem(
      'SELECT freehold.institution_transfer($1::uuid,$2::text,$3::text,$4::text,$5::uuid,$6::uuid,$7::uuid,$8::bigint,$9::text,$10::uuid) AS item',
      [nil, keyId, this.hash(secret), nonce, institutionId, fromAccountId, toAccountId, amountMinor, idempotencyKey, correlationId],
      correlationId,
    );
  }

  sandboxAccount(keyId: string, secret: string, nonce: string, institutionId: string, accountId: string, correlationId: string) {
    return this.credentialItem(
      'SELECT freehold.institution_account_get($1::uuid,$2::text,$3::text,$4::text,$5::uuid,$6::uuid) AS item',
      [nil, keyId, this.hash(secret), nonce, institutionId, accountId],
      correlationId,
    );
  }

  sandboxTreasury(keyId: string, secret: string, nonce: string, institutionId: string, correlationId: string) {
    return this.credentialItem(
      'SELECT freehold.institution_treasury_report($1::uuid,$2::text,$3::text,$4::text,$5::uuid) AS item',
      [nil, keyId, this.hash(secret), nonce, institutionId],
      correlationId,
    );
  }

  sandboxPayment(keyId: string, secret: string, nonce: string, institutionId: string, accountId: string, amountMinor: string, rail: string, externalRef: string, idempotencyKey: string, correlationId: string) {
    return this.credentialItem(
      'SELECT freehold.institution_payment_open($1::uuid,$2::text,$3::text,$4::text,$5::uuid,$6::uuid,$7::bigint,$8::text,$9::text,$10::text,$11::uuid) AS item',
      [nil, keyId, this.hash(secret), nonce, institutionId, accountId, amountMinor, rail, externalRef, idempotencyKey, correlationId],
      correlationId,
    );
  }

  sandboxTransition(keyId: string, secret: string, nonce: string, institutionId: string, paymentId: string, state: string, eventId: string | null, signature: string | null, correlationId: string) {
    return this.credentialItem(
      'SELECT freehold.institution_payment_transition($1::uuid,$2::text,$3::text,$4::text,$5::uuid,$6::uuid,$7::text,$8::text,$9::text) AS item',
      [nil, keyId, this.hash(secret), nonce, institutionId, paymentId, state, eventId, signature],
      correlationId,
    );
  }

  sandboxInvoice(keyId: string, secret: string, nonce: string, institutionId: string, period: string, correlationId: string) {
    return this.credentialItem(
      'SELECT freehold.institution_invoice_draft($1::uuid,$2::text,$3::text,$4::text,$5::uuid,$6::date) AS item',
      [nil, keyId, this.hash(secret), nonce, institutionId, period],
      correlationId,
    );
  }

  credential(authorization: string | undefined, nonce: string | undefined, institutionId: string | undefined) {
    const match = /^Bearer (fh_sandbox_[0-9a-f]{24})\.([0-9a-f]{64})$/.exec(authorization ?? '');
    const keyId = match?.[1];
    const secret = match?.[2];
    if (!keyId || !secret || !institutionId || !/^[0-9a-f-]{36}$/i.test(institutionId)) throw new UnauthorizedException({ code: 'INSTITUTION_CREDENTIAL' });
    if (!nonce || nonce.length < 8 || nonce.length > 80) throw new BadRequestException({ code: 'INSTITUTION_REPLAY' });
    return { keyId, secret, nonce, institutionId };
  }

  correlation(header: string | undefined) {
    if (header && /^[0-9a-f-]{36}$/i.test(header)) return header;
    return randomUUID();
  }

  private hash(secret: string) {
    return createHash('sha256').update(secret, 'utf8').digest('hex');
  }
}
