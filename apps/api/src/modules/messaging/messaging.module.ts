import { Module } from '@nestjs/common';
import { APP_CLOCK, APP_ENVIRONMENT, UNIT_OF_WORK } from '../../shared/infra/tokens.js';
import type { Clock } from '../../shared/kernel/clock.js';
import { MessagingMaintenanceService } from './application/messaging-maintenance-service.js';
import type { AppEnvironment } from '../../shared/infra/env.js';
import { MessagingApplicationService } from './application/messaging-application-service.js';
import { TelegramPollingRunner } from './adapters/in/telegram-polling.runner.js';
import { TelegramUpdateHandler } from './adapters/in/telegram-update.handler.js';
import { TelegramWebhookController } from './adapters/in/telegram-webhook.controller.js';
import { TelegramWebhookRateLimiter } from './adapters/in/telegram-rate-limiter.js';
import { DrizzleProcessedUpdatesRepository } from './adapters/out/drizzle-processed-updates.repository.js';
import { InMemoryMessagingAdapter } from './adapters/out/in-memory-messaging.adapter.js';
import { TelegramAdapter } from './adapters/out/telegram.adapter.js';
import {
  CHANNEL_IDENTITY_PORT,
  CONVERSATION_PORT,
  MESSAGING_APPLICATION,
  MESSAGING_PORT,
  MESSAGING_MAINTENANCE,
  PROCESSED_UPDATES_REPOSITORY,
  PROCESSED_UPDATES_RETENTION_REPOSITORY,
} from './ports/tokens.js';

@Module({
  controllers: [TelegramWebhookController],
  providers: [
    DrizzleProcessedUpdatesRepository,
    { provide: PROCESSED_UPDATES_REPOSITORY, useExisting: DrizzleProcessedUpdatesRepository },
    {
      provide: PROCESSED_UPDATES_RETENTION_REPOSITORY,
      useExisting: DrizzleProcessedUpdatesRepository,
    },
    {
      provide: MESSAGING_MAINTENANCE,
      inject: [PROCESSED_UPDATES_RETENTION_REPOSITORY, APP_CLOCK, APP_ENVIRONMENT],
      useFactory: (
        retention: ConstructorParameters<typeof MessagingMaintenanceService>[0],
        clock: Clock,
        environment: AppEnvironment,
      ) =>
        new MessagingMaintenanceService(
          retention,
          clock,
          environment.PROCESSED_UPDATES_RETENTION_DAYS,
        ),
    },
    {
      provide: MESSAGING_PORT,
      inject: [APP_ENVIRONMENT],
      useFactory: (environment: AppEnvironment) =>
        environment.TELEGRAM_BOT_TOKEN
          ? new TelegramAdapter({
              token: environment.TELEGRAM_BOT_TOKEN,
              apiRoot: environment.TELEGRAM_API_ROOT,
            })
          : new InMemoryMessagingAdapter(),
    },
    {
      provide: MESSAGING_APPLICATION,
      inject: [
        CHANNEL_IDENTITY_PORT,
        PROCESSED_UPDATES_REPOSITORY,
        UNIT_OF_WORK,
        { token: CONVERSATION_PORT, optional: true },
      ],
      useFactory: (...dependencies: ConstructorParameters<typeof MessagingApplicationService>) =>
        new MessagingApplicationService(...dependencies),
    },
    TelegramWebhookRateLimiter,
    TelegramUpdateHandler,
    TelegramPollingRunner,
  ],
  exports: [MESSAGING_PORT, MESSAGING_APPLICATION, MESSAGING_MAINTENANCE, TelegramPollingRunner],
})
export class MessagingModule {}
