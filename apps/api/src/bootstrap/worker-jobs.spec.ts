import { workerJobs, type WorkerJobDependencies } from './worker-jobs.js';

const schedule = {
  JOB_EXPIRE_LOTS_CRON: '*/5 * * * *',
  JOB_EXPIRE_ORDERS_CRON: '*/7 * * * *',
  JOB_PURGE_PHOTOS_CRON: '17 * * * *',
  JOB_RETENTION_CRON: '40 4 * * *',
  JOB_OUTBOX_DISPATCH_CRON: '* * * * *',
  JOB_ISSUE_SETTLEMENTS_CRON: '*/15 * * * *',
  JOB_SEND_NOTIFICATIONS_CRON: '* * * * *',
  JOB_AI_INBOX_CRON: '* * * * *',
  JOB_AI_MAINTENANCE_CRON: '*/10 * * * *',
  JOB_EXPIRE_UNVERIFIED_CRON: '23 * * * *',
  JOB_WORKER_HEARTBEAT_CRON: '* * * * *',
};

const dependencies = () => {
  const calls: string[] = [];
  const record =
    <T>(name: string, value: T) =>
    async () => {
      calls.push(name);
      return value;
    };
  const deps: WorkerJobDependencies = {
    catalog: {
      expireLots: record('catalog.expireLots', 1),
      purgeOrphanPhotos: record('catalog.purgeOrphanPhotos', 2),
    },
    ordering: {
      expireReservationsAndQuotes: record('ordering.expire', { reservations: 0, quotes: 0 }),
    },
    identity: {
      purgeExpiredOtpCodes: record('identity.otp', 3),
      purgeEndedSessions: record('identity.sessions', 4),
      purgeRateLimitWindows: record('identity.rate', 5),
      expireUnverifiedRegistrations: record('identity.unverified', 8),
    },
    messaging: { purgeProcessedUpdates: record('messaging.updates', 6) },
    payments: { issueDueSettlements: record('payments.settlements', 7) },
    notifications: {
      sendDueNotifications: record('notifications.send', { sent: 0, retried: 0, failed: 0 }),
    },
    outbox: {
      dispatch: record('outbox.dispatch', {
        claimed: 0,
        published: 0,
        retried: 0,
        deadLettered: 0,
      }),
    },
    assistantInbox: { drain: record('assistant.inbox', { handled: 0, failed: 0, dropped: 0 }) },
    assistantMaintenance: {
      run: record('assistant.maintenance', { expired: 0, purgedDrafts: 0, purgedUsage: 0 }),
    },
    heartbeat: record('shared.heartbeat', undefined),
  };
  return { deps, calls };
};

describe('workerJobs', () => {
  it('declares the fourteen periodic jobs with their schedules and limits', () => {
    const jobs = workerJobs(dependencies().deps, schedule);
    expect(
      jobs.map(({ name, cron, timeoutSeconds, retryLimit }) => [
        name,
        cron,
        timeoutSeconds,
        retryLimit,
      ]),
    ).toEqual([
      ['catalog.expire-lots', '*/5 * * * *', 240, 3],
      ['ordering.expire-reservations-and-quotes', '*/7 * * * *', 240, 3],
      ['catalog.purge-orphan-photos', '17 * * * *', 900, 3],
      ['identity.purge-otp-codes', '40 4 * * *', 240, 3],
      ['identity.purge-rate-limit-windows', '40 4 * * *', 240, 3],
      ['identity.purge-sessions', '40 4 * * *', 240, 3],
      ['identity.expire-unverified', '23 * * * *', 240, 3],
      ['messaging.purge-processed-updates', '40 4 * * *', 240, 3],
      ['payments.issue-settlements', '*/15 * * * *', 240, 3],
      ['notifications.send-due', '* * * * *', 50, 3],
      ['shared.dispatch-outbox', '* * * * *', 50, 3],
      ['ai-assistant.drain-inbox', '* * * * *', 50, 3],
      ['ai-assistant.maintenance', '*/10 * * * *', 240, 3],
      ['shared.worker-heartbeat', '* * * * *', 30, 3],
    ]);
    expect(jobs.map((job) => job.name)).not.toContain('sync.compact-change-log');
  });

  it('runs each job through its own public use case', async () => {
    const { deps, calls } = dependencies();
    const results = [];
    for (const job of workerJobs(deps, schedule)) results.push(await job.run());
    expect(calls).toEqual([
      'catalog.expireLots',
      'ordering.expire',
      'catalog.purgeOrphanPhotos',
      'identity.otp',
      'identity.rate',
      'identity.sessions',
      'identity.unverified',
      'messaging.updates',
      'payments.settlements',
      'notifications.send',
      'outbox.dispatch',
      'assistant.inbox',
      'assistant.maintenance',
      'shared.heartbeat',
    ]);
    expect(results.slice(0, 3)).toEqual([1, { reservations: 0, quotes: 0 }, 2]);
  });
});
