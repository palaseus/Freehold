// Validate the tracked publication tree, without opening local credentials or archives.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const files = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean));
const problems = [];
for (const file of files) {
  if (/(^|\/)(node_modules|\.next|dist|logs|backups|wal-archive|pgdata|tmp)\//.test(file) ||
      /^docs\/evidence\//.test(file) || /(^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith('.example') ||
      /\.(dump|pgdump|pem|key|log)$/.test(file) || /^(prompt|report)\.md$/.test(file)) {
    problems.push(`Non-publication file is tracked: ${file}`);
  }
  if (!file.endsWith('.md')) continue;
  for (const match of readFileSync(path.join(root, file), 'utf8').matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
    if (!files.has(relative)) problems.push(`Unpublished documentation link: ${file} -> ${target}`);
  }
}
for (const name of ['LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'README.md', 'CHANGELOG.md', 'scripts/check-migrations.mjs']) {
  if (!files.has(name)) problems.push(`Required release file missing: ${name}`);
}
for (const name of ['package.json', 'web/package.json']) {
  const metadata = JSON.parse(readFileSync(path.join(root, name), 'utf8'));
  if (metadata.private !== true || metadata.license !== 'UNLICENSED') problems.push(`${name} must stay private and UNLICENSED.`);
}
if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
} else console.log(`PASS release tree: ${files.size} tracked files, documentation links and rights-reserved package metadata valid.`);
