import { describe, expect, it } from 'vitest';
import {
  locationPackResponseSchema,
  stopLocationResponseSchema,
} from '../src/schemas/logistics-location.js';

const id = '018f47a2-8b45-7cc2-9a1e-123456789abc';

describe('logistics location contracts', () => {
  it('describes pickup points within Colombia (at most 20) and a delivery address', () => {
    expect(
      stopLocationResponseSchema.safeParse({
        stopId: id,
        kind: 'pickup',
        orderId: id,
        points: [{ lat: 5.53, lng: -73.36 }],
      }).success,
    ).toBe(true);
    expect(
      stopLocationResponseSchema.safeParse({
        stopId: id,
        kind: 'delivery',
        orderId: id,
        address: 'Calle 1',
      }).success,
    ).toBe(true);
    expect(
      stopLocationResponseSchema.safeParse({
        stopId: id,
        kind: 'pickup',
        orderId: id,
        points: Array.from({ length: 21 }, () => ({ lat: 5, lng: -73 })),
      }).success,
    ).toBe(false);
    expect(
      stopLocationResponseSchema.safeParse({
        stopId: id,
        kind: 'pickup',
        orderId: id,
        points: [{ lat: 40, lng: -3 }],
      }).success,
    ).toBe(false);
  });

  it('requires an expiry on the location pack', () => {
    expect(locationPackResponseSchema.safeParse({ tripId: id, stops: [] }).success).toBe(false);
    expect(
      locationPackResponseSchema.safeParse({
        tripId: id,
        expiresAt: '2026-11-26T15:00:00.000Z',
        stops: [],
      }).success,
    ).toBe(true);
  });
});
