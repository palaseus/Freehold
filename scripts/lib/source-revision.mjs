import { spawnSync } from 'node:child_process';

export function sourceRevision() {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (git.status !== 0) return 'unknown';
  const dirty = spawnSync('git', ['diff', '--quiet', 'HEAD']);
  const revision = git.stdout.trim();
  return dirty.status === 0 ? revision : `${revision}-dirty`;
}
