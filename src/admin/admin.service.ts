import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import type { Principal } from '../auth/auth.types';
@Injectable()
export class AdminService {
  constructor(private readonly db: DatabaseService) {}
  list(principal: Principal, query: string, limit: number) {
    return this.db.transaction(principal, c => this.db.read('SELECT * FROM freehold.governance_admin_list_accounts($1::uuid,$2::text,$3::integer)', [principal.user.id, query, limit], c), true);
  }
  latestReconciliation(principal: Principal) {
    return this.db.transaction(principal, async c => {
      const [row] = await this.db.read<{ report: unknown }>('SELECT freehold.governance_read_reconciliation($1::uuid) AS report', [principal.user.id], c);
      return row?.report ?? null;
    }, true);
  }
  auditEvents(principal: Principal, limit: number) {
    return this.db.transaction(principal, async c => {
      const [row] = await this.db.read<{ events: unknown }>('SELECT freehold.governance_read_audit($1::uuid,$2::integer) AS events', [principal.user.id,limit], c);
      return row?.events ?? [];
    }, true);
  }
  freeze(principal: Principal, account: string, frozen: boolean, reason: string, key: string) {
    return this.db.transaction(principal, async c => {
      const [row] = await this.db.read<{ request: unknown }>(
        'SELECT freehold.governance_create_account_request($1::uuid,$2::uuid,$3::boolean,$4::text,$5::text) AS request',
        [principal.user.id, account, frozen, reason, key], c);
      return row?.request;
    }, true);
  }
  overview(principal: Principal) {
    return this.db.transaction(principal, async c => {
      const [row] = await this.db.read<{ overview: unknown }>('SELECT freehold.governance_overview($1::uuid) AS overview', [principal.user.id], c);
      return row?.overview;
    }, true);
  }
  decide(principal: Principal, requestId: string, decision: 'APPROVE'|'REJECT') {
    return this.db.transaction(principal, async c => {
      const [row] = await this.db.read<{ result: unknown }>('SELECT freehold.governance_decide($1::uuid,$2::uuid,$3::text) AS result', [principal.user.id,requestId,decision], c);
      return row?.result;
    }, true);
  }
  execute(principal: Principal, requestId: string, key: string) {
    const correlationId = randomUUID();
    return this.db.transaction(principal, async c => {
      const [row] = await this.db.read<{ result: { status?: string; result?: { operationId?: string; correlationId?: string } } }>(
        'SELECT freehold.governance_execute($1::uuid,$2::uuid,$3::text,$4::uuid) AS result',
        [principal.user.id,requestId,key,correlationId],c);
      return row?.result;
    }, true, { operationType: 'GOVERNANCE_EXECUTION', correlationId, governanceRequestId: requestId });
  }
  cancel(principal: Principal, requestId: string) {
    return this.db.transaction(principal, async c => {
      const [row] = await this.db.read<{ result: unknown }>('SELECT freehold.governance_cancel($1::uuid,$2::uuid) AS result',[principal.user.id,requestId],c);
      return row?.result;
    }, true);
  }
  suspend(principal: Principal, reason: string) {
    return this.db.transaction(principal, async c => {
      const [row] = await this.db.read<{ result: unknown }>('SELECT freehold.governance_suspend_writes($1::uuid,$2::text) AS result',[principal.user.id,reason],c);
      return row?.result;
    }, true);
  }
  requestResume(principal: Principal, reason: string, key: string) {
    return this.db.transaction(principal, async c => {
      const [row] = await this.db.read<{ result: unknown }>('SELECT freehold.governance_create_resume_request($1::uuid,$2::text,$3::text) AS result',[principal.user.id,reason,key],c);
      return row?.result;
    }, true);
  }
}
