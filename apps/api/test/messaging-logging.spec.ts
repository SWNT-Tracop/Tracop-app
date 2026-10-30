import { Writable } from 'node:stream';
import { TelegramUpdateHandler } from '../src/modules/messaging/adapters/in/telegram-update.handler.js';
import { TelegramWebhookRateLimiter } from '../src/modules/messaging/adapters/in/telegram-rate-limiter.js';
import type {
  MessagingApplication,
  UpdateProcessingResult,
} from '../src/modules/messaging/ports/messaging-ports.js';
import type { AppEnvironment } from '../src/shared/infra/env.js';
import { createLogger } from '../src/shared/infra/logger.js';
import { FixedClock } from './support/in-memory-identity.js';
import { FakeMessagingAdapter } from './support/fake-messaging.js';

class FakeApplication implements MessagingApplication {
  result: UpdateProcessingResult = { kind: 'processed', replies: [] };

  async handleUpdate(): Promise<UpdateProcessingResult> {
    return this.result;
  }

  async handleInboundMessage(): Promise<UpdateProcessingResult> {
    return this.result;
  }
}

const environment = {
  RATE_LIMIT_HMAC_SECRET: 'r'.repeat(32),
  TELEGRAM_RATE_LIMIT_PER_SENDER: 10,
  TELEGRAM_RATE_LIMIT_GLOBAL: 100,
  TELEGRAM_RATE_LIMIT_WINDOW_SECONDS: 60,
} as AppEnvironment;

const capture = () => {
  let output = '';
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  return { logger: createLogger('development', destination), read: () => output };
};

describe('messaging logging', () => {
  it('logs delivery failures with a hashed recipient and no chat id', async () => {
    const application = new FakeApplication();
    const messaging = new FakeMessagingAdapter();
    messaging.failure = { kind: 'blocked_by_user' };
    const { logger, read } = capture();
    const handler = new TelegramUpdateHandler(
      application,
      messaging,
      new TelegramWebhookRateLimiter(environment),
      environment,
      new FixedClock(),
      logger,
    );

    await handler.deliver([
      {
        to: { channel: 'telegram', channelUserId: 'very-secret-chat-id' },
        text: 'Hola',
      },
    ]);

    expect(read()).toContain('messaging_delivery_failed');
    expect(read()).toContain('recipientHash');
    expect(read()).not.toContain('very-secret-chat-id');
  });

  it('logs security events without phone or message content', async () => {
    const application = new FakeApplication();
    application.result = {
      kind: 'processed',
      replies: [],
      securityEvent: 'contact_user_mismatch',
    };
    const { logger, read } = capture();
    const handler = new TelegramUpdateHandler(
      application,
      new FakeMessagingAdapter(),
      new TelegramWebhookRateLimiter(environment),
      environment,
      new FixedClock(),
      logger,
    );

    await handler.process({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1_767_225_600,
        chat: { id: 900001, type: 'private' },
        from: { id: 900001, is_bot: false },
        contact: { phone_number: '+573001234567', user_id: 1 },
      },
    });

    expect(read()).toContain('messaging_security_event');
    expect(read()).not.toContain('3001234567');
    expect(read()).not.toContain('900001');
  });
});
