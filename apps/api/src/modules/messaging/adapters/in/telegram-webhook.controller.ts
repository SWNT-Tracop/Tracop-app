import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, Headers, HttpCode, Inject, Post, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type pino from 'pino';
import { APP_ENVIRONMENT, APP_LOGGER } from '../../../../shared/infra/tokens.js';
import type { AppEnvironment } from '../../../../shared/infra/env.js';
import { TelegramUpdateHandler } from './telegram-update.handler.js';

class WebhookTimeoutError extends Error {
  constructor() {
    super('Telegram webhook processing timed out.');
    this.name = 'WebhookTimeoutError';
  }
}

const withTimeout = <T>(operation: Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WebhookTimeoutError()), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

@ApiTags('messaging')
@Controller('webhooks')
export class TelegramWebhookController {
  constructor(
    @Inject(TelegramUpdateHandler) private readonly handler: TelegramUpdateHandler,
    @Inject(APP_ENVIRONMENT) private readonly environment: AppEnvironment,
    @Inject(APP_LOGGER) private readonly logger: pino.Logger,
  ) {}

  @Post('telegram')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async handle(
    @Headers('x-telegram-bot-api-secret-token') secretToken: string | undefined,
    @Body() body: unknown,
    @Res() response: Response,
  ): Promise<void> {
    if (!this.isValidSecret(secretToken)) {
      response.status(401).end();
      return;
    }

    try {
      const result = await withTimeout(
        this.handler.process(body),
        this.environment.TELEGRAM_WEBHOOK_PROCESS_TIMEOUT_MS,
      );
      response.status(200).json({ ok: true });
      void this.handler.deliver(result.replies);
    } catch (error) {
      this.logger.error(
        {
          event: 'telegram_webhook_failed',
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorCode:
            typeof error === 'object' && error !== null && 'code' in error
              ? String((error as { code: unknown }).code)
              : undefined,
        },
        'Telegram webhook processing failed.',
      );
      response.status(500).json({ ok: false });
    }
  }

  private isValidSecret(provided: string | undefined): boolean {
    const expected = this.environment.TELEGRAM_WEBHOOK_SECRET;
    if (!expected || !provided) return false;
    const providedBytes = Buffer.from(provided);
    const expectedBytes = Buffer.from(expected);
    if (providedBytes.length !== expectedBytes.length) return false;
    return timingSafeEqual(providedBytes, expectedBytes);
  }
}
