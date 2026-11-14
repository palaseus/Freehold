import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { writeJsonLog } from '../common/structured-log';
import { assertProductionLedger, assertProductionProcess } from '../config/production-posture';
import { assertRuntimePrivileges } from '../database/runtime-privileges';

@Injectable()
export class SchedulerDatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;
  constructor() {
    assertProductionProcess('scheduler');
    const connectionString = process.env.SCHEDULER_DATABASE_URL;
    if (!connectionString) throw new Error('Missing SCHEDULER_DATABASE_URL for scheduler');
    if (process.env.DATABASE_URL || process.env.AUTH_DATABASE_URL) throw new Error('Scheduler must not hold API or auth database credentials');
    this.pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
      keepAlive: true, keepAliveInitialDelayMillis: 2000,
      options: '-c statement_timeout=15000 -c idle_in_transaction_session_timeout=15000 -c client_connection_check_interval=2000 -c lock_timeout=15000' });
    this.pool.on('error', () => writeJsonLog({ level: 'error', service: 'scheduler', event: 'database_idle_connection_error' }));
  }
  async onModuleInit(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await assertRuntimePrivileges(client, 'scheduler');
      await assertProductionLedger(client);
    } finally { client.release(); }
  }
  onModuleDestroy(): Promise<void> { return this.pool.end(); }
  query<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> { return this.pool.query<T>(sql, params); }
}
