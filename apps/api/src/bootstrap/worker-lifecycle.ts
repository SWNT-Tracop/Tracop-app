import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type pino from 'pino';
import {
  ASSISTANT_INBOX_PROCESSOR,
  ASSISTANT_MAINTENANCE,
  INBOX_NOTIFY_CHANNEL,
  type AssistantMaintenance,
  type InboxProcessor,
} from '../modules/ai-assistant/index.js';
import { PostgresNotificationListener } from '../shared/infra/postgres-notification-listener.js';
import { CATALOG_MAINTENANCE, type CatalogMaintenanceApi } from '../modules/catalog/index.js';
import { IDENTITY_MAINTENANCE, type IdentityMaintenanceApi } from '../modules/identity/index.js';
import { MESSAGING_MAINTENANCE, type MessagingMaintenanceApi } from '../modules/messaging/index.js';
import {
  NOTIFICATIONS_MAINTENANCE,
  type NotificationsMaintenanceApi,
} from '../modules/notifications/index.js';
import { ORDERING_MAINTENANCE, type OrderingMaintenanceApi } from '../modules/ordering/index.js';
import { PAYMENTS_MAINTENANCE, type PaymentsMaintenanceApi } from '../modules/payments/index.js';
import type { AppEnvironment } from '../shared/infra/env.js';
import { APP_ENVIRONMENT, APP_LOGGER } from '../shared/infra/tokens.js';
import { hostname } from 'node:os';
import { JOB_SCHEDULER, type JobSchedulerPort } from '../shared/ports/job-scheduler.js';
import { OPERATIONS_PROBE, type OperationsProbe } from '../shared/ports/operations.js';
import { APP_CLOCK } from '../shared/infra/tokens.js';
import type { Clock } from '../shared/kernel/clock.js';
import { OUTBOX_DISPATCHER, type OutboxDispatcher } from '../shared/ports/outbox-dispatcher.js';
import { workerJobs } from './worker-jobs.js';

/** Starts the scheduler and registers every job on boot; stops it on shutdown. */
@Injectable()
export class WorkerLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(JOB_SCHEDULER) private readonly scheduler: JobSchedulerPort,
    @Inject(APP_ENVIRONMENT) private readonly environment: AppEnvironment,
    @Inject(APP_LOGGER) private readonly logger: pino.Logger,
    @Inject(CATALOG_MAINTENANCE) private readonly catalog: CatalogMaintenanceApi,
    @Inject(ORDERING_MAINTENANCE) private readonly ordering: OrderingMaintenanceApi,
    @Inject(IDENTITY_MAINTENANCE) private readonly identity: IdentityMaintenanceApi,
    @Inject(MESSAGING_MAINTENANCE) private readonly messaging: MessagingMaintenanceApi,
    @Inject(PAYMENTS_MAINTENANCE) private readonly payments: PaymentsMaintenanceApi,
    @Inject(NOTIFICATIONS_MAINTENANCE) private readonly notifications: NotificationsMaintenanceApi,
    @Inject(OUTBOX_DISPATCHER) private readonly outbox: OutboxDispatcher,
    @Inject(ASSISTANT_INBOX_PROCESSOR) private readonly assistantInbox: InboxProcessor,
    @Inject(ASSISTANT_MAINTENANCE) private readonly assistantMaintenance: AssistantMaintenance,
    @Inject(OPERATIONS_PROBE) private readonly operations: OperationsProbe,
    @Inject(APP_CLOCK) private readonly clock: Clock,
  ) {}

  /** Stable per process: host and pid, no personal data. */
  private readonly workerId = `${hostname()}:${process.pid}`;

  private listener: PostgresNotificationListener | null = null;

  async onApplicationBootstrap(): Promise<void> {
    await this.scheduler.start();
    const jobs = workerJobs(
      {
        catalog: this.catalog,
        ordering: this.ordering,
        identity: this.identity,
        messaging: this.messaging,
        payments: this.payments,
        notifications: this.notifications,
        outbox: this.outbox,
        assistantInbox: this.assistantInbox,
        assistantMaintenance: this.assistantMaintenance,
        heartbeat: () => this.operations.beat(this.workerId, this.clock.now()),
      },
      this.environment,
    );
    for (const job of jobs) await this.scheduler.schedule(job);
    // A first beat right away, so /ready does not wait for the first minute.
    await this.operations.beat(this.workerId, this.clock.now()).catch(() => undefined);
    if (this.environment.DATABASE_URL)
      this.listener = new PostgresNotificationListener(
        this.environment.DATABASE_URL,
        INBOX_NOTIFY_CHANNEL,
        () => this.assistantInbox.drain(),
        this.logger,
      );
    await this.listener?.start();
    this.logger.info(
      { event: 'worker_started', jobs: this.scheduler.registered() },
      'Worker started.',
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.listener?.stop();
    await this.scheduler.stop();
    this.logger.info({ event: 'worker_stopped' }, 'Worker stopped.');
  }
}
