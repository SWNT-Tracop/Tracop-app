import { Inject, Injectable } from '@nestjs/common';
import { APP_ENVIRONMENT } from '../../../../shared/infra/tokens.js';
import type { AppEnvironment } from '../../../../shared/infra/env.js';
import { RateLimitExceeded } from '../../../../shared/kernel/domain-error.js';
import type { OrderingRateLimit } from '../../ports/ordering-ports.js';

@Injectable()
export class InMemoryOrderingRateLimit implements OrderingRateLimit {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  constructor(@Inject(APP_ENVIRONMENT) private readonly env: AppEnvironment) {}

  consume(userId: string, action: string): void {
    const key = `${userId}:${action}`;
    const duration = this.env.ORDER_RATE_WINDOW_SECONDS * 1000;
    const limit = this.env.ORDER_RATE_LIMIT;
    const window = this.windows.get(key);
    const now = Date.now();
    if (!window || window.startedAt + duration <= now) {
      this.windows.set(key, { startedAt: now, count: 1 });
      return;
    }
    window.count += 1;
    if (window.count > limit) {
      throw new RateLimitExceeded(
        Math.max(1, Math.ceil((window.startedAt + duration - now) / 1000)),
      );
    }
  }
}
