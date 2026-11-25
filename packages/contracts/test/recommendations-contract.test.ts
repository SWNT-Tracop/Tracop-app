import { describe, expect, it } from 'vitest';
import {
  createAlertSchema,
  priceSuggestionResponseSchema,
  recommendationsQuerySchema,
  recommendedLotSchema,
} from '../src/schemas/recommendations.js';

const v7 = '018f47a2-8b45-7cc2-9a1e-123456789abc';

describe('recommendations contracts', () => {
  it('describes a range or insufficient data, never individual prices', () => {
    const ok = {
      status: 'ok',
      productId: v7,
      unit: 'bulto',
      low: '85000',
      median: '90000',
      high: '95000',
      sources: [{ name: 'DANE-SIPSA', count: 3, observedAt: '2026-11-22T00:00:00.000Z' }],
      citation: 'Fuente: Departamento Administrativo Nacional de Estadística: www.dane.gov.co',
    };
    expect(priceSuggestionResponseSchema.safeParse(ok).success).toBe(true);
    expect(priceSuggestionResponseSchema.safeParse({ ...ok, prices: ['80000'] }).success).toBe(
      false,
    );
    expect(
      priceSuggestionResponseSchema.safeParse({
        status: 'insufficient_data',
        productId: v7,
        unit: 'bulto',
      }).success,
    ).toBe(true);
  });

  it('asks lat and lng together and radius only with them', () => {
    expect(
      recommendationsQuerySchema.safeParse({ lat: '4.6', lng: '-74.1', radiusKm: '50' }).success,
    ).toBe(true);
    expect(recommendationsQuerySchema.safeParse({ lat: '4.6' }).success).toBe(false);
    expect(recommendationsQuerySchema.safeParse({ radiusKm: '10' }).success).toBe(false);
  });

  it('gives reasons as codes and no coordinates', () => {
    const lot = {
      lotId: v7,
      productId: v7,
      unit: 'bulto',
      unitPrice: '88000',
      distanceKm: 12,
      score: 70,
      reasons: ['reorder'],
    };
    expect(recommendedLotSchema.safeParse(lot).success).toBe(true);
    expect(recommendedLotSchema.safeParse({ ...lot, reasons: ['cheap'] }).success).toBe(false);
    expect(recommendedLotSchema.safeParse({ ...lot, locationLat: 4.6 }).success).toBe(false);
    expect(recommendedLotSchema.safeParse({ ...lot, distanceKm: 12.4 }).success).toBe(false);
  });

  it('creates alerts with a UUID v7 and bounded radius', () => {
    const alert = { id: v7, productId: v7, maxPrice: 90000, radiusKm: 50, lat: 4.6, lng: -74.1 };
    expect(createAlertSchema.safeParse(alert).success).toBe(true);
    expect(createAlertSchema.safeParse({ ...alert, radiusKm: 301 }).success).toBe(false);
    expect(
      createAlertSchema.safeParse({ ...alert, id: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed' }).success,
    ).toBe(false);
  });
});
