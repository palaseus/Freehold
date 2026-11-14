import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyTransferOutcome } from '../lib/transfer-outcome.mjs';

test('only an authoritative stored response is terminal', () => {
  assert.equal(classifyTransferOutcome(200, { operationId: 'op', state: 'COMPLETED' }), 'COMMITTED');
  assert.equal(classifyTransferOutcome(422, { operationId: 'op', state: 'REJECTED' }), 'REJECTED');
  assert.equal(classifyTransferOutcome(422, { code: 'INVALID_REQUEST' }), 'UNKNOWN');
});

test('conflict, network interruption, and server failure are not proof of rejection', () => {
  assert.equal(classifyTransferOutcome(409, { code: 'IDEMPOTENCY_CONFLICT' }), 'CONFLICT');
  assert.equal(classifyTransferOutcome(0, { code: 'NETWORK_UNAVAILABLE' }), 'UNKNOWN');
  assert.equal(classifyTransferOutcome(503, { code: 'RETRY_SAME_IDEMPOTENCY_KEY' }), 'UNKNOWN');
  assert.equal(classifyTransferOutcome(500, { code: 'INTERNAL_ERROR' }), 'UNKNOWN');
});
