import { randomUUID } from 'node:crypto';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { writeJsonLog } from '../common/structured-log';
import { SchedulerDatabaseService } from './scheduler-database.service';

@Injectable()
export class ScheduleRunner implements OnModuleInit, OnModuleDestroy {
  private readonly pollMs = this.interval('SCHEDULER_POLL_MS', 5000, 1000, 300000);
  private readonly schedulerId = randomUUID();
  private timer?: NodeJS.Timeout;
  private beat?: NodeJS.Timeout;
  private cycle?: Promise<void>;
  private beating = false;
  private stopping = false;
  constructor(private readonly db: SchedulerDatabaseService) {}
  onModuleInit(): void {
    void this.heartbeat();
    this.beat = setInterval(() => { void this.heartbeat(); }, 15000);
    this.schedule();
    this.timer = setInterval(() => this.schedule(), this.pollMs);
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.beat) clearInterval(this.beat);
    await this.cycle;
  }
  private async heartbeat(): Promise<void> {
    if (this.stopping || this.beating) return;
    this.beating = true;
    try {
      await this.db.query('SELECT freehold.scheduler_record_heartbeat($1::uuid)', [this.schedulerId]);
    } catch (error) {
      const pgCode = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined;
      writeJsonLog({ level: 'error', service: 'scheduler', event: 'scheduler_heartbeat_failed', outcome: 'ERROR', ...(pgCode ? { error_code: pgCode } : {}) });
    } finally {
      this.beating = false;
    }
  }
  private interval(name: string, fallback: number, min: number, max: number): number {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  }
  private schedule(): void {
    if (this.stopping || this.cycle) return;
    this.cycle = this.run().catch(error => {
      const pgCode = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined;
      writeJsonLog({ level: 'error', service: 'scheduler', event: 'scheduler_cycle_failed', outcome: 'ERROR', ...(pgCode ? { error_code: pgCode } : {}) });
    }).finally(() => { this.cycle = undefined; });
  }
  private async run(): Promise<void> {
    const { rows } = await this.db.query<{ result: { processed?: number; results?: Array<{ instructionId?: string; outcome?: string; error?: string | null }> } }>(
      'SELECT freehold.scheduler_run_due($1::integer) AS result', [25]);
    const result = rows[0]?.result;
    for (const item of result?.results ?? []) {
      writeJsonLog({ level: item.outcome === 'COMPLETED' ? 'info' : 'warn', service: 'scheduler', event: 'scheduled_transfer_executed',
        outcome: item.outcome ?? 'UNKNOWN', ...(item.error ? { error_code: item.error } : {}),
        ...(item.instructionId ? { operation_id: item.instructionId } : {}) });
    }
  }
}
