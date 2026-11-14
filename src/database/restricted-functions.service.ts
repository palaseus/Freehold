import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

export interface StoredBody {
  operationId: string;
  correlationId: string;
  state: 'COMPLETED' | 'REJECTED';
  error?: string;
  [key: string]: unknown;
}
export interface StoredResult { status: number; body: StoredBody }

@Injectable()
export class RestrictedFunctions {
  private async call(client: PoolClient, actor: string, sql: string, params: unknown[]): Promise<StoredResult> {
    const posted = await client.query<{ body: StoredBody }>(sql, params);
    const body = posted.rows[0]?.body;
    if (!body) throw new Error('Posting function returned no result');
    // Separate command sees function writes and returns the durable HTTP status,
    // including the original status on a replay. Never infer it from balance state.
    const stored = await client.query<{ response_status: number; response_body: StoredBody }>(
      'SELECT response_status,response_body FROM freehold.customer_operation_result($1::uuid,$2::uuid)',
      [actor, body.operationId]);
    const row = stored.rows[0];
    if (!row?.response_status || !row.response_body) throw new Error('Missing durable operation result');
    return { status: row.response_status, body: row.response_body };
  }
  transfer(c: PoolClient, actor: string, source: string, destination: string, currency: string, amount: string, key: string, correlation: string) {
    return this.call(c, actor, 'SELECT freehold.execute_internal_transfer($1::uuid,$2::uuid,$3::uuid,$4::text,$5::bigint,$6::text,$7::uuid) AS body', [actor, source, destination, currency, amount, key, correlation]);
  }
  createAccount(c: PoolClient, actor: string, currency: string, key: string, correlation: string) {
    return this.call(c, actor, 'SELECT freehold.create_account($1::uuid,$2::text,$3::text,$4::uuid) AS body', [actor, currency, key, correlation]);
  }
  freeze(c: PoolClient, actor: string, account: string, frozen: boolean, key: string, reason: string, correlation: string) {
    return this.call(c, actor, 'SELECT freehold.set_account_frozen($1::uuid,$2::uuid,$3::boolean,$4::text,$5::text,$6::uuid) AS body', [actor, account, frozen, key, reason, correlation]);
  }
  reserve(c: PoolClient, actor: string, account: string, amount: string, key: string, purpose: string, expiresAt: string | null, correlation: string) {
    return this.call(c, actor, 'SELECT freehold.reserve_funds($1::uuid,$2::uuid,$3::bigint,$4::text,$5::text,$6::timestamptz,$7::uuid) AS body', [actor, account, amount, key, purpose, expiresAt, correlation]);
  }
  release(c: PoolClient, actor: string, hold: string, key: string, correlation: string) {
    return this.call(c, actor, 'SELECT freehold.release_hold($1::uuid,$2::uuid,$3::text,$4::uuid) AS body', [actor, hold, key, correlation]);
  }
  sandboxFund(c: PoolClient, actor: string, account: string, amount: string, key: string, reason: string, correlation: string) {
    return this.call(c, actor, 'SELECT freehold.sandbox_fund_account($1::uuid,$2::uuid,$3::bigint,$4::text,$5::text,$6::uuid) AS body', [actor, account, amount, key, reason, correlation]);
  }
}
