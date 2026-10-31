import { describe, expect, it } from 'vitest';
import {
  createLotSchema,
  productAttributesSchema,
  searchLotsQuerySchema,
} from '../src/schemas/catalog.js';

describe('catalog contracts', () => {
  it('accepts only bounded, closed product attributes', () => {
    expect(productAttributesSchema.safeParse({ color: 'rojo', organic: true }).success).toBe(true);
    expect(
      productAttributesSchema.safeParse({
        ...Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`a${i}`, 'x'])),
      }).success,
    ).toBe(false);
    expect(productAttributesSchema.safeParse({ 'not valid': 'x' }).success).toBe(false);
  });

  it('requires UUID v7 client lot ids and a full location search tuple', () => {
    const lot = {
      id: '018f47a2-8b45-7cc2-9a1e-123456789abc',
      productId: '018f47a2-8b45-7cc2-9a1e-123456789abd',
      quantity: 2,
      unit: 'kg',
      unitPrice: 2500,
      qualityGrade: null,
      availableFrom: '2026-10-30T12:00:00Z',
      availableUntil: '2026-10-31T12:00:00Z',
      locationLat: 5.5,
      locationLng: -73.4,
    };
    expect(createLotSchema.safeParse(lot).success).toBe(true);
    expect(
      createLotSchema.safeParse({ ...lot, id: '018f47a2-8b45-6cc2-9a1e-123456789abc' }).success,
    ).toBe(false);
    expect(searchLotsQuerySchema.safeParse({ lat: 5 }).success).toBe(false);
    expect(searchLotsQuerySchema.safeParse({ sort: 'distance' }).success).toBe(false);
    expect(searchLotsQuerySchema.safeParse({ minPrice: 200, maxPrice: 100 }).success).toBe(false);
  });
});
