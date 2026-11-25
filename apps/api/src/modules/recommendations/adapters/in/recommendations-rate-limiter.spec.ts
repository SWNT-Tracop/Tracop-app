import { InMemoryRecommendationsRateLimit } from './recommendations-rate-limiter.js';

describe('InMemoryRecommendationsRateLimit', () => {
  it('allows the limit per window and key, then answers the seconds left', () => {
    let now = new Date('2026-11-25T15:00:00.000Z');
    const limiter = new InMemoryRecommendationsRateLimit(2, 60, { now: () => now });
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a')]).toEqual([0, 0, 60]);
    expect(limiter.take('b')).toBe(0);
    now = new Date(now.getTime() + 59_500);
    expect(limiter.take('a')).toBe(1);
    now = new Date(now.getTime() + 500);
    expect(limiter.take('a')).toBe(0);
  });
});
