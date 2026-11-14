import assert from 'node:assert/strict';
import test from 'node:test';
import { routeAllowed } from '../lib/proxy-routes.mjs';

test('phase 6 proxy routes are explicit', () => {
  assert.equal(routeAllowed('GET', 'v1/accounts/11111111-1111-4111-8111-111111111111/controls'), true);
  assert.equal(routeAllowed('POST', 'v1/accounts/11111111-1111-4111-8111-111111111111/controls'), true);
  assert.equal(routeAllowed('POST', 'v1/accounts/11111111-1111-4111-8111-111111111111/trusted-destinations'), true);
  assert.equal(routeAllowed('GET', 'v1/scheduled-transfers'), true);
  assert.equal(routeAllowed('POST', 'v1/scheduled-transfers'), true);
  assert.equal(routeAllowed('POST', 'v1/scheduled-transfers/11111111-1111-4111-8111-111111111111/cancel'), true);
  assert.equal(routeAllowed('GET', 'v1/admin/operations/health'), true);
  assert.equal(routeAllowed('GET', 'v1/admin/deployment'), true);
  assert.equal(routeAllowed('POST', 'v1/admin/deployment'), false);
  assert.equal(routeAllowed('GET', 'v1/admin/gl/trial-balance'), true);
  assert.equal(routeAllowed('GET', 'v1/admin/gl/customer-reconciliation'), true);
  assert.equal(routeAllowed('GET', 'v1/admin/gl/journal-export'), true);
  assert.equal(routeAllowed('GET', 'v1/admin/gl/manual-journal'), false);
  assert.equal(routeAllowed('POST', 'v1/admin/gl/trial-balance'), false);
  assert.equal(routeAllowed('DELETE', 'v1/scheduled-transfers'), false);
  assert.equal(routeAllowed('GET', 'v1/admin/operations/health/extra'), false);
});

test('phase 7 monitor and incident routes are explicit', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal(routeAllowed('GET', 'v1/admin/monitor/alerts'), true);
  assert.equal(routeAllowed('POST', 'v1/admin/monitor/evaluate'), true);
  assert.equal(routeAllowed('POST', `v1/admin/monitor/alerts/${id}/acknowledge`), true);
  assert.equal(routeAllowed('GET', 'v1/admin/incidents'), true);
  assert.equal(routeAllowed('GET', `v1/admin/incidents/${id}`), true);
  assert.equal(routeAllowed('POST', 'v1/admin/incidents'), true);
  assert.equal(routeAllowed('POST', `v1/admin/incidents/${id}/actions`), true);
  assert.equal(routeAllowed('GET', 'v1/admin/monitor'), false);
  assert.equal(routeAllowed('POST', 'v1/admin/monitor/evaluate/extra'), false);
  assert.equal(routeAllowed('POST', 'v1/admin/incidents/not-a-uuid/actions'), false);
  assert.equal(routeAllowed('DELETE', 'v1/admin/incidents'), false);
});

test('phase 10 monetary routes are explicit', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal(routeAllowed('GET', 'v1/monetary/overview'), true);
  assert.equal(routeAllowed('GET', 'v1/monetary/activity'), true);
  assert.equal(routeAllowed('GET', 'v1/monetary/activity/extra'), false);
  assert.equal(routeAllowed('POST', 'v1/monetary/conversions'), true);
  assert.equal(routeAllowed('POST', 'v1/monetary/bank-events'), true);
  assert.equal(routeAllowed('POST', `v1/monetary/issuance/${id}/execute`), true);
  assert.equal(routeAllowed('POST', 'v1/monetary/activation'), true);
  assert.equal(routeAllowed('DELETE', 'v1/monetary/overview'), false);
  assert.equal(routeAllowed('GET', 'v1/monetary/issuance'), false);
  assert.equal(routeAllowed('POST', 'v1/monetary/live'), false);
  assert.equal(routeAllowed('GET', 'v1/monetary/dashboard'), true);
  assert.equal(routeAllowed('GET', 'v1/monetary/evidence'), true);
  assert.equal(routeAllowed('GET', 'v1/monetary/partners'), true);
  assert.equal(routeAllowed('POST', 'v1/monetary/disclosures/acknowledge'), true);
  assert.equal(routeAllowed('POST', 'v1/monetary/evidence'), true);
  assert.equal(routeAllowed('POST', `v1/monetary/evidence/${id}/notes`), true);
  assert.equal(routeAllowed('POST', 'v1/monetary/partners'), true);
  assert.equal(routeAllowed('POST', `v1/monetary/partners/${id}/checks`), true);
  assert.equal(routeAllowed('POST', 'v1/monetary/evidence/not-a-uuid/notes'), false);
  assert.equal(routeAllowed('GET', 'v1/monetary/partners/extra'), false);
});

