import { createHmac, generateKeyPairSync, sign, verify } from 'node:crypto';

export const TRUST_BOUNDARY = 'SAME_HOST_KEY_IS_NOT_HSM';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function uuidText(value) {
  const text = String(value).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text)) {
    throw new Error('NETWORK_PAYLOAD');
  }
  return text;
}

export function canonicalPaymentPayload({
  originInstitutionId, beneficiaryInstitutionId, originAccountId, beneficiaryAccountId,
  currency, amountMinor, idempotencyKey, purpose,
}) {
  const key = String(idempotencyKey);
  const memo = String(purpose);
  const amount = String(amountMinor);
  if (key.includes('|') || memo.includes('|') || amount.includes('|') || String(currency).includes('|')) {
    throw new Error('NETWORK_PAYLOAD');
  }
  return `v1|${uuidText(originInstitutionId)}|${uuidText(beneficiaryInstitutionId)}|${uuidText(originAccountId)}|${uuidText(beneficiaryAccountId)}|${currency}|${amount}|${key}|${memo}`;
}

export function generateMemberKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  if (der.length !== 44 || !der.subarray(0, 12).equals(SPKI_PREFIX)) throw new Error('NETWORK_CERT');
  return {
    publicKeyHex: der.subarray(12).toString('hex'),
    privateKey,
    privateKeyStored: false,
    hardwareSecurityModule: false,
  };
}

export function signPayload(privateKey, payload) {
  return sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex');
}

export function verifyPayload(publicKeyHex, payload, signatureHex) {
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex ?? '') || !/^[0-9a-f]{128}$/.test(signatureHex ?? '')) return false;
  const key = Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]);
  return verify(null, Buffer.from(payload, 'utf8'), { key, format: 'der', type: 'spki' }, Buffer.from(signatureHex, 'hex'));
}

export function simulatedConfirmationSignature(cycleId, currency, key) {
  const payload = `network|${String(cycleId).toLowerCase()}|${currency}|FINAL_SIMULATED`;
  return createHmac('sha256', String(key)).update(payload, 'utf8').digest('hex');
}
