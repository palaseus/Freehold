export interface StatementLine {
  entryId: string; effectiveAt: string; operationId: string; journalId: string; kind: string;
  bucket: string; side: string; amountMinor: string; counterpartyAccountId: string | null;
}
export interface AccountStatement {
  accountId: string; ownerUserId: string; ownerEmail: string; currency: string; minorUnitExponent: number;
  from: string; to: string; generatedAt: string;
  openingAvailableMinor: string; closingAvailableMinor: string;
  openingReservedMinor: string; closingReservedMinor: string;
  debitAvailableMinor: string; creditAvailableMinor: string;
  debitReservedMinor: string; creditReservedMinor: string;
  lines: StatementLine[]; nextCursorTime: string | null; nextCursorId: string | null;
}

const cell = (value: unknown) => {
  const text = value == null ? '' : String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export function statementCsv(statement: AccountStatement): string {
  const rows = [
    ['section', 'currency', 'exponent', 'bucket', 'field', 'amountMinor', 'side', 'effectiveAt', 'operationId', 'entryId', 'counterpartyAccountId', 'kind'],
    ['balance', statement.currency, statement.minorUnitExponent, 'AVAILABLE', 'opening', statement.openingAvailableMinor, '', statement.from, '', '', '', ''],
    ['balance', statement.currency, statement.minorUnitExponent, 'AVAILABLE', 'closing', statement.closingAvailableMinor, '', statement.to, '', '', '', ''],
    ['balance', statement.currency, statement.minorUnitExponent, 'RESERVED', 'opening', statement.openingReservedMinor, '', statement.from, '', '', '', ''],
    ['balance', statement.currency, statement.minorUnitExponent, 'RESERVED', 'closing', statement.closingReservedMinor, '', statement.to, '', '', '', ''],
    ['activity_total', statement.currency, statement.minorUnitExponent, 'AVAILABLE', 'debit', statement.debitAvailableMinor, 'DEBIT', '', '', '', '', ''],
    ['activity_total', statement.currency, statement.minorUnitExponent, 'AVAILABLE', 'credit', statement.creditAvailableMinor, 'CREDIT', '', '', '', '', ''],
    ['activity_total', statement.currency, statement.minorUnitExponent, 'RESERVED', 'debit', statement.debitReservedMinor, 'DEBIT', '', '', '', '', ''],
    ['activity_total', statement.currency, statement.minorUnitExponent, 'RESERVED', 'credit', statement.creditReservedMinor, 'CREDIT', '', '', '', '', ''],
    ...statement.lines.map(line => ['line', statement.currency, statement.minorUnitExponent, line.bucket, 'entry', line.amountMinor, line.side, line.effectiveAt, line.operationId, line.entryId, line.counterpartyAccountId ?? '', line.kind]),
  ];
  return `${rows.map(row => row.map(cell).join(',')).join('\n')}\n`;
}

function pdfPages(lines: string[]): Buffer {
  const escape = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const chunks: string[][] = [];
  for (let i = 0; i < lines.length; i += 45) chunks.push(lines.slice(i, i + 45));
  if (!chunks.length) chunks.push(['Freehold account statement']);
  const objects: string[] = [];
  const pageIds: number[] = [];
  let next = 3;
  const fontId = 2 + chunks.length * 2 + 1;
  for (const chunk of chunks) {
    const pageId = next++;
    const contentId = next++;
    pageIds.push(pageId);
    const commands = ['BT', '/F1 9 Tf', '48 760 Td', '14 TL', ...chunk.flatMap(line => [`(${escape(line.slice(0, 110))}) Tj`, 'T*']), 'ET'];
    const stream = commands.join('\n');
    objects[pageId] = `${pageId} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >> endobj\n`;
    objects[contentId] = `${contentId} 0 obj << /Length ${Buffer.byteLength(stream)} >> stream\n${stream}\nendstream\nendobj\n`;
  }
  objects[1] = `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n`;
  objects[2] = `2 0 obj << /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >> endobj\n`;
  objects[fontId] = `${fontId} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n`;
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let id = 1; id <= fontId; id++) {
    offsets[id] = Buffer.byteLength(body);
    body += objects[id];
  }
  const xref = Buffer.byteLength(body);
  let xrefBody = `xref\n0 ${fontId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= fontId; id++) xrefBody += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(`${body}${xrefBody}trailer << /Size ${fontId + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}

export function statementPdf(statement: AccountStatement): Buffer {
  const lines = [
    'Freehold account statement',
    `Generated ${statement.generatedAt}`,
    `Account ${statement.accountId}`,
    `Owner ${statement.ownerUserId} ${statement.ownerEmail}`,
    `Currency ${statement.currency} exponent ${statement.minorUnitExponent}`,
    `Window ${statement.from} to ${statement.to} exclusive`,
    `Opening available ${statement.openingAvailableMinor}`,
    `Closing available ${statement.closingAvailableMinor}`,
    `Opening reserved ${statement.openingReservedMinor}`,
    `Closing reserved ${statement.closingReservedMinor}`,
    'Amounts are integer minor units.',
    ...statement.lines.map(line => `${line.effectiveAt} ${line.bucket} ${line.side} ${line.amountMinor} ${line.kind} ${line.operationId}`),
  ];
  return pdfPages(lines);
}
