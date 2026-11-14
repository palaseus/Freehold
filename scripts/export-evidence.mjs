#!/usr/bin/env node
// Canonical evidence manifest. A hash stored next to the database is not a
// trust anchor against a privileged DBA. An optional signature uses a key path
// supplied from outside the repository and never embedded here.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, relative } from 'node:path';

if (process.argv[2] === '--verify') {
  const manifestPath = process.argv[3];
  const publicKey = process.argv[4];
  if (!manifestPath) throw new Error('Usage: export-evidence.mjs --verify <manifest.json> [public-key.pem]');
  const manifest = JSON.parse((await readFile(manifestPath)).toString('utf8'));
  const directory = resolve(manifestPath, '..');
  const canonical = await readFile(resolve(directory, 'verification.json'));
  const actual = createHash('sha256').update(canonical).digest('hex');
  if (actual !== manifest.contentSha256) {
    console.log(`FAIL content hash ${actual}`);
    process.exit(1);
  }
  if (manifest.signature == null) {
    console.log('UNSIGNED signature is null');
    process.exit(0);
  }
  if (!publicKey) throw new Error('A public key is required to verify a signed manifest');
  const keyText = (await readFile(publicKey)).toString('utf8');
  if (keyText.includes('PRIVATE KEY')) throw new Error('Refusing to verify with a private key');
  const signatureFile = resolve(directory, manifest.signature.file ?? 'signature.bin');
  const verified = spawnSync('openssl', ['dgst', '-sha256', '-verify', resolve(publicKey), '-signature', signatureFile], { input: canonical, encoding: 'utf8' });
  if (verified.status !== 0) {
    console.log('FAIL signature');
    process.exit(1);
  }
  console.log(`PASS signature ${manifest.contentSha256}`);
  process.exit(0);
}

const input = process.argv[2];
const outputDir = process.argv[3];
if (!input || !outputDir) throw new Error('Usage: export-evidence.mjs <verification.json> <output-directory>');
const bytes = await readFile(input);
const report = JSON.parse(bytes.toString('utf8'));
const canonical = `${JSON.stringify(report)}\n`;
const contentSha256 = createHash('sha256').update(canonical).digest('hex');
let sourceRevision = 'unknown';
const git = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
if (git.status === 0) sourceRevision = git.stdout.trim();
const manifest = {
  manifestType: 'freehold.evidence-manifest',
  verificationRunId: report.verificationRunId ?? null,
  generatedAt: new Date().toISOString(),
  sourceRevision,
  algorithmVersion: report.algorithmVersion ?? null,
  outcome: report.outcome ?? null,
  contentSha256,
  canonicalization: 'JSON.stringify of the parsed verification report with no extra whitespace, followed by a newline',
  verifyCommand: 'node scripts/verify-ledger.mjs --out verification.json && node scripts/export-evidence.mjs verification.json evidence-dir',
  trustAnchor: 'The content hash detects accidental change of this bundle. It does not prove the database administrator could not have produced both the report and the hash. A signature counts only when the private key is held outside this database and outside this repository.',
  signature: null,
};
const keyPath = process.env.EVIDENCE_SIGNING_KEY ?? '';
if (keyPath) {
  const absolute = resolve(keyPath);
  const insideRepo = !relative(process.cwd(), absolute).startsWith('..');
  if (insideRepo) throw new Error('Refusing a signing key stored inside the repository');
  const signed = spawnSync('openssl', ['dgst', '-sha256', '-sign', absolute], { input: canonical });
  if (signed.status !== 0) throw new Error('openssl could not sign the evidence bundle');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await writeFile(`${outputDir}/signature.bin`, signed.stdout, { mode: 0o600 });
  manifest.signature = { algorithm: 'SHA256', format: 'openssl-dgst', file: 'signature.bin', keyPath: 'external' };
}
await mkdir(outputDir, { recursive: true, mode: 0o700 });
await writeFile(`${outputDir}/verification.json`, canonical, { mode: 0o600 });
await writeFile(`${outputDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(`evidence ${manifest.outcome} ${contentSha256}`);
