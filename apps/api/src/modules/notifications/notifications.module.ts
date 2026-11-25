import { Module } from '@nestjs/common';
import type { AppEnvironment } from '../../shared/infra/env.js';
import { APP_CLOCK, APP_ENVIRONMENT, UNIT_OF_WORK } from '../../shared/infra/tokens.js';
import type { UnitOfWork } from '../../shared/infra/unit-of-work.js';
import type { Clock } from '../../shared/kernel/clock.js';
import { createId } from '../../shared/kernel/ids.js';
import { NotificationsController } from './adapters/in/notifications.controller.js';
import { NotificationsSubscriber } from './adapters/in/notifications.subscriber.js';
import { DisabledNotificationChannel } from './adapters/out/disabled-channels.js';
import {
  DrizzleNotificationRepository,
  DrizzleNotificationsMetricsQuery,
} from './adapters/out/drizzle-notifications-repository.js';
import { NotificationsService } from './application/notifications-service.js';
import {
  NOTIFICATIONS_MAINTENANCE,
  NOTIFICATIONS_METRICS,
  NOTIFICATIONS_OUTBOX_SUBSCRIBER,
  NOTIFICATIONS_SERVICE,
  type NotificationsMaintenanceApi,
} from './application/notifications-tokens.js';
import {
  MESSAGING_NOTIFICATION_CHANNEL,
  NOTIFICATION_CHANGE_RECORDER,
  NOTIFICATIONS_SETTINGS,
  RECIPIENT_DIRECTORY_PORT,
  type NotificationChangeRecorder,
  type NotificationChannelPort,
  type NotificationsSettings,
  type RecipientDirectoryPort,
} from './ports/notifications-ports.js';

@Module({
  controllers: [NotificationsController],
  providers: [
    DrizzleNotificationRepository,
    DrizzleNotificationsMetricsQuery,
    { provide: NOTIFICATIONS_METRICS, useExisting: DrizzleNotificationsMetricsQuery },
    {
      provide: NOTIFICATIONS_SETTINGS,
      inject: [APP_ENVIRONMENT],
      useFactory: (env: AppEnvironment): NotificationsSettings => ({
        maxAttempts: env.NOTIFICATIONS_MAX_ATTEMPTS,
        retryBaseSeconds: env.NOTIFICATIONS_RETRY_BASE_SECONDS,
        retryMaxSeconds: env.NOTIFICATIONS_RETRY_MAX_SECONDS,
        leaseSeconds: env.NOTIFICATIONS_LEASE_SECONDS,
      }),
    },
    {
      provide: NOTIFICATIONS_SERVICE,
      inject: [
        DrizzleNotificationRepository,
        RECIPIENT_DIRECTORY_PORT,
        MESSAGING_NOTIFICATION_CHANNEL,
        NOTIFICATION_CHANGE_RECORDER,
        UNIT_OF_WORK,
        APP_CLOCK,
        NOTIFICATIONS_SETTINGS,
      ],
      useFactory: (
        repository: DrizzleNotificationRepository,
        directory: RecipientDirectoryPort,
        messaging: NotificationChannelPort,
        changes: NotificationChangeRecorder,
        uow: UnitOfWork,
        clock: Clock,
        settings: NotificationsSettings,
      ) =>
        new NotificationsService(
          repository,
          directory,
          [
            messaging,
            new DisabledNotificationChannel('push'),
            new DisabledNotificationChannel('sms'),
          ],
          changes,
          uow,
          clock,
          settings,
          createId,
        ),
    },
    {
      provide: NOTIFICATIONS_MAINTENANCE,
      inject: [NOTIFICATIONS_SERVICE],
      useFactory: (service: NotificationsService): NotificationsMaintenanceApi => ({
        sendDueNotifications: () => service.sendDue(),
      }),
    },
    {
      provide: NOTIFICATIONS_OUTBOX_SUBSCRIBER,
      inject: [NOTIFICATIONS_SERVICE],
      useFactory: (service: NotificationsService) => new NotificationsSubscriber(service),
    },
  ],
  exports: [
    NOTIFICATIONS_SERVICE,
    NOTIFICATIONS_MAINTENANCE,
    NOTIFICATIONS_OUTBOX_SUBSCRIBER,
    NOTIFICATIONS_METRICS,
  ],
})
export class NotificationsModule {}
