import { createHash } from 'node:crypto';
export const idempotencyKeyHash = (key: string) => createHash('sha256').update(key).digest();
