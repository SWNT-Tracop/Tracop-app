import { Module } from '@nestjs/common';
import type pino from 'pino';
import type { AppEnvironment } from '../shared/infra/env.js';
import { PostgresOutboxDispatcher } from '../shared/infra/outbox-dispatcher.js';
import { PgBossJobScheduler } from '../shared/infra/pg-boss-job-scheduler.js';
import { APP_ENVIRONMENT, APP_LOGGER } from '../shared/infra/tokens.js';
import { JOB_SCHEDULER } from '../shared/ports/job-scheduler.js';
import {
  OUTBOX_DISPATCHER,
  OUTBOX_DISPATCHER_SETTINGS,
  type OutboxDispatcherSettings,
} from '../shared/ports/outbox-dispatcher.js';
import { NOTIFICATIONS_OUTBOX_SUBSCRIBER } from '../modules/notifications/index.js';
import { PAYMENTS_OUTBOX_SUBSCRIBER } from '../modules/payments/index.js';
import { TRUST_OUTBOX_SUBSCRIBER } from '../modules/trust/index.js';
import { RECOMMENDATIONS_OUTBOX_SUBSCRIBERS } from '../modules/recommendations/index.js';
import {
  OUTBOX_SUBSCRIBERS,
  type OutboxSubscriberPort,
} from '../shared/ports/outbox-subscriber.js';
import { APPLICATION_MODULES } from './app.module.js';
import { WorkerLifecycle } from './worker-lifecycle.js';

@Module({
  imports: APPLICATION_MODULES,
  providers: [
    {
      provide: OUTBOX_DISPATCHER_SETTINGS,
      inject: [APP_ENVIRONMENT],
      useFactory: (environment: AppEnvironment): OutboxDispatcherSettings => ({
        leaseSeconds: environment.OUTBOX_LEASE_SECONDS,
        maxAttempts: environment.OUTBOX_MAX_ATTEMPTS,
        retryBaseSeconds: environment.OUTBOX_RETRY_BASE_SECONDS,
        retryMaxSeconds: environment.OUTBOX_RETRY_MAX_SECONDS,
      }),
    },
    {
      provide: OUTBOX_SUBSCRIBERS,
      inject: [
        PAYMENTS_OUTBOX_SUBSCRIBER,
        NOTIFICATIONS_OUTBOX_SUBSCRIBER,
        TRUST_OUTBOX_SUBSCRIBER,
        RECOMMENDATIONS_OUTBOX_SUBSCRIBERS,
      ],
      useFactory: (
        payments: OutboxSubscriberPort,
        notifications: OutboxSubscriberPort,
        trust: OutboxSubscriberPort,
        recommendations: readonly OutboxSubscriberPort[],
      ): readonly OutboxSubscriberPort[] => [payments, notifications, trust, ...recommendations],
    },
    PostgresOutboxDispatcher,
    { provide: OUTBOX_DISPATCHER, useExisting: PostgresOutboxDispatcher },
    {
      provide: JOB_SCHEDULER,
      inject: [APP_ENVIRONMENT, APP_LOGGER],
      useFactory: (environment: AppEnvironment, logger: pino.Logger) =>
        new PgBossJobScheduler(environment.DATABASE_URL, logger),
    },
    WorkerLifecycle,
  ],
})
export class WorkerModule {}
