import { InMemorySyncRateLimiter } from './in-memory-sync-rate-limiter.js';

describe('InMemorySyncRateLimiter', () => {
  it('uses distinct configured push and pull quotas per user', () => {
    const limiter = new InMemorySyncRateLimiter({
      SYNC_RATE_WINDOW_SECONDS: 60,
      SYNC_PUSH_RATE_LIMIT: 1,
      SYNC_PULL_RATE_LIMIT: 2,
    } as never);

    expect(() => limiter.consume('user-a', 'push')).not.toThrow();
    expect(() => limiter.consume('user-a', 'push')).toThrow(
      expect.objectContaining({ code: 'rate_limited' }),
    );
    expect(() => limiter.consume('user-a', 'pull')).not.toThrow();
    expect(() => limiter.consume('user-a', 'pull')).not.toThrow();
    expect(() => limiter.consume('user-a', 'pull')).toThrow(
      expect.objectContaining({ code: 'rate_limited' }),
    );
    expect(() => limiter.consume('user-b', 'push')).not.toThrow();
  });
});
