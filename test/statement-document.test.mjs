import test from 'node:test';
import assert from 'node:assert/strict';
import { statementCsv, statementPdf } from '../dist/src/account/statement-document.js';

const statement = {
  accountId: '11111111-1111-4111-8111-111111111111',
  ownerUserId: '22222222-2222-4222-8222-222222222222',
  ownerEmail: 'owner@example.test',
  currency: 'JPY',
  minorUnitExponent: 0,
  from: '2026-11-01T00:00:00.000000Z',
  to: '2026-12-01T00:00:00.000000Z',
  generatedAt: '2026-12-01T00:00:01.000000Z',
  openingAvailableMinor: '0',
  closingAvailableMinor: '9007199254740993',
  openingReservedMinor: '0',
  closingReservedMinor: '0',
  debitAvailableMinor: '0',
  creditAvailableMinor: '9007199254740993',
  debitReservedMinor: '0',
  creditReservedMinor: '0',
  lines: [{
    entryId: '33333333-3333-4333-8333-333333333333',
    effectiveAt: '2026-11-11T00:00:00.000000Z',
    operationId: '44444444-4444-4444-8444-444444444444',
    journalId: '55555555-5555-4555-8555-555555555555',
    kind: 'SANDBOX_FUND',
    bucket: 'AVAILABLE',
    side: 'CREDIT',
    amountMinor: '9007199254740993',
    counterpartyAccountId: null,
  }],
  nextCursorTime: null,
  nextCursorId: null,
};

test('statement exports keep integer minor units and a readable pdf', () => {
  const csv = statementCsv(statement);
  assert.match(csv, /9007199254740993/);
  assert.doesNotMatch(csv, /9007199254740992/);
  assert.match(csv, /^section,currency,exponent/);
  const risky = statementCsv({ ...statement, lines: [{ ...statement.lines[0], kind: '=HYPERLINK("http://example.test")' }] });
  assert.match(risky, /'=HYPERLINK/);
  const pdf = statementPdf(statement);
  assert.equal(pdf.subarray(0, 8).toString(), '%PDF-1.4');
  assert.match(pdf.toString('latin1'), /%%EOF$/);
  assert.match(pdf.toString('latin1'), /9007199254740993/);
  const many = statementPdf({ ...statement, lines: Array.from({ length: 50 }, (_, index) => ({ ...statement.lines[0], entryId: `${index}` })) });
  assert.equal(many.subarray(0, 8).toString(), '%PDF-1.4');
  assert.match(many.toString('latin1'), /%%EOF$/);
});
