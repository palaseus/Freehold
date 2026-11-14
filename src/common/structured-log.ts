import { AsyncLocalStorage } from 'node:async_hooks';

export type StructuredLog = Record<string, string | number | boolean | null | undefined | object>;
export const requestContext = new AsyncLocalStorage<{ requestId: string }>();

export function writeJsonLog(fields: StructuredLog): void {
  const requestId = requestContext.getStore()?.requestId;
  const event = requestId && fields.request_id === undefined ? { request_id: requestId, ...fields } : fields;
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
}
