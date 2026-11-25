import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

// Only the API process receives Telegram updates; the worker must never start polling.
process.env.TELEGRAM_MODE = 'webhook';

const { WorkerModule } = await import('./bootstrap/worker.module.js');
const { JOB_SCHEDULER } = await import('./shared/ports/job-scheduler.js');
type Scheduler = import('./shared/ports/job-scheduler.js').JobSchedulerPort;

const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn'] });
const jobs = app.get<Scheduler>(JOB_SCHEDULER).registered();
process.stdout.write(`Worker ready. Registered jobs: ${jobs.join(', ')}\n`);

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  try {
    // Runs onApplicationShutdown: pg-boss stops gracefully, then connections are released.
    await app.close();
    process.stdout.write('Worker stopped.\n');
    process.exit(0);
  } catch (error) {
    process.stderr.write(
      `Worker shutdown failed: ${error instanceof Error ? error.name : 'Error'}\n`,
    );
    process.exit(1);
  }
};
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
