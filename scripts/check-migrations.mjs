import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const names = (await readdir(new URL('../db/migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort();
let ok = true;
for (const name of names) {
  const sql = await readFile(new URL(`../db/migrations/${name}`, import.meta.url), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  if (!/^\d{3}_/.test(name)) { console.log('BAD_NAME', name); ok = false; }
  if (!sql.trim()) { console.log('EMPTY', name); ok = false; }
  console.log(name, checksum);
}
console.log(ok ? 'MIGRATION_FILES_OK' : 'MIGRATION_FILES_BAD');
if (!ok) process.exit(1);
