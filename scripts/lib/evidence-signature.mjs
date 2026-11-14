import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function contentHash(canonical) {
  return createHash('sha256').update(canonical).digest('hex');
}

function outsideRepository(path) {
  const relativePath = relative(process.cwd(), resolve(path));
  return relativePath.startsWith('..') || resolve(path) === '/tmp';
}

export function signatureFor(body, privateKeyPath = '') {
  const canonical = canonicalJson(body);
  const hash = contentHash(canonical);
  if (!privateKeyPath) {
    return { status: 'UNSIGNED', algorithm: null, keyId: null, signedAt: null, contentSha256: hash, signature: null };
  }
  const absolute = resolve(privateKeyPath);
  if (!outsideRepository(absolute)) throw new Error('Refusing a signing key stored inside the repository');
  const pem = readFileSync(absolute, 'utf8');
  if (!pem.includes('PRIVATE KEY')) throw new Error('Signing key must be a PEM private key');
  const key = createPrivateKey(pem);
  const publicPem = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
  return {
    status: 'SIGNED',
    algorithm: 'Ed25519',
    keyId: createHash('sha256').update(publicPem).digest('hex').slice(0, 16),
    signedAt: new Date().toISOString(),
    contentSha256: hash,
    signature: sign(null, Buffer.from(canonical), key).toString('base64'),
  };
}

export function verifySignature(body, signature, publicKeyPem) {
  if (!signature || signature.status === 'UNSIGNED' || !signature.signature) return { ok: false, status: 'UNSIGNED' };
  if (String(publicKeyPem).includes('PRIVATE KEY')) throw new Error('Refusing to verify with a private key');
  const canonical = canonicalJson(body);
  if (contentHash(canonical) !== signature.contentSha256) return { ok: false, status: 'MISMATCH' };
  const ok = verify(null, Buffer.from(canonical), createPublicKey(publicKeyPem), Buffer.from(signature.signature, 'base64'));
  return { ok, status: ok ? 'SIGNED' : 'MISMATCH' };
}
