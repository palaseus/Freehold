import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { writeJsonLog } from './common/structured-log';
import { SchedulerModule } from './scheduler/scheduler.module';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(SchedulerModule, { logger: ['error', 'warn'], abortOnError: false });
  app.enableShutdownHooks(['SIGTERM', 'SIGINT'], { useProcessExit: true });
  const forceExit = () => {
    const timer = setTimeout(() => process.exit(0), 20000);
    timer.unref();
  };
  process.on('SIGTERM', forceExit);
  process.on('SIGINT', forceExit);
  writeJsonLog({ level: 'info', service: 'scheduler', event: 'scheduler_started', outcome: 'STARTED' });
}

main().catch(error => {
  const pgCode = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined;
  writeJsonLog({ level: 'error', service: 'scheduler', event: 'scheduler_start_failed', outcome: 'ERROR', ...(pgCode ? { error_code: pgCode } : {}) });
  process.exitCode = 1;
});
