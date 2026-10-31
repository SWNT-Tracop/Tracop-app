import { Inject, Injectable } from '@nestjs/common';
import { APP_ENVIRONMENT } from './tokens.js';
import type { AppEnvironment } from './env.js';
import { RateLimitExceeded } from '../kernel/domain-error.js';

@Injectable()
export class InMemorySearchRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  constructor(@Inject(APP_ENVIRONMENT) private readonly env: AppEnvironment) {}

  consume(userId: string, now = Date.now()): void {
    const duration = this.env.CATALOG_SEARCH_RATE_WINDOW_SECONDS * 1000;
    const window = this.windows.get(userId);
    if (!window || window.startedAt + duration <= now) {
      this.windows.set(userId, { startedAt: now, count: 1 });
      return;
    }
    window.count += 1;
    if (window.count > this.env.CATALOG_SEARCH_RATE_LIMIT) {
      throw new RateLimitExceeded(
        Math.max(1, Math.ceil((window.startedAt + duration - now) / 1000)),
      );
    }
  }
}
