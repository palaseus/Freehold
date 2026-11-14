import { Module } from '@nestjs/common';
import { ReconciliationWorker } from './reconciliation.worker';
import { WorkerDatabaseService } from './worker-database.service';
@Module({ providers: [WorkerDatabaseService, ReconciliationWorker] })
export class WorkerModule {}
