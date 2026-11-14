import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { writeJsonLog } from '../common/structured-log';
import { WorkerDatabaseService } from './worker-database.service';

interface OutboxEvent {
  event_id: string;
  operation_id: string;
  aggregate_id: string;
  event_type: string;
  payload_version: number;
  payload: Record<string, unknown>;
  created_at: Date;
  actor_id: string;
  attempt_count: number;
}
interface ReconciliationReport {
  reconciliationId: string;
  balanced: boolean;
  debitsEqualCredits: boolean;
  totalsByCurrency: Array<{ currency: string; debits: string; credits: string }>;
  projectionMismatchCount: number;
  activeHoldMismatchCount: number;
  highSeverityAuditWritten: boolean;
  checkedAt?: string;
}

@Injectable()
export class ReconciliationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly workerId = randomUUID();
  private readonly pollMs = this.interval('WORKER_POLL_MS', 1000, 250, 30000);
  private readonly reconcileMs = this.interval('WORKER_RECONCILE_MS', 30000, 5000, 3600000);
  private readonly leaseSeconds = this.interval('WORKER_LEASE_SECONDS', 30, 5, 300);
  // Drill brake only. Unset or 0 in ordinary operation. A non-zero hold keeps a
  // claimed batch leased so a killed process can be shown to redeliver it.
  private readonly holdLeaseMs = this.interval('WORKER_HOLD_LEASE_MS', 0, 0, 10000);
  private timer?: NodeJS.Timeout;
  private cyclePromise?: Promise<void>;
  private stopping = false;
  private nextReconciliation = 0;

  constructor(private readonly db: WorkerDatabaseService) {}

  onModuleInit(): void {
    if (this.holdLeaseMs > 0) {
      writeJsonLog({ level: 'warn', service: 'worker', event: 'worker_lease_hold_enabled', outcome: 'DRILL', delay_ms: this.holdLeaseMs });
    }
    this.scheduleCycle();
    this.timer = setInterval(() => this.scheduleCycle(), this.pollMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.cyclePromise;
  }

  private interval(name: string, fallback: number, min: number, max: number): number {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  }

  private scheduleCycle(): void {
    if (this.stopping || this.cyclePromise) return;
    this.cyclePromise = this.runCycle().catch(error => {
      const pgCode = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined;
      const errorName = error instanceof Error ? error.name : 'UNKNOWN';
      writeJsonLog({ level: 'error', service: 'worker', event: 'worker_cycle_failed', outcome: 'ERROR', error_name: errorName, ...(pgCode ? { error_code: pgCode } : {}) });
    }).finally(() => { this.cyclePromise = undefined; });
  }

  private async runCycle(): Promise<void> {
    await this.consumePendingBatch();
    await this.drainInstitutionOutbox();
    await this.drainNetworkOutbox();
    await this.runDueWorkflows();
    if (Date.now() >= this.nextReconciliation) {
      this.nextReconciliation = Date.now() + this.reconcileMs;
      await this.runReconciliation();
    }
    await this.db.query('SELECT freehold.worker_record_heartbeat($1::uuid,$2::text)', [this.workerId, null]);
  }

  private async drainInstitutionOutbox(): Promise<void> {
    await this.drainOutbox('institution_outbox_claim', 'institution_outbox_complete');
  }

  private async drainNetworkOutbox(): Promise<void> {
    await this.drainOutbox('network_outbox_claim', 'network_outbox_complete');
  }

  private async runDueWorkflows(): Promise<void> {
    const { rows } = await this.db.query<{ item: { ran?: number; failed?: number; workerPosts?: boolean; databaseFunctionMayPost?: boolean } }>(
      'SELECT freehold.program_workflow_run_due($1::uuid,$2::integer) AS item',
      [this.workerId, 20],
    );
    const item = rows[0]?.item;
    if (!item || item.workerPosts !== false || item.databaseFunctionMayPost !== true) {
      throw new Error('PROGRAM_WORKER_CONTRACT');
    }
  }

  private async drainOutbox(claim: string, complete: string): Promise<void> {
    const { rows } = await this.db.query<{ item: { ids?: string[]; postsPayments?: boolean } }>(
      `SELECT freehold.${claim}($1::uuid,$2::integer) AS item`,
      [this.workerId, this.leaseSeconds],
    );
    const item = rows[0]?.item;
    if (!item || item.postsPayments !== false || !Array.isArray(item.ids)) return;
    for (const id of item.ids) {
      await this.db.query(`SELECT freehold.${complete}($1::uuid,$2::uuid) AS item`, [this.workerId, id]);
    }
  }

  async consumePendingBatch(): Promise<number> {
    const claimStarted = Date.now();
    const { rows } = await this.db.query<OutboxEvent>(
      'SELECT * FROM freehold.worker_claim_outbox($1::uuid,$2::integer,$3::integer)', [this.workerId, 50, this.leaseSeconds]);
    if (rows.length > 0) {
      writeJsonLog({ level: 'info', service: 'worker', event: 'outbox_batch_claimed',
        worker_id: this.workerId, claim_ms: Date.now() - claimStarted, row_count: rows.length,
        max_attempt: rows.reduce((max, event) => Math.max(max, event.attempt_count), 0) });
    }
    if (rows.length > 0 && this.holdLeaseMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.holdLeaseMs));
    }
    let completed = 0;
    const ready: OutboxEvent[] = [];
    for (const event of rows) {
      const correlationId = typeof event.payload.correlationId === 'string' ? event.payload.correlationId : event.event_id;
      const operationType = event.event_type.split('.')[0] ?? 'UNKNOWN';
      const outcome = typeof event.payload.state === 'string' ? event.payload.state : 'UNKNOWN';
      writeJsonLog({ level: outcome === 'REJECTED' ? 'warn' : 'info', service: 'worker', event: 'outbox_event_received',
        event_id: event.event_id, operation_id: event.operation_id, correlation_id: correlationId,
        actor_id: event.actor_id, operation_type: operationType, outcome, attempt_count: event.attempt_count });
      if (event.payload.poison === true) {
        await this.defer(event, 'POISON', correlationId, operationType);
        continue;
      }
      ready.push(event);
    }
    if (ready.length === 0) return completed;
    try {
      const ackStarted = Date.now();
      const result = await this.db.query<{ completed: string[] }>(
        'SELECT freehold.worker_complete_outbox_batch($1::uuid,$2::uuid[]) AS completed',
        [this.workerId, ready.map(event => event.event_id)]);
      const done = new Set(result.rows[0]?.completed ?? []);
      let notOwned = 0;
      for (const event of ready) {
        const correlationId = typeof event.payload.correlationId === 'string' ? event.payload.correlationId : event.event_id;
        const operationType = event.event_type.split('.')[0] ?? 'UNKNOWN';
        if (!done.has(event.event_id)) {
          notOwned++;
          writeJsonLog({ level: 'warn', service: 'worker', event: 'outbox_ack_not_owned', event_id: event.event_id,
            operation_id: event.operation_id, correlation_id: correlationId, actor_id: event.actor_id,
            operation_type: operationType, outcome: 'RETRY' });
          continue;
        }
        completed++;
        writeJsonLog({ level: 'info', service: 'worker', event: 'outbox_event_acknowledged',
          event_id: event.event_id, operation_id: event.operation_id, correlation_id: correlationId,
          actor_id: event.actor_id, operation_type: operationType, outcome: 'PROCESSED' });
      }
      writeJsonLog({ level: notOwned > 0 ? 'warn' : 'info', service: 'worker', event: 'outbox_batch_acknowledged',
        worker_id: this.workerId, ack_ms: Date.now() - ackStarted, completed, not_owned: notOwned });
    } catch {
      for (const event of ready) {
        const correlationId = typeof event.payload.correlationId === 'string' ? event.payload.correlationId : event.event_id;
        const operationType = event.event_type.split('.')[0] ?? 'UNKNOWN';
        await this.defer(event, 'PROCESSING_ERROR', correlationId, operationType);
      }
    }
    return completed;
  }

  private async defer(event: OutboxEvent, reason: string, correlationId: string, operationType: string): Promise<void> {
    const deferred = await this.db.query<{ result: { deferred?: boolean; quarantined?: boolean; delaySeconds?: number } }>(
      'SELECT freehold.worker_defer_outbox($1::uuid,$2::uuid,$3::text) AS result', [this.workerId, event.event_id, reason]);
    const result = deferred.rows[0]?.result;
    writeJsonLog({ level: result?.quarantined ? 'error' : 'warn', service: 'worker',
      event: result?.quarantined ? 'outbox_event_quarantined' : 'outbox_event_deferred',
      event_id: event.event_id, operation_id: event.operation_id, correlation_id: correlationId,
      actor_id: event.actor_id, operation_type: operationType, outcome: result?.quarantined ? 'QUARANTINED' : 'RETRY',
      attempt_count: event.attempt_count, ...(result?.delaySeconds ? { delay_seconds: result.delaySeconds } : {}) });
  }

  async runReconciliation(): Promise<ReconciliationReport> {
    const report = await this.db.repeatableRead(async client => {
      const { rows } = await client.query<{ report: ReconciliationReport }>('SELECT freehold.worker_reconcile_and_record() AS report');
      return rows[0]?.report;
    });
    if (!report) throw new Error('Reconciliation returned no report');
    let backlogCount: number | null = null;
    let oldestAgeSeconds: number | null = null;
    try {
      const status = await this.db.query<{ status: { count?: number; oldestAgeSeconds?: number | null } }>('SELECT freehold.worker_backlog_status() AS status');
      const measured = status.rows[0]?.status;
      if (measured && typeof measured.count === 'number') {
        backlogCount = measured.count;
        oldestAgeSeconds = measured.count === 0 ? null : (typeof measured.oldestAgeSeconds === 'number' ? measured.oldestAgeSeconds : null);
      }
    } catch { /* the reconciliation result stays authoritative if the backlog read fails */ }
    writeJsonLog({ level: report.balanced ? 'info' : 'error', service: 'worker', event: 'ledger_reconciliation',
      correlation_id: report.reconciliationId, actor_id: 'SYSTEM:reconciliation-worker',
      operation_type: 'LEDGER_RECONCILIATION', outcome: report.balanced ? 'BALANCED' : 'MISMATCH',
      debits_equal_credits: report.debitsEqualCredits, totals_by_currency: report.totalsByCurrency,
      projection_mismatch_count: report.projectionMismatchCount,
      active_hold_mismatch_count: report.activeHoldMismatchCount,
      high_severity_audit_written: report.highSeverityAuditWritten,
      outbox_backlog_count: backlogCount, outbox_oldest_age_seconds: oldestAgeSeconds });
    const alertAge = Number(process.env.WORKER_ALERT_AGE_SECONDS ?? 300);
    if (backlogCount && backlogCount > 0 && oldestAgeSeconds !== null && oldestAgeSeconds >= alertAge) {
      writeJsonLog({ level: 'error', service: 'worker', event: 'outbox_backlog_age_alert', outcome: 'ALERT',
        outbox_backlog_count: backlogCount, outbox_oldest_age_seconds: oldestAgeSeconds });
    }
    return report;
  }
}
