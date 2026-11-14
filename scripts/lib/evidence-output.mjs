import { existsSync } from 'node:fs';
import { basename } from 'node:path';

// Preserved measurement files are named phaseN-*. A later drill must pick a
// new path, or set FREEHOLD_EVIDENCE_OVERWRITE=1 for that one run.
export function refuseEvidenceOverwrite(out) {
  if (!out || process.env.FREEHOLD_EVIDENCE_OVERWRITE === '1') return;
  const normalized = String(out).replaceAll('\\', '/');
  const preserved = /(?:^|\/)phase\d+-/i.test(normalized) || /^phase\d+-/i.test(basename(out));
  if (!preserved || !existsSync(out)) return;
  throw new Error(`Refusing to overwrite preserved evidence ${out}. Set FREEHOLD_EVIDENCE_OVERWRITE=1 or choose a new path.`);
}
