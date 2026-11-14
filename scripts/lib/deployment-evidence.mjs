// Operator attestations complement live checks; they do not independently prove controls.
export function backupProblem(manifest, maxHours = 24, now = Date.now()) {
  const age = now - Date.parse(manifest?.generatedAt);
  if (!Number.isFinite(maxHours) || maxHours <= 0) return 'Backup maximum age must be a positive finite number.';
  if (!/^[a-f0-9]{64}$/i.test(manifest?.sha256 ?? '') || !Number.isFinite(age)) return 'Backup requires a SHA-256 and timestamp.';
  if (age < 0 || age > maxHours * 3600000) return 'Backup timestamp is future-dated or expired.';
  if (manifest.offsiteCopy !== true) return 'Backup has no independently administered copy.';
  if (manifest.encrypted !== true) return 'Backup encryption is not recorded.';
  return null;
}

export function productionEvidenceChecks(evidence, environment, revision, now = Date.now()) {
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });
  const age = now - Date.parse(evidence?.generatedAt);
  const bound = environment && evidence?.environment === environment &&
    revision !== 'unknown' && !revision.endsWith('-dirty') && evidence?.sourceRevision === revision &&
    Number.isFinite(age) && age >= 0 && age <= 86400000;
  add('production_evidence_binding', bound ? 'PASS' : 'INCOMPLETE',
    bound ? 'Operator evidence matches the environment and clean revision and is under 24 hours old.' :
      'Supply fresh evidence matching CHECK_ENVIRONMENT and a clean source revision.');
  for (const id of ['secrets', 'tls', 'recovery', 'monitoring', 'staged_deployment']) {
    const control = evidence?.controls?.[id];
    const measuredAge = now - Date.parse(control?.measuredAt);
    const valid = bound && control?.status === 'PASS' && typeof control?.reference === 'string' &&
      control.reference.trim().length > 0 && typeof control?.reviewedBy === 'string' && control.reviewedBy.trim().length > 0 &&
      Number.isFinite(measuredAge) && measuredAge >= 0 && measuredAge <= 86400000;
    add(`production_${id}`, valid ? 'PASS' : control?.status === 'FAIL' ? 'FAIL' : 'INCOMPLETE',
      valid ? 'Operator attestation includes a fresh measurement, reviewer, and evidence reference.' : 'A fresh environment-bound operator attestation is required.');
  }
  return checks;
}
