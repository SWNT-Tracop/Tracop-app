import { Inject, Injectable } from '@nestjs/common';
import { RateLimitExceeded } from '../../../../shared/kernel/domain-error.js';
import type { AppEnvironment } from '../../../../shared/infra/env.js';
import { APP_ENVIRONMENT } from '../../../../shared/infra/tokens.js';
import type { SyncRateLimitPort } from '../../ports/sync-ports.js';

@Injectable()
export class InMemorySyncRateLimiter implements SyncRateLimitPort {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(@Inject(APP_ENVIRONMENT) private readonly env: AppEnvironment) {}

  consume(userId: string, action: 'push' | 'pull'): void {
    const now = Date.now();
    const duration = this.env.SYNC_RATE_WINDOW_SECONDS * 1000;
    const key = `${userId}:${action}`;
    const current = this.windows.get(key);
    if (!current || current.startedAt + duration <= now) {
      this.windows.set(key, { startedAt: now, count: 1 });
      return;
    }
    current.count += 1;
    const limit = action === 'push' ? this.env.SYNC_PUSH_RATE_LIMIT : this.env.SYNC_PULL_RATE_LIMIT;
    if (current.count > limit) {
      throw new RateLimitExceeded(
        Math.max(1, Math.ceil((current.startedAt + duration - now) / 1000)),
      );
    }
  }
}
