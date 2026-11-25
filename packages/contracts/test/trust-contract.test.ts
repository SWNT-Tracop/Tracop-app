import { describe, expect, it } from 'vitest';
import {
  approveVerificationSchema,
  myReputationResponseSchema,
  providerTrustSchema,
  submitRatingSchema,
} from '../src/schemas/trust.js';

const v7 = '018f47a2-8b45-7cc2-9a1e-123456789abc';

describe('trust contracts', () => {
  it('rates with a UUID v7, a whole score from 1 to 5 and an optional bounded comment', () => {
    const rating = { id: v7, orderId: v7, ratee: 'provider', score: 5 };
    expect(submitRatingSchema.safeParse(rating).success).toBe(true);
    expect(submitRatingSchema.safeParse({ ...rating, comment: 'x'.repeat(500) }).success).toBe(
      true,
    );
    for (const invalid of [
      { ...rating, score: 0 },
      { ...rating, score: 4.5 },
      { ...rating, ratee: 'buyer' },
      { ...rating, id: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed' },
      { ...rating, comment: 'x'.repeat(501) },
      { ...rating, raterId: v7 },
    ])
      expect(submitRatingSchema.safeParse(invalid).success).toBe(false);
  });

  it('describes the rating as one-decimal text or null, and never names the provider', () => {
    expect(
      providerTrustSchema.safeParse({ verified: true, rating: '4.3', ratingsCount: 3 }).success,
    ).toBe(true);
    expect(
      providerTrustSchema.safeParse({ verified: true, rating: null, ratingsCount: 2 }).success,
    ).toBe(true);
    expect(
      providerTrustSchema.safeParse({ verified: true, rating: 4.3, ratingsCount: 3 }).success,
    ).toBe(false);
    expect(
      providerTrustSchema.safeParse({
        verified: true,
        rating: null,
        ratingsCount: 0,
        providerId: v7,
      }).success,
    ).toBe(false);
    expect(
      myReputationResponseSchema.safeParse({
        rating: null,
        ratingsCount: 0,
        comments: [],
        verification: 'unverified',
      }).success,
    ).toBe(true);
  });

  it('requires the three verification checks', () => {
    expect(
      approveVerificationSchema.safeParse({
        checks: { contact_confirmed: true, location_confirmed: true },
      }).success,
    ).toBe(false);
  });
});
