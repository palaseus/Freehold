import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Principal } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { canonicalPaymentPayload, verifyPayload } from './network-trust';

@Injectable()
export class NetworkService {
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

  apply(principal: Principal, institutionId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_member_apply($1::uuid,$2::uuid) AS item', [principal.user.id, institutionId]);
  }

  transition(principal: Principal, institutionId: string, toStatus: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_member_transition($1::uuid,$2::uuid,$3::text) AS item', [principal.user.id, institutionId, toStatus]);
  }

  propose(principal: Principal, versionLabel: string, body: Record<string, unknown>, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_rulebook_propose($1::uuid,$2::text,$3::jsonb) AS item', [principal.user.id, versionLabel, JSON.stringify(body)]);
  }

  adopt(principal: Principal, rulebookId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_rulebook_adopt($1::uuid,$2::uuid) AS item', [principal.user.id, rulebookId]);
  }

  accept(principal: Principal, institutionId: string, rulebookId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_rulebook_accept($1::uuid,$2::uuid,$3::uuid) AS item', [principal.user.id, institutionId, rulebookId]);
  }

  currencies(principal: Principal, institutionId: string, currencies: string[], correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_member_currencies($1::uuid,$2::uuid,$3::text[]) AS item', [principal.user.id, institutionId, currencies]);
  }

  registerCertificate(principal: Principal, institutionId: string, publicKeyHex: string, notBefore: string, notAfter: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_certificate_register($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::timestamptz) AS item', [principal.user.id, institutionId, publicKeyHex, notBefore, notAfter]);
  }

  revokeCertificate(principal: Principal, institutionId: string, certificateId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_certificate_revoke($1::uuid,$2::uuid,$3::uuid) AS item', [principal.user.id, institutionId, certificateId]);
  }

  liquidity(principal: Principal, institutionId: string, openingMinor: string, capacityMinor: string, netDebitLimitMinor: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_liquidity_set($1::uuid,$2::uuid,$3::bigint,$4::bigint,$5::bigint) AS item', [principal.user.id, institutionId, openingMinor, capacityMinor, netDebitLimitMinor]);
  }

  async openPayment(principal: Principal, input: {
    originInstitutionId: string; beneficiaryInstitutionId: string; originAccountId: string; beneficiaryAccountId: string;
    currency: string; amountMinor: string; purpose: string; idempotencyKey: string; certificateId: string;
    signatureHex: string; nonce: string; ttlSeconds: number;
  }, correlationId: string) {
    const payload = canonicalPaymentPayload(input);
    const item = await this.db.transaction(principal, async client => {
      const certificate = await this.read(client, 'SELECT freehold.network_certificate_public($1::uuid,$2::uuid) AS item', [principal.user.id, input.certificateId]) as { publicKeyHex?: string; revoked?: boolean } | null;
      if (!certificate?.publicKeyHex || certificate.revoked || !verifyPayload(certificate.publicKeyHex, payload, input.signatureHex)) {
        throw new BadRequestException({ code: 'NETWORK_SIGNATURE' });
      }
      return this.read(client, `SELECT freehold.network_payment_open($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bigint,$7::text,$8::text,$9::uuid,$10::uuid,$11::text,$12::text,$13::integer) AS item`, [
        principal.user.id, input.originInstitutionId, input.beneficiaryInstitutionId, input.originAccountId, input.beneficiaryAccountId,
        input.amountMinor, input.purpose, input.idempotencyKey, correlationId, input.certificateId, input.signatureHex, input.nonce, input.ttlSeconds,
      ]);
    });
    return this.withCorrelation(item, correlationId);
  }

  validate(principal: Principal, paymentId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_payment_validate($1::uuid,$2::uuid) AS item', [principal.user.id, paymentId]);
  }

  cancel(principal: Principal, paymentId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_payment_cancel($1::uuid,$2::uuid) AS item', [principal.user.id, paymentId]);
  }

  reject(principal: Principal, paymentId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_payment_reject($1::uuid,$2::uuid) AS item', [principal.user.id, paymentId]);
  }

  payment(principal: Principal, institutionId: string, paymentId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_payment_get($1::uuid,$2::uuid,$3::uuid) AS item', [principal.user.id, institutionId, paymentId]);
  }

  build(principal: Principal, kind: string, currency: string, memberIds: string[], correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_cycle_build($1::uuid,$2::text,$3::text,$4::uuid[]) AS item', [principal.user.id, kind, currency, memberIds]);
  }

  finalizeCycle(principal: Principal, cycleId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_cycle_finalize($1::uuid,$2::uuid) AS item', [principal.user.id, cycleId]);
  }

  cycle(principal: Principal, cycleId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_cycle_get($1::uuid,$2::uuid) AS item', [principal.user.id, cycleId]);
  }

  submit(principal: Principal, cycleId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_settlement_submit($1::uuid,$2::uuid) AS item', [principal.user.id, cycleId]);
  }

  confirm(principal: Principal, cycleId: string, signature: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_settlement_confirm($1::uuid,$2::uuid,$3::text) AS item', [principal.user.id, cycleId, signature]);
  }

  unknown(principal: Principal, cycleId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_settlement_unknown($1::uuid,$2::uuid) AS item', [principal.user.id, cycleId]);
  }

  finalizeSettlement(principal: Principal, cycleId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_settlement_finalize($1::uuid,$2::uuid) AS item', [principal.user.id, cycleId]);
  }

  reverse(principal: Principal, paymentId: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_settlement_reverse($1::uuid,$2::uuid) AS item', [principal.user.id, paymentId]);
  }

  message(principal: Principal, paymentId: string, family: string, messageId: string, body: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_message_record($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS item', [principal.user.id, paymentId, family, messageId, body]);
  }

  dashboard(principal: Principal, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_dashboard($1::uuid) AS item', [principal.user.id]);
  }

  stress(principal: Principal, institutionId: string, scenario: string, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_stress($1::uuid,$2::uuid,$3::text) AS item', [principal.user.id, institutionId, scenario]);
  }

  activate(principal: Principal, correlationId: string) {
    return this.work(principal, correlationId, 'SELECT freehold.network_activate_live($1::uuid) AS item', [principal.user.id]);
  }
}
