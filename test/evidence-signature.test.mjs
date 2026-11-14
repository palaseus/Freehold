import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signatureFor, verifySignature } from '../scripts/lib/evidence-signature.mjs';

const body = { outcome: 'VERIFIED', algorithmVersion: '1.3.0' };

test('a report without a key stays unsigned', () => {
  const signature = signatureFor(body, '');
  assert.equal(signature.status, 'UNSIGNED');
  assert.equal(signature.signature, null);
  assert.equal(verifySignature(body, signature, 'not a key').status, 'UNSIGNED');
});

test('an external disposable key signs and verifies', () => {
  const directory = mkdtempSync(join(tmpdir(), 'freehold-sign-'));
  const keyPath = join(directory, 'test-key.pem');
  const pair = generateKeyPairSync('ed25519');
  writeFileSync(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  try {
    const signature = signatureFor(body, keyPath);
    assert.equal(signature.status, 'SIGNED');
    assert.equal(signature.algorithm, 'Ed25519');
    assert.equal(verifySignature(body, signature, publicPem).status, 'SIGNED');
    assert.equal(verifySignature({ ...body, outcome: 'MISMATCH' }, signature, publicPem).status, 'MISMATCH');
    assert.throws(() => verifySignature(body, signature, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()), /private key/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a key inside the repository is refused', () => {
  assert.throws(() => signatureFor(body, 'package.json'), /repository/);
});
