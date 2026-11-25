import { PgBoss } from 'pg-boss';
import type pino from 'pino';
import type { JobSchedulerPort, ScheduledJob } from '../ports/job-scheduler.js';

const RETRY_DELAY_SECONDS = 30;
const STOP_TIMEOUT_MS = 30_000;

/**
 * pg-boss keeps its tables in its own schema (`pgboss`), created and migrated by pg-boss on
 * start; the hand-written migrations never touch it. Each job gets a 'singleton' queue, so at
 * most one run of a job is active at a time even with several worker processes.
 */
export class PgBossJobScheduler implements JobSchedulerPort {
  private readonly boss: PgBoss;
  private readonly names = new Set<string>();
  private started = false;

  constructor(
    connectionString: string,
    private readonly logger: pino.Logger,
  ) {
    this.boss = new PgBoss({
      connectionString,
      schema: 'pgboss',
      application_name: 'tracop-worker',
    });
    this.boss.on('error', (error: unknown) =>
      this.logger.error(
        { event: 'job_scheduler_error', errorName: error instanceof Error ? error.name : 'Error' },
        'Job scheduler error.',
      ),
    );
  }

  async start(): Promise<void> {
    await this.boss.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
  }

  async schedule(job: ScheduledJob): Promise<void> {
    await this.boss.createQueue(job.name, {
      policy: 'singleton',
      retryLimit: job.retryLimit,
      retryDelay: RETRY_DELAY_SECONDS,
      retryBackoff: true,
      expireInSeconds: job.timeoutSeconds,
    });
    await this.boss.work(job.name, { localConcurrency: 1 }, async () => {
      const startedAt = Date.now();
      try {
        const result = await job.run();
        this.logger.info(
          { event: 'job_completed', job: job.name, durationMs: Date.now() - startedAt, result },
          'Job completed.',
        );
      } catch (error) {
        this.logger.error(
          {
            event: 'job_failed',
            job: job.name,
            durationMs: Date.now() - startedAt,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          },
          'Job failed.',
        );
        throw error;
      }
    });
    await this.boss.schedule(job.name, job.cron, null, { tz: 'UTC' });
    this.names.add(job.name);
  }

  registered(): readonly string[] {
    return [...this.names].sort((left, right) => left.localeCompare(right));
  }
}