test('phase 12 institution routes are explicit', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal(routeAllowed('GET', 'v1/institution/institutions'), true);
  assert.equal(routeAllowed('POST', 'v1/institution/institutions'), true);
  assert.equal(routeAllowed('POST', 'v1/institution/transfers'), true);
  assert.equal(routeAllowed('POST', 'v1/institution/payments/transition'), true);
  assert.equal(routeAllowed('GET', `v1/institution/treasury/${id}`), true);
  assert.equal(routeAllowed('GET', `v1/institution/accounts/${id}/${id}/activity`), true);
  assert.equal(routeAllowed('POST', 'v1/institution/sandbox/payments'), true);
  assert.equal(routeAllowed('GET', 'v1/institution/sandbox/treasury'), true);
  assert.equal(routeAllowed('POST', 'v1/institution/activation'), true);
  assert.equal(routeAllowed('DELETE', 'v1/institution/institutions'), false);
  assert.equal(routeAllowed('GET', 'v1/institution/sandbox/payments'), false);
  assert.equal(routeAllowed('POST', 'v1/institution/live'), false);
  assert.equal(routeAllowed('GET', `v1/institution/accounts/${id}`), false);
});

test('phase 13 network routes are explicit', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal(routeAllowed('GET', 'v1/institution/network/dashboard'), true);
  assert.equal(routeAllowed('GET', `v1/institution/network/cycles/${id}`), true);
  assert.equal(routeAllowed('GET', `v1/institution/network/payments/${id}/${id}`), true);
  assert.equal(routeAllowed('POST', 'v1/institution/network/members/currencies'), true);
  assert.equal(routeAllowed('POST', 'v1/institution/network/payments'), true);
  assert.equal(routeAllowed('POST', 'v1/institution/network/settlements/confirm'), true);
  assert.equal(routeAllowed('POST', 'v1/institution/network/activation'), true);
  assert.equal(routeAllowed('POST', 'v1/institution/network/live'), false);
  assert.equal(routeAllowed('DELETE', 'v1/institution/network/payments'), false);
  assert.equal(routeAllowed('GET', 'v1/institution/network/payments'), false);
});

test('phase 14 program routes are explicit', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal(routeAllowed('GET', 'v1/institution/program/dashboard'), true);
  assert.equal(routeAllowed('GET', `v1/institution/program/workflows/${id}`), true);
  assert.equal(routeAllowed('GET', `v1/institution/program/treasury/${id}`), true);
  assert.equal(routeAllowed('POST', 'v1/institution/program/workflows/preview'), true);
  assert.equal(routeAllowed('POST', 'v1/institution/program/settlements'), true);
  assert.equal(routeAllowed('POST', 'v1/institution/program/activation'), true);
  assert.equal(routeAllowed('POST', 'v1/institution/program/live'), false);
  assert.equal(routeAllowed('DELETE', 'v1/institution/program/workflows'), false);
  assert.equal(routeAllowed('GET', 'v1/institution/program/workflows'), false);
});
