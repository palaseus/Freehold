export type TransferOutcome = 'COMMITTED' | 'REJECTED' | 'UNKNOWN' | 'CONFLICT';
export function classifyTransferOutcome(status: number, body: unknown): TransferOutcome;
