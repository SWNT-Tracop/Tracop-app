import { InMemoryProductProposalRateLimiter } from './product-proposal-rate-limiter.js';
import type { AppEnvironment } from '../../../../shared/infra/env.js';

describe('InMemoryProductProposalRateLimiter', () => {
  it('returns rate_limited with Retry-After data', () => {
    const limiter = new InMemoryProductProposalRateLimiter({
      CATALOG_PRODUCT_PROPOSAL_RATE_LIMIT: 2,
      CATALOG_PRODUCT_PROPOSAL_RATE_WINDOW_SECONDS: 60,
    } as AppEnvironment);
    limiter.consume('user', 1000);
    limiter.consume('user', 1001);
    expect(() => limiter.consume('user', 1002)).toThrow(
      expect.objectContaining({ code: 'rate_limited', retryAfter: expect.any(Number) }),
    );
  });
});
