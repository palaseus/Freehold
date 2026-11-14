# Production release gate

Run `npm run check:production -- --out /secure/evidence/deployment.json` from the exact clean, committed release tree. `NODE_ENV=production` also enables the production checks for direct invocations of `scripts/deployment-check.mjs`. The default checker reports scope `technical`; only scope `production` can be used for production acceptance. Exit 0 means all configured checks passed, 2 means NOT_READY, and 3 means INCOMPLETE. Operator attestations are reviewed records, not independent verification of an external system.

## Environment inputs

Supply these through the deployment runner's secret manager; do not commit credentials or paste them into evidence:

| Variable | Purpose |
| --- | --- |
| `CHECK_ENVIRONMENT` | Exact target environment identifier |
| `CHECK_DATABASE_URL` | Auditor connection for the read-only database checks |
| `VERIFY_DATABASE_URL` | Separate restricted verifier connection |
| `CHECK_API_URL` | HTTPS URL of `/ready`, using trusted TLS certificates |
| `CHECK_BACKUP_MANIFEST` | Recent encrypted backup manifest with SHA-256 and independently administered offsite copy |
| `CHECK_BACKUP_MAX_AGE_HOURS` | Positive finite backup age limit, default 24 hours |
| `CHECK_PRODUCTION_EVIDENCE` | Path to the reviewed environment evidence JSON below |

The database checks do not apply migrations. The production tree must have a built frontend. Do not give runtime services the auditor, verifier, or migration credentials.

## Evidence format

All five controls are required. Each measurement and the overall record must be at most 24 hours old, with no future timestamps. `sourceRevision` must match the clean release commit. Keep the references in access-controlled storage and exclude secrets. Replace the placeholders with actual measurements; this example cannot pass.

```json
{
  "environment": "TARGET_ENVIRONMENT",
  "sourceRevision": "RELEASE_COMMIT",
  "generatedAt": "MEASUREMENT_TIMESTAMP",
  "controls": {
    "secrets": { "status": "INCOMPLETE", "measuredAt": "", "reviewedBy": "", "reference": "" },
    "tls": { "status": "INCOMPLETE", "measuredAt": "", "reviewedBy": "", "reference": "" },
    "recovery": { "status": "INCOMPLETE", "measuredAt": "", "reviewedBy": "", "reference": "" },
    "monitoring": { "status": "INCOMPLETE", "measuredAt": "", "reviewedBy": "", "reference": "" },
    "staged_deployment": { "status": "INCOMPLETE", "measuredAt": "", "reviewedBy": "", "reference": "" }
  }
}
```

## Measurements required before cutover

1. Provision separate runtime identities, strong unique secrets, key rotation and revocation procedures in the target secret manager. Confirm each process receives only its required credentials and refuses demo/sandbox settings.
2. Verify the public HTTPS endpoint, certificate chain and renewal; verify database TLS hostname checks. Record firewall and internal service transport boundaries. The live gate checks HTTPS `/ready` and requires HTTP 200 with `status: accepting` without redirects.
3. Export an encrypted backup to independently administered storage. Verify its checksum, restore that actual backup and WAL into an isolated database, and independently verify the restored ledger. Record measured RPO/RTO against approved objectives, retention, storage permissions, and recovery key availability.
4. Route service logs and alerts to the target monitoring system. Trigger and acknowledge tests for API readiness loss, worker/scheduler stale heartbeats, failed verification, backup age, WAL failures, database capacity, and certificate expiry. Record the on-call owner and response procedure.
5. Deploy the exact release artifact to staging with the target topology and migrations through the current migration inventory. Exercise authentication, authorized posting, idempotent retry, worker/scheduler recovery, and frontend flows. Record artifact digests, migration checksums, results, and a rehearsed recovery procedure. Recovery must preserve committed ledger data; do not roll back ledger migrations.
6. Review the evidence, run the production gate, and retain its report with the release artifacts. Obtain cutover approval before changing persistent infrastructure. A local rehearsal cannot supply the environment attestations.

## Local verification, 2026-11-14

The API integration suite (including fresh-install migrations through 034), 11 web tests, API and web builds, and both dependency audits passed. Both audits reported zero vulnerabilities. The secret scan passed. The disposable TLS production rehearsal passed technical checks and correctly returned NOT_READY for a local-only backup. The encrypted backup restore was VERIFIED; wrong and missing passphrases did not verify. The PITR drill restored to the selected time with verification VERIFIED and excluded the subsequent transaction. Truncated backups and invalid recovery targets were rejected, a damaged projection produced MISMATCH, and Redis restart preserved journals. Local measurements: backup 112,447 ms, crash recovery 3,227 ms, target restore 5,214 ms. These are not production RPO/RTO guarantees. Fresh results are under `/tmp/freehold-production-*`; they are local measurements and are not production acceptance evidence.

CI now includes the gate regression tests and disposable production boot/PITR rehearsals. A committed workflow is not evidence that hosted CI has run. Existing untracked evidence and documentation were preserved.
