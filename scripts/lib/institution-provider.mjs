import { createHash, createHmac } from 'node:crypto';

export const SIMULATED_RAILS = Object.freeze(['ACH', 'FEDWIRE', 'BANK_INTERNAL', 'RTP', 'STABLECOIN_NETWORK']);
export const LIVE_RAILS_CONNECTED = false;

export function credentialHash(secret) {
  return createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

// Simulated provider finality signature. This does not submit a payment.
export function simulatedSettlementSignature({ institutionId, paymentId, providerEventId, amountMinor, key }) {
  const payload = `${institutionId}|${paymentId}|${providerEventId}|${amountMinor}|SETTLED`;
  return createHmac('sha256', String(key)).update(payload, 'utf8').digest('hex');
}
