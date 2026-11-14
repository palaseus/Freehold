import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyAllowedProxyHeaders } from '../lib/proxy-headers.mjs';

test('proxy forwards only application headers and strips untrusted client identity headers', () => {
  const input = new Headers({
    cookie: 'session=opaque', origin: 'https://freehold.example', 'content-type': 'application/json',
    'x-csrf-token': 'csrf', 'idempotency-key': 'key', 'x-forwarded-for': '127.0.0.1',
    'x-real-ip': '127.0.0.1', 'x-freehold-client': 'admin', authorization: 'Bearer attacker',
  });
  const output = copyAllowedProxyHeaders(input);
  assert.equal(output.get('cookie'), 'session=opaque');
  assert.equal(output.get('origin'), 'https://freehold.example');
  assert.equal(output.get('idempotency-key'), 'key');
  assert.equal(output.has('x-forwarded-for'), false);
  assert.equal(output.has('x-real-ip'), false);
  assert.equal(output.has('x-freehold-client'), false);
  assert.equal(output.has('authorization'), false);
});
