import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { writeJsonLog } from '../common/structured-log';
import { assertProductionLedger, assertProductionProcess } from '../config/production-posture';
import { assertRuntimePrivileges } from '../database/runtime-privileges';

@Injectable()
export class WorkerDatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;
  constructor() {
    assertProductionProcess('worker');
    const connectionString = process.env.WORKER_DATABASE_URL;
    if (!connectionString) throw new Error('Missing WORKER_DATABASE_URL for worker');
    this.pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
      keepAlive: true, keepAliveInitialDelayMillis: 2000,
      options: '-c statement_timeout=15000 -c idle_in_transaction_session_timeout=15000 -c client_connection_check_interval=2000' });
    this.pool.on('error', () => writeJsonLog({ level: 'error', service: 'worker', event: 'database_idle_connection_error' }));
  }
  async onModuleInit(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await assertRuntimePrivileges(client, 'worker');
      await assertProductionLedger(client);
    } finally { client.release(); }
  }
  onModuleDestroy(): Promise<void> { return this.pool.end(); }
  query<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> { return this.pool.query<T>(sql, params); }
  async repeatableRead<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}
