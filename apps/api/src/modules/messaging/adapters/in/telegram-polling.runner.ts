import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Bot, GrammyError } from 'grammy';
import type pino from 'pino';
import { APP_ENVIRONMENT, APP_LOGGER } from '../../../../shared/infra/tokens.js';
import type { AppEnvironment } from '../../../../shared/infra/env.js';
import { TelegramUpdateHandler } from './telegram-update.handler.js';

@Injectable()
export class TelegramPollingRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private bot: Bot | undefined;

  constructor(
    @Inject(APP_ENVIRONMENT) private readonly environment: AppEnvironment,
    @Inject(TelegramUpdateHandler) private readonly handler: TelegramUpdateHandler,
    @Inject(APP_LOGGER) private readonly logger: pino.Logger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (
      this.environment.TELEGRAM_MODE !== 'polling' ||
      this.environment.NODE_ENV !== 'development' ||
      !this.environment.TELEGRAM_BOT_TOKEN
    ) {
      return;
    }

    const bot = new Bot(this.environment.TELEGRAM_BOT_TOKEN, {
      client: { apiRoot: this.environment.TELEGRAM_API_ROOT },
    });
    this.bot = bot;
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    bot.on('message', async (context) => {
      const result = await this.handler.process(context.update);
      await this.handler.deliver(result.replies);
    });
    bot.catch((error) => {
      this.logger.error(
        {
          event: 'telegram_polling_error',
          errorName: error.error instanceof Error ? error.error.name : 'UnknownError',
          errorCode: error.error instanceof GrammyError ? error.error.error_code : undefined,
        },
        'Telegram polling failed.',
      );
    });
    void bot.start({ allowed_updates: ['message'] }).catch((error: unknown) => {
      this.logger.error(
        {
          event: 'telegram_polling_start_failed',
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorCode: error instanceof GrammyError ? error.error_code : undefined,
        },
        'Telegram polling could not start.',
      );
    });
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.bot) return;
    await this.bot.stop();
  }
}
