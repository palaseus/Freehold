export const NETWORK_MESSAGE_FAMILIES = [
  'pain.001.001.09',
  'pacs.008.001.08',
  'pacs.002.001.10',
  'pacs.004.001.09',
  'camt.053.001.08',
];

const ROOT = {
  'pain.001.001.09': 'CstmrCdtTrfInitn',
  'pacs.008.001.08': 'FIToFICstmrCdtTrf',
  'pacs.002.001.10': 'FIToFIPmtStsRpt',
  'pacs.004.001.09': 'PmtRtr',
  'camt.053.001.08': 'BkToCstmrStmt',
};

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

export function buildSimulatedMessage({ family, messageId, paymentId, amountMinor, currency, purpose }) {
  if (!NETWORK_MESSAGE_FAMILIES.includes(family)) throw new Error('NETWORK_MESSAGE');
  const root = ROOT[family];
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:${family}">
  <${root}>
    <GrpHdr><MsgId>${escapeXml(messageId)}</MsgId></GrpHdr>
    <SimulatedPayment id="${escapeXml(paymentId)}" currency="${escapeXml(currency)}" minor="${escapeXml(amountMinor)}">${escapeXml(purpose)}</SimulatedPayment>
  </${root}>
</Document>`;
  return {
    family,
    messageId,
    body,
    certification: false,
    liveSend: false,
    schemaScope: 'SIMULATED_SUBSET',
    fedwireCompatible: false,
  };
}

export function validateSimulatedMessage({ family, messageId, body }) {
  const text = String(body ?? '');
  const known = NETWORK_MESSAGE_FAMILIES.includes(family);
  const ok = known && text.length > 0 && text.length <= 8000 && text.includes(family) && text.includes(String(messageId));
  return { ok, certification: false, liveSend: false, schemaScope: 'SIMULATED_SUBSET' };
}
