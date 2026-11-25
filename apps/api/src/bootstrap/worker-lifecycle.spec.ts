import pino from 'pino';
import type { AppEnvironment } from '../shared/infra/env.js';
import type { JobSchedulerPort, ScheduledJob } from '../shared/ports/job-scheduler.js';
import { WorkerLifecycle } from './worker-lifecycle.js';

class FakeScheduler implements JobSchedulerPort {
  readonly events: string[] = [];
  readonly jobs: ScheduledJob[] = [];
  failStart = false;
  async start(): Promise<void> {
    this.events.push('start');
    if (this.failStart) throw new Error('database unavailable');
  }
  async stop(): Promise<void> {
    this.events.push('stop');
  }
  async schedule(job: ScheduledJob): Promise<void> {
    this.events.push(`schedule:${job.name}`);
    this.jobs.push(job);
  }
  registered(): readonly string[] {
    return this.jobs.map((job) => job.name).sort((left, right) => left.localeCompare(right));
  }
}

const environment = {
  JOB_EXPIRE_LOTS_CRON: '*/5 * * * *',
  JOB_EXPIRE_ORDERS_CRON: '*/5 * * * *',
  JOB_PURGE_PHOTOS_CRON: '17 * * * *',
  JOB_RETENTION_CRON: '40 4 * * *',
  JOB_OUTBOX_DISPATCH_CRON: '* * * * *',
  JOB_ISSUE_SETTLEMENTS_CRON: '*/15 * * * *',
  JOB_SEND_NOTIFICATIONS_CRON: '* * * * *',
  JOB_AI_INBOX_CRON: '* * * * *',
  JOB_AI_MAINTENANCE_CRON: '*/10 * * * *',
  JOB_EXPIRE_UNVERIFIED_CRON: '23 * * * *',
  JOB_WORKER_HEARTBEAT_CRON: '* * * * *',
} as unknown as AppEnvironment;

const lifecycle = (scheduler: FakeScheduler) => {
  const zero = async () => 0;
  return new WorkerLifecycle(
    scheduler,
    environment,
    pino({ level: 'silent' }),
    { expireLots: zero, purgeOrphanPhotos: zero },
    { expireReservationsAndQuotes: async () => ({ reservations: 0, quotes: 0 }) },
    {
      purgeExpiredOtpCodes: zero,
      purgeEndedSessions: zero,
      purgeRateLimitWindows: zero,
      expireUnverifiedRegistrations: zero,
    },
    { purgeProcessedUpdates: zero },
    { issueDueSettlements: zero },
    { sendDueNotifications: async () => ({ sent: 0, retried: 0, failed: 0 }) },
    { dispatch: async () => ({ claimed: 0, published: 0, retried: 0, deadLettered: 0 }) },
    { drain: async () => ({ handled: 0, failed: 0, dropped: 0 }) } as never,
    { run: async () => ({ expired: 0, purgedDrafts: 0, purgedUsage: 0 }) } as never,
    {
      beat: async () => undefined,
      databaseReachable: async () => true,
      latestHeartbeat: async () => null,
    },
    { now: () => new Date('2026-11-25T15:00:00.000Z') },
  );
};

describe('WorkerLifecycle', () => {
  it('starts the scheduler before registering the fourteen jobs and stops it on shutdown', async () => {
    const scheduler = new FakeScheduler();
    const worker = lifecycle(scheduler);
    await worker.onApplicationBootstrap();
    expect(scheduler.events[0]).toBe('start');
    expect(scheduler.jobs).toHaveLength(14);
    expect(new Set(scheduler.jobs.map((job) => job.name)).size).toBe(14);
    await worker.onApplicationShutdown();
    expect(scheduler.events.at(-1)).toBe('stop');
  });

  it('registers nothing when the scheduler cannot start', async () => {
    const scheduler = new FakeScheduler();
    scheduler.failStart = true;
    await expect(lifecycle(scheduler).onApplicationBootstrap()).rejects.toThrow(
      'database unavailable',
    );
    expect(scheduler.jobs).toEqual([]);
  });
});
