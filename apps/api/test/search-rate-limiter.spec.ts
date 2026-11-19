import { InMemorySearchRateLimiter } from '../src/shared/infra/search-rate-limiter.js';

describe('in-memory catalog search rate limiter', () => {
  it('limits per user and starts a fresh window after expiration', () => {
    const limiter = new InMemorySearchRateLimiter({
      CATALOG_SEARCH_RATE_LIMIT: 2,
      CATALOG_SEARCH_RATE_WINDOW_SECONDS: 60,
    } as never);
    limiter.consume('buyer-1', 1_000);
    limiter.consume('buyer-1', 2_000);
    expect(() => limiter.consume('buyer-1', 3_000)).toThrow('Demasiadas solicitudes');
    expect(() => limiter.consume('buyer-2', 3_000)).not.toThrow();
    expect(() => limiter.consume('buyer-1', 61_001)).not.toThrow();
  });
});
