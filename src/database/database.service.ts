import { Injectable, Logger, OnModuleDestroy, OnModuleInit, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { Config } from '../config/config.module';
import type { AuthUser, Principal } from '../auth/auth.types';
import { writeJsonLog } from '../common/structured-log';
import { assertProductionLedger } from '../config/production-posture';
import { assertRuntimePrivileges } from './runtime-privileges';

export interface FinancialOperationContext {
  operationType: string;
  correlationId: string;
  governanceRequestId?: string;
  idempotencyKeyHash?: Buffer;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;
  private readonly logger = new Logger(DatabaseService.name);
  constructor(private readonly config: Config) {
    this.pool = new Pool({
      connectionString: config.databaseUrl, max: 10,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
      options: '-c statement_timeout=10000 -c idle_in_transaction_session_timeout=10000',
    });
    this.pool.on('error', () => this.logger.error('Idle PostgreSQL connection failed'));
  }
  async onModuleInit() {
    const client = await this.pool.connect();
    try {
      await assertRuntimePrivileges(client, 'api');
      await assertProductionLedger(client);
    } finally { client.release(); }
  }
  async onModuleDestroy() { await this.pool.end(); }
  async read<T extends QueryResultRow>(sql: string, params: unknown[] = [], client?: PoolClient): Promise<T[]> {
    return (await (client ?? this.pool).query<T>(sql, params)).rows;
  }

  // Sandbox credential calls are authorized inside SQL. They do not bind a browser session.
  async credentialTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      if (process.env.NODE_ENV !== 'production' && process.env.MONETARY_SIMULATOR_HMAC_KEY) {
        await client.query(`SELECT set_config('freehold.bank_simulator_key',$1,true)`, [process.env.MONETARY_SIMULATOR_HMAC_KEY]);
      }
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally { client.release(discard); }
  }

  async transaction<T>(principal: Principal, work: (client: PoolClient) => Promise<T>, admin = false,
    financialOperation?: FinancialOperationContext): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    let commitStarted = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      if (!/^[0-9a-f]{64}$/.test(principal.session.dbSecret)) throw new UnauthorizedException();
      await client.query(`SELECT set_config('freehold.session_secret',$1,true)`, [principal.session.dbSecret]);
      if (process.env.NODE_ENV !== 'production' && process.env.MONETARY_SIMULATOR_HMAC_KEY) {
        await client.query(`SELECT set_config('freehold.bank_simulator_key',$1,true)`, [process.env.MONETARY_SIMULATOR_HMAC_KEY]);
      }
      const [user] = await this.read<AuthUser>('SELECT * FROM freehold.auth_lock_user($1::uuid)', [principal.user.id], client);
      if (!user || user.status !== 'ACTIVE' || user.auth_version !== principal.session.authVersion ||
          (user.two_factor_enabled && principal.session.twoFactorAt === null)) throw new UnauthorizedException();
      if (admin && (user.role !== 'ADMIN' || !user.two_factor_enabled || principal.session.twoFactorAt === null ||
          Date.now() - principal.session.twoFactorAt > this.config.recentTwoFactorMs)) {
        throw new ForbiddenException('Recent admin 2FA required');
      }
      const value = await work(client);
      // Deferred ledger checks run here. A REJECTED result is committed too.
      commitStarted = true;
      await client.query('COMMIT');
      commitStarted = false;
      if (financialOperation) {
        const result = value as { status?: number | string; body?: { operationId?: string; correlationId?: string; state?: string; error?: string }; result?: {operationId?:string;correlationId?:string} };
        const outcome=result.body?.state ?? (typeof result.status==='string'?result.status:'COMPLETED');
        const operationId=result.body?.operationId ?? result.result?.operationId;
        const correlationId=result.body?.correlationId ?? result.result?.correlationId;
        writeJsonLog({ level: ['REJECTED','FAILED'].includes(outcome) ? 'warn' : 'info', service: 'api', event: 'financial_operation',
          correlation_id: correlationId ?? financialOperation.correlationId, actor_id: principal.user.id,
          operation_type: financialOperation.operationType, outcome,
          ...(operationId ? { operation_id: operationId } : {}),
          ...(typeof result.status==='number' ? { http_status: result.status } : {}), ...(result.body?.error ? { error_code: result.body.error } : {}) });
      }
      return value;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      const authorizationCode = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined;
      if (admin && authorizationCode === '42501') {
        try {
          const message = error && typeof error === 'object' && 'message' in error ? String((error as {message: unknown}).message) : '';
          const failure = message === 'GOVERNANCE_SELF_APPROVAL' ? 'SELF_APPROVAL' : message === 'GOVERNANCE_AUTHORIZATION_REVOKED' ? 'AUTHORIZATION_REVOKED' : 'CAPABILITY_REQUIRED';
          await this.writeBoundAudit(client, principal, "SELECT freehold.governance_record_authorization_failure($1::uuid,'ADMIN_ROUTE',NULL,$2::text)", [principal.user.id, failure]);
        } catch { try { await client.query('ROLLBACK'); } catch { discard = true; } }
      }
      if (financialOperation?.operationType === 'GOVERNANCE_EXECUTION' && financialOperation.governanceRequestId && !commitStarted) {
        try {
          const message = error && typeof error === 'object' && 'message' in error ? String((error as {message: unknown}).message) : '';
          const failure = message === 'GOVERNANCE_AUTHORIZATION_REVOKED' ? 'AUTHORIZATION_REVOKED' :
            message === 'GOVERNANCE_NOT_APPROVED' ? 'NOT_APPROVED' : message === 'GOVERNANCE_REQUEST_EXPIRED' ? 'EXPIRED' : 'DATABASE_FAILURE';
          await this.writeBoundAudit(client, principal, 'SELECT freehold.governance_record_execution_failure($1::uuid,$2::uuid,$3::text)',
            [principal.user.id, financialOperation.governanceRequestId, failure]);
        } catch { try { await client.query('ROLLBACK'); } catch { discard = true; } }
      }
      const conflictMessage = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '';
      if (financialOperation?.idempotencyKeyHash && conflictMessage === 'IDEMPOTENCY_CONFLICT') {
        try {
          await client.query('BEGIN');
          await client.query(`SELECT set_config('freehold.session_secret',$1,true)`, [principal.session.dbSecret]);
          await client.query('SELECT freehold.risk_note_conflict($1::uuid,$2::text,$3::bytea)',
            [principal.user.id, financialOperation.operationType, financialOperation.idempotencyKeyHash]);
          await client.query('COMMIT');
        } catch { try { await client.query('ROLLBACK'); } catch { discard = true; } }
      }
      if (financialOperation) {
        const pgCode = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined;
        const uncertainCommit = commitStarted && (!pgCode || pgCode.startsWith('08') ||
          ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'].includes(pgCode));
        writeJsonLog({ level: 'error', service: 'api', event: 'financial_operation',
          correlation_id: financialOperation.correlationId, actor_id: principal.user.id,
          operation_type: financialOperation.operationType, outcome: uncertainCommit ? 'UNKNOWN' : 'ERROR',
          ...(pgCode ? { error_code: pgCode } : {}) });
      }
      // No automatic retry: a connection failure during COMMIT has unknown
      // outcome. Clients must retry the identical request and idempotency key.
      throw error;
    } finally { client.release(discard); }
  }

  // The original transaction has already ended, which clears the session GUC.
  private async writeBoundAudit(client: PoolClient, principal: Principal, sql: string, params: unknown[]): Promise<void> {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('freehold.session_secret',$1,true)`, [principal.session.dbSecret]);
      await client.query(sql, params);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* the caller keeps the original failure */ }
      throw error;
    }
  }
}
