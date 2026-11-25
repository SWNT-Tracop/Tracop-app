import { RateLimitExceeded } from '../../../../shared/kernel/domain-error.js';
import type { TrustRateLimitPort } from '../../ports/trust-ports.js';

/** Fixed window per key on the injected clock (in memory, per instance). */
export class InMemoryTrustRateLimit implements TrustRateLimitPort {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowSeconds: number,
  ) {}

  consume(key: string, now: Date): void {
    const duration = this.windowSeconds * 1000;
    const current = now.getTime();
    const window = this.windows.get(key);
    if (!window || window.startedAt + duration <= current) {
      this.windows.set(key, { startedAt: current, count: 1 });
      return;
    }
    window.count += 1;
    if (window.count > this.limit)
      throw new RateLimitExceeded(
        Math.max(1, Math.ceil((window.startedAt + duration - current) / 1000)),
      );
  }
}
