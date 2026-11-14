import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPosture, assertProductionProcess } from '../dist/src/config/production-posture.js';

const snapshot = { ...process.env };
function restore() {
  for (const key of Object.keys(process.env)) if (!(key in snapshot)) delete process.env[key];
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
}

test('production boot refuses demo, shared credentials, weak TLS, and an open Redis', () => {
  const database = 'postgresql://freehold_api:freehold-production-test-password-0123456789@postgres:5432/freehold?sslmode=verify-full';
  const worker = 'postgresql://freehold_worker:freehold-production-test-password-0123456789@postgres:5432/freehold?sslmode=verify-full';
  try {
    process.env.NODE_ENV = 'test';
    process.env.MONETARY_LIVE_ISSUANCE = '1';
    assert.throws(() => assertProductionProcess('api'), /MONETARY_LIVE_ISSUANCE/);
    delete process.env.MONETARY_LIVE_ISSUANCE;
    process.env.DEMO_MODE = 'true';
    assertProductionProcess('api');

    process.env.NODE_ENV = 'production';
    assert.throws(() => assertProductionProcess('api'), /DEMO_MODE/);
    delete process.env.DEMO_MODE;
    process.env.DEMO_BOOTSTRAP_TOKEN = 'x'.repeat(32);
    assert.throws(() => assertProductionProcess('api'), /DEMO_BOOTSTRAP_TOKEN/);
    delete process.env.DEMO_BOOTSTRAP_TOKEN;
    process.env.DEMO_USER_PASSWORD = 'y'.repeat(16);
    assert.throws(() => assertProductionProcess('api'), /DEMO_USER_PASSWORD/);
    delete process.env.DEMO_USER_PASSWORD;

    for (const key of ['AUTH_DATABASE_URL', 'WORKER_DATABASE_URL', 'SCHEDULER_DATABASE_URL', 'MIGRATION_DATABASE_URL', 'VERIFY_DATABASE_URL', 'CHECK_DATABASE_URL']) {
      delete process.env[key];
    }
    process.env.APP_ORIGIN = 'https://ledger.example';
    process.env.COOKIE_SECURE = 'true';
    process.env.REDIS_URL = 'redis://:production-redis-password@redis:6379';
    process.env.DATABASE_URL = 'postgresql://freehold_api:short@postgres:5432/freehold?sslmode=verify-full';
    assert.throws(() => assertProductionProcess('api'), /at least 16 characters/);
    process.env.DATABASE_URL = 'postgresql://freehold_api:freehold-production-test-password-0123456789@postgres:5432/freehold';
    assert.throws(() => assertProductionProcess('api'), /sslmode=verify-full/);
    process.env.DATABASE_URL = 'postgresql://freehold_api:freehold-production-test-password-0123456789@postgres:5432/freehold?sslmode=require';
    assert.throws(() => assertProductionProcess('api'), /sslmode=verify-full/);
    process.env.DATABASE_URL = database;
    process.env.REDIS_URL = 'redis://redis:6379';
    assert.throws(() => assertProductionProcess('api'), /Redis requires a password/);
    process.env.REDIS_URL = 'redis://:production-redis-password@redis:6379';
    process.env.MONETARY_SIMULATOR_HMAC_KEY = 'simulator-only';
    assert.throws(() => assertProductionProcess('api'), /MONETARY_SIMULATOR_HMAC_KEY/);
    delete process.env.MONETARY_SIMULATOR_HMAC_KEY;
    assertProductionProcess('api');
    process.env.AUTH_DATABASE_URL = 'postgresql://freehold_auth:freehold-production-test-password-0123456789@postgres:5432/freehold?sslmode=verify-full';
    assert.throws(() => assertProductionProcess('api'), /must not hold AUTH_DATABASE_URL/);
    delete process.env.AUTH_DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://postgres:freehold-production-test-password-0123456789@postgres:5432/freehold?sslmode=verify-full';
    assert.throws(() => assertProductionProcess('api'), /freehold_api/);

    process.env.DATABASE_URL = database;
    process.env.WORKER_DATABASE_URL = worker;
    assert.throws(() => assertProductionProcess('worker'), /must not hold DATABASE_URL/);
    delete process.env.DATABASE_URL;
    assertProductionProcess('worker');

    assert.throws(() => assertPosture({ sandboxEnabled: true, demoEnabled: false }), /sandbox or demo/);
    assert.throws(() => assertPosture({ sandboxEnabled: false, demoEnabled: true }), /sandbox or demo/);
    assert.throws(() => assertPosture(undefined), /sandbox or demo/);
    assertPosture({ sandboxEnabled: false, demoEnabled: false });
    process.env.NODE_ENV = 'test';
    assertPosture({ sandboxEnabled: true, demoEnabled: true });
  } finally {
    restore();
  }
});
