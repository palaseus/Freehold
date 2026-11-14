export function classifyTransferOutcome(status, body) {
  const result = body && typeof body === 'object' ? body : null;
  if (status === 200 && result?.operationId && result.state === 'COMPLETED') return 'COMMITTED';
  if (status === 422 && result?.operationId && result.state === 'REJECTED') return 'REJECTED';
  if (status === 409) return 'CONFLICT';
  return 'UNKNOWN';
}
