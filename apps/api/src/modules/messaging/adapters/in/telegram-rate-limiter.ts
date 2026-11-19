import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_ENVIRONMENT } from '../../../../shared/infra/tokens.js';
import type { AppEnvironment } from '../../../../shared/infra/env.js';

interface Bucket {
  windowStart: number;
  count: number;
}

@Injectable()
export class TelegramWebhookRateLimiter {
  private readonly senderBuckets = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly perSenderLimit: number;
  private readonly globalLimit: number;
  private readonly secret: string;
  private globalBucket: Bucket = { windowStart: 0, count: 0 };

  constructor(@Inject(APP_ENVIRONMENT) environment: AppEnvironment) {
    this.windowMs = environment.TELEGRAM_RATE_LIMIT_WINDOW_SECONDS * 1000;
    this.perSenderLimit = environment.TELEGRAM_RATE_LIMIT_PER_SENDER;
    this.globalLimit = environment.TELEGRAM_RATE_LIMIT_GLOBAL;
    this.secret = environment.RATE_LIMIT_HMAC_SECRET;
  }

  allow(senderId: string, now = Date.now()): boolean {
    if (!this.consumeGlobal(now)) return false;
    const key = createHmac('sha256', this.secret).update(senderId).digest('hex');
    const bucket = this.senderBuckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      this.senderBuckets.set(key, { windowStart: now, count: 1 });
      this.prune(now);
      return true;
    }
    if (bucket.count >= this.perSenderLimit) return false;
    bucket.count += 1;
    return true;
  }

  private consumeGlobal(now: number): boolean {
    if (this.globalBucket.count === 0 || now - this.globalBucket.windowStart >= this.windowMs) {
      this.globalBucket = { windowStart: now, count: 1 };
      return true;
    }
    if (this.globalBucket.count >= this.globalLimit) return false;
    this.globalBucket.count += 1;
    return true;
  }

  private prune(now: number): void {
    if (this.senderBuckets.size < 1_000) return;
    for (const [key, bucket] of this.senderBuckets) {
      if (now - bucket.windowStart >= this.windowMs) this.senderBuckets.delete(key);
    }
  }
}
