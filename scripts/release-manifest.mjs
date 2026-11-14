#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { refuseEvidenceOverwrite } from './lib/evidence-output.mjs';
import { signatureFor } from './lib/evidence-signature.mjs';
import { migrationInventory } from './lib/release-tree.mjs';

const outIndex = process.argv.indexOf('--out');
const out = outIndex >= 0 ? process.argv[outIndex + 1] : null;
if (out) refuseEvidenceOverwrite(out);
const tree = migrationInventory();
const body = {
  manifestType: 'freehold.release-manifest',
  generatedAt: new Date().toISOString(),
  sourceRevision: tree.sourceRevision,
  migrationVersion: tree.migrationVersion,
  schemaChecksum: tree.schemaChecksum,
  migrations: tree.migrations,
  build: { node: tree.node, packageVersion: tree.packageVersion },
  verifierAlgorithmVersion: tree.verifierAlgorithmVersion,
  custody: 'REQUIRES_EXTERNAL_REVIEW',
  independence: 'A signature made on this host does not prove the signer is independent of this host.',
};
const report = { ...body, signature: signatureFor(body, process.env.EVIDENCE_SIGNING_KEY ?? '') };
const text = `${JSON.stringify(report, null, 2)}\n`;
if (out) writeFileSync(out, text, { mode: 0o600 });
if (!out || process.argv.includes('--json')) process.stdout.write(text);
