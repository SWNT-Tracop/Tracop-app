import { RateLimitExceeded } from '../../../../shared/kernel/domain-error.js';
import type { LocationRateLimitPort } from '../../ports/trip-location-ports.js';

/** Fixed window per user, on the injected clock (in memory, per instance, like the others). */
export class InMemoryLocationRateLimit implements LocationRateLimitPort {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowSeconds: number,
  ) {}

  consume(userId: string, now: Date): void {
    const duration = this.windowSeconds * 1000;
    const current = now.getTime();
    const window = this.windows.get(userId);
    if (!window || window.startedAt + duration <= current) {
      this.windows.set(userId, { startedAt: current, count: 1 });
      return;
    }
    window.count += 1;
    if (window.count > this.limit)
      throw new RateLimitExceeded(
        Math.max(1, Math.ceil((window.startedAt + duration - current) / 1000)),
      );
  }
}
