import type { Clock } from '../../../../shared/kernel/clock.js';
import type { RecommendationsRateLimit } from '../../ports/recommendations-ports.js';

/** Fixed window per key, in memory (per process). */
export class InMemoryRecommendationsRateLimit implements RecommendationsRateLimit {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowSeconds: number,
    private readonly clock: Clock,
  ) {}

  take(key: string): number {
    const now = this.clock.now().getTime();
    const duration = this.windowSeconds * 1000;
    const window = this.windows.get(key);
    if (!window || window.startedAt + duration <= now) {
      this.windows.set(key, { startedAt: now, count: 1 });
      if (this.windows.size > 10_000)
        for (const [stale, value] of this.windows)
          if (value.startedAt + duration <= now) this.windows.delete(stale);
      return 0;
    }
    window.count += 1;
    return window.count > this.limit
      ? Math.max(1, Math.ceil((window.startedAt + duration - now) / 1000))
      : 0;
  }
}
