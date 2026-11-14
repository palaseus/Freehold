import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { LEDGER_VERIFIER_VERSION } from './ledger-verifier.mjs';
import { sourceRevision } from './source-revision.mjs';

export function migrationInventory() {
  const directory = new URL('../../db/migrations/', import.meta.url);
  const names = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
  const migrations = names.map(name => {
    const sql = readFileSync(new URL(name, directory));
    return { name, sha256: createHash('sha256').update(sql).digest('hex') };
  });
  const rollup = createHash('sha256');
  for (const migration of migrations) rollup.update(`${migration.name} ${migration.sha256}\n`);
  const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  return {
    migrationVersion: migrations.at(-1)?.name ?? null,
    schemaChecksum: rollup.digest('hex'),
    migrations,
    packageVersion: packageJson.version ?? null,
    verifierAlgorithmVersion: LEDGER_VERIFIER_VERSION,
    sourceRevision: sourceRevision(),
    node: process.version,
  };
}
