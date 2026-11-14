import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMinor } from '../lib/money.mjs';
test('minor units retain precision beyond Number safe integer limits', () => {
  assert.equal(formatMinor('9223372036854775807', 2), '92,233,720,368,547,758.07');
  assert.equal(formatMinor('2500', 2), '25.00');
  assert.equal(formatMinor('1', 0), '1');
  assert.equal(formatMinor('1', 18), '0.000000000000000001');
  assert.equal(formatMinor('-1', 3), '−0.001');
});
test('unknown precision never produces a fictitious zero', () => {
  assert.equal(formatMinor('100', undefined), 'Precision unavailable');
  assert.equal(formatMinor('1e4', 2), 'Precision unavailable');
});
