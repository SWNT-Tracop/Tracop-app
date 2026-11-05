import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { telegramUpdateSchema } from '@tracop/contracts';
import type pino from 'pino';
import { APP_CLOCK, APP_ENVIRONMENT, APP_LOGGER } from '../../../../shared/infra/tokens.js';
import type { AppEnvironment } from '../../../../shared/infra/env.js';
import type { Clock } from '../../../../shared/kernel/clock.js';
import type { OutboundMessage } from '../../domain/messaging.js';
import { normalizeTelegramUpdate } from '../../application/normalize-telegram-update.js';
import type {
  MessagingApplication,
  MessagingPort,
  UpdateProcessingResult,
} from '../../ports/messaging-ports.js';
import { MESSAGING_APPLICATION, MESSAGING_PORT } from '../../ports/tokens.js';
import { TelegramWebhookRateLimiter } from './telegram-rate-limiter.js';

@Injectable()
export class TelegramUpdateHandler {
  constructor(
    @Inject(MESSAGING_APPLICATION) private readonly application: MessagingApplication,
    @Inject(MESSAGING_PORT) private readonly messaging: MessagingPort,
    @Inject(TelegramWebhookRateLimiter) private readonly rateLimiter: TelegramWebhookRateLimiter,
    @Inject(APP_ENVIRONMENT) private readonly environment: AppEnvironment,
    @Inject(APP_CLOCK) private readonly clock: Clock,
    @Inject(APP_LOGGER) private readonly logger: pino.Logger,
  ) {}

  async process(update: unknown): Promise<UpdateProcessingResult> {
    const parsed = telegramUpdateSchema.safeParse(update);
    if (!parsed.success) return { kind: 'ignored', replies: [] };

    const normalized = normalizeTelegramUpdate(parsed.data, this.clock.now());
    if (!normalized.message) return { kind: 'ignored', replies: [] };

    if (!this.rateLimiter.allow(normalized.message.channelUserId)) {
      return { kind: 'dropped', replies: [] };
    }

    const result = await this.application.handleUpdate(normalized.updateId, normalized.message);
    if (result.securityEvent) {
      this.logger.warn(
        { event: 'messaging_security_event', reason: result.securityEvent },
        'Messaging security event.',
      );
    }
    return result;
  }

  async deliver(replies: readonly OutboundMessage[]): Promise<void> {
    for (const reply of replies) {
      try {
        const outcome = reply.buttons?.length
          ? await this.messaging.sendButtons(reply.to, reply.text, reply.buttons)
          : await this.messaging.sendText(reply.to, reply.text);
        if (!outcome.ok) {
          this.logger.warn(
            {
              event: 'messaging_delivery_failed',
              failure: outcome.error.kind,
              retryAfterSeconds:
                outcome.error.kind === 'rate_limited' ? outcome.error.retryAfterSeconds : undefined,
              recipientHash: this.hashChannelUserId(reply.to.channelUserId),
            },
            'Messaging delivery failed.',
          );
        }
      } catch (error) {
        this.logger.warn(
          {
            event: 'messaging_delivery_failed',
            failure: 'exception',
            errorName: error instanceof Error ? error.name : 'UnknownError',
            recipientHash: this.hashChannelUserId(reply.to.channelUserId),
          },
          'Messaging delivery failed.',
        );
      }
    }
  }

  private hashChannelUserId(channelUserId: string): string {
    return createHmac('sha256', this.environment.RATE_LIMIT_HMAC_SECRET)
      .update(channelUserId)
      .digest('hex')
      .slice(0, 32);
  }
}
