import { RateLimitExceeded } from '../../../../shared/kernel/domain-error.js';
import type { AppEnvironment } from '../../../../shared/infra/env.js';
import type { PhotoUploadRateLimitPort } from '../../ports/lot-photo-ports.js';

export class PhotoUploadRateLimiter implements PhotoUploadRateLimitPort {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(private readonly env: AppEnvironment) {}

  consume(userId: string, now: Date): void {
    const timestamp = now.getTime();
    const duration = this.env.CATALOG_PHOTO_UPLOAD_RATE_WINDOW_SECONDS * 1000;
    const current = this.windows.get(userId);
    if (!current || current.startedAt + duration <= timestamp) {
      this.windows.set(userId, { startedAt: timestamp, count: 1 });
      return;
    }
    current.count += 1;
    if (current.count > this.env.CATALOG_PHOTO_UPLOAD_RATE_LIMIT) {
      throw new RateLimitExceeded(
        Math.max(1, Math.ceil((current.startedAt + duration - timestamp) / 1000)),
      );
    }
  }
}
