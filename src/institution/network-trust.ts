import { verify } from 'node:crypto';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function uuidText(value: string) {
  const text = value.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text)) throw new Error('NETWORK_PAYLOAD');
  return text;
}

export function canonicalPaymentPayload(parts: {
  originInstitutionId: string; beneficiaryInstitutionId: string; originAccountId: string; beneficiaryAccountId: string;
  currency: string; amountMinor: string; idempotencyKey: string; purpose: string;
}) {
  if ([parts.currency, parts.amountMinor, parts.idempotencyKey, parts.purpose].some(field => field.includes('|'))) {
    throw new Error('NETWORK_PAYLOAD');
  }
  return `v1|${uuidText(parts.originInstitutionId)}|${uuidText(parts.beneficiaryInstitutionId)}|${uuidText(parts.originAccountId)}|${uuidText(parts.beneficiaryAccountId)}|${parts.currency}|${parts.amountMinor}|${parts.idempotencyKey}|${parts.purpose}`;
}

export function verifyPayload(publicKeyHex: string, payload: string, signatureHex: string) {
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex) || !/^[0-9a-f]{128}$/.test(signatureHex)) return false;
  const key = Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]);
  return verify(null, Buffer.from(payload, 'utf8'), { key, format: 'der', type: 'spki' }, Buffer.from(signatureHex, 'hex'));
}
