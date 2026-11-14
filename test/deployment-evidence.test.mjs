import test from 'node:test';
import assert from 'node:assert/strict';
import { backupProblem, productionEvidenceChecks } from '../scripts/lib/deployment-evidence.mjs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const now = Date.parse('2026-11-14T12:00:00Z');
const fresh = '2026-11-14T11:00:00Z';
test('backup evidence rejects future timestamps, invalid retention, missing encryption and malformed checksums', () => {
  const backup = { generatedAt: fresh, sha256: 'a'.repeat(64), offsiteCopy: true, encrypted: true };
  assert.equal(backupProblem(backup, 24, now), null);
  for (const hours of [NaN, Infinity, 0, -1]) assert.ok(backupProblem(backup, hours, now));
  for (const changes of [{ generatedAt: '2026-11-15' }, { generatedAt: '2026-11-12' }, { sha256: 'present' }, { encrypted: false }, { offsiteCopy: false }]) {
    assert.ok(backupProblem({ ...backup, ...changes }, 24, now));
  }
});

test('production cannot pass with absent, stale, wrong-environment or wrong-release evidence', () => {
  const revision = 'abc123';
  const evidence = { environment: 'stage', sourceRevision: revision, generatedAt: fresh,
    controls: Object.fromEntries(['secrets', 'tls', 'recovery', 'monitoring', 'staged_deployment'].map(id =>
      [id, { status: 'PASS', measuredAt: fresh, reference: `evidence/${id}`, reviewedBy: 'operator' }])) };
  const passes = (report, environment = 'stage', source = revision) =>
    productionEvidenceChecks(report, environment, source, now).every(check => check.status === 'PASS');
  assert.equal(passes(evidence), true);
  assert.equal(passes(undefined), false);
  assert.equal(passes(evidence, 'production'), false);
  assert.equal(passes(evidence, 'stage', `${revision}-dirty`), false);
  assert.equal(passes({ ...evidence, generatedAt: '2026-11-12' }), false);
  assert.equal(passes({ ...evidence, controls: {} }), false);
  evidence.controls.monitoring.status = 'FAIL';
  assert.equal(passes(evidence), false);
  assert.equal(productionEvidenceChecks(evidence, 'stage', revision, now).find(c => c.id === 'production_monitoring').status, 'FAIL');
});

test('deployment CLI rejects a generic HTTP 200 and accepts the actual readiness response', async () => {
  let body = { status: 'live' };
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    async function check() {
      const child = spawn(process.execPath, ['scripts/deployment-check.mjs', '--json', '--production'], {
        env: { PATH: process.env.PATH, CHECK_API_URL: `http://127.0.0.1:${server.address().port}/ready` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let errors = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errors += chunk; });
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      assert.ok([2, 3].includes(code), errors);
      return JSON.parse(output);
    }
    let report = await check();
    assert.equal(report.checks.find(c => c.id === 'api_readiness').status, 'FAIL');
    body = { status: 'accepting' };
    report = await check();
    assert.equal(report.checks.find(c => c.id === 'api_readiness').status, 'PASS');
    assert.equal(report.checks.find(c => c.id === 'production_api_tls').status, 'FAIL');
    assert.equal(report.checks.find(c => c.id === 'production_evidence_binding').status, 'INCOMPLETE');
    assert.notEqual(report.result, 'READY');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
