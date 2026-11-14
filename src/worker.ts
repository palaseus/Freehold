import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { writeJsonLog } from './common/structured-log';
import { WorkerModule } from './worker/worker.module';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn'], abortOnError: false });
  // Nest's default hook re-sends the signal after cleanup. That second signal is
  // dropped while the handler is still on the stack, so the process stays up.
  app.enableShutdownHooks(['SIGTERM', 'SIGINT'], { useProcessExit: true });
  const forceExit = () => {
    const timer = setTimeout(() => process.exit(0), 20000);
    timer.unref();
  };
  process.on('SIGTERM', forceExit);
  process.on('SIGINT', forceExit);
  writeJsonLog({ level: 'info', service: 'worker', event: 'worker_started', outcome: 'STARTED' });
}

main().catch(error => {
  const pgCode = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined;
  writeJsonLog({ level: 'error', service: 'worker', event: 'worker_start_failed', outcome: 'ERROR', ...(pgCode ? { error_code: pgCode } : {}) });
  process.exitCode = 1;
});
