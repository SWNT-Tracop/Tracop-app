import type { AppEnvironment } from '../../../../shared/infra/env.js';
import { PhotoUploadRateLimiter } from './photo-upload-rate-limiter.js';

describe('PhotoUploadRateLimiter', () => {
  const limiter = () =>
    new PhotoUploadRateLimiter({
      CATALOG_PHOTO_UPLOAD_RATE_LIMIT: 2,
      CATALOG_PHOTO_UPLOAD_RATE_WINDOW_SECONDS: 60,
    } as AppEnvironment);

  it('limits each user independently in memory and resets the fixed window', () => {
    const rateLimit = limiter();
    const start = new Date('2026-11-02T12:00:00.000Z');

    rateLimit.consume('user-a', start);
    rateLimit.consume('user-a', start);
    expect(() => rateLimit.consume('user-a', start)).toThrow('Demasiadas solicitudes');

    expect(() => rateLimit.consume('user-b', start)).not.toThrow();
    expect(() => rateLimit.consume('user-a', new Date(start.getTime() + 60_000))).not.toThrow();
  });
});
