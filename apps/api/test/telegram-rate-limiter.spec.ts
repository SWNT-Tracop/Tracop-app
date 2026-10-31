import { TelegramWebhookRateLimiter } from '../src/modules/messaging/adapters/in/telegram-rate-limiter.js';
import type { AppEnvironment } from '../src/shared/infra/env.js';

const limiterFor = (perSender: number, global: number): TelegramWebhookRateLimiter =>
  new TelegramWebhookRateLimiter({
    TELEGRAM_RATE_LIMIT_PER_SENDER: perSender,
    TELEGRAM_RATE_LIMIT_GLOBAL: global,
    TELEGRAM_RATE_LIMIT_WINDOW_SECONDS: 60,
    RATE_LIMIT_HMAC_SECRET: 'r'.repeat(32),
  } as AppEnvironment);

describe('Telegram webhook rate limiter', () => {
  it('limits each sender independently within the window', () => {
    const limiter = limiterFor(2, 100);

    expect(limiter.allow('900001', 0)).toBe(true);
    expect(limiter.allow('900001', 10)).toBe(true);
    expect(limiter.allow('900001', 20)).toBe(false);
    expect(limiter.allow('900002', 20)).toBe(true);
  });

  it('resets sender buckets when the window elapses', () => {
    const limiter = limiterFor(1, 100);

    expect(limiter.allow('900001', 0)).toBe(true);
    expect(limiter.allow('900001', 59_999)).toBe(false);
    expect(limiter.allow('900001', 60_000)).toBe(true);
  });

  it('enforces a global ceiling across senders', () => {
    const limiter = limiterFor(10, 2);

    expect(limiter.allow('1', 0)).toBe(true);
    expect(limiter.allow('2', 1)).toBe(true);
    expect(limiter.allow('3', 2)).toBe(false);
    expect(limiter.allow('3', 60_000)).toBe(true);
  });
});
