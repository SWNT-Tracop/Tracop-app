import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const createId = (): string => {
  const uuid = randomUUID();
  return `${uuid.slice(0, 14)}7${uuid.slice(15)}`;
};
import {
  cancelTripSchema,
  carrierProfileSchema,
  checkinSyncPayloadSchema,
  createCheckinSchema,
  createTripSchema,
  logisticsOrderCandidateSchema,
  openIncidentSchema,
  reassignTripSchema,
  recommendTripsQuerySchema,
  tripTransitionSchema,
} from '../src/index.js';

describe('logistics contracts', () => {
  it('valida el perfil del transportista', () => {
    expect(
      carrierProfileSchema.safeParse({ vehicleType: 'Camion', capacityKg: 1000, plate: 'ABC123' })
        .success,
    ).toBe(true);
    expect(
      carrierProfileSchema.safeParse({ vehicleType: 'x', capacityKg: 0, plate: '!' }).success,
    ).toBe(false);
  });

  it('valida creación de viajes sin pedidos duplicados', () => {
    const id = createId();
    expect(createTripSchema.safeParse({ id, orderIds: [createId()] }).success).toBe(true);
    const duplicated = createId();
    expect(createTripSchema.safeParse({ id, orderIds: [duplicated, duplicated] }).success).toBe(
      false,
    );
  });

  it('valida transiciones y consultas', () => {
    expect(tripTransitionSchema.safeParse({ expectedVersion: 1 }).success).toBe(true);
    expect(
      reassignTripSchema.safeParse({ expectedVersion: 1, carrierId: createId() }).success,
    ).toBe(true);
    expect(cancelTripSchema.safeParse({ expectedVersion: 1, reason: 'lluvia' }).success).toBe(true);
    expect(recommendTripsQuerySchema.parse({}).limit).toBe(50);
    expect(recommendTripsQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('valida la proyección mínima de pedidos para logística', () => {
    const result = logisticsOrderCandidateSchema.safeParse({
      orderId: createId(),
      status: 'paid',
      version: 1,
      deliveryZone: 'bogota',
      deliveryWindow: null,
      pickupZones: ['tunja'],
      lines: [{ lotId: createId(), quantityMilli: '1000', unit: 'kg' }],
    });
    expect(result.success).toBe(true);
    expect(
      logisticsOrderCandidateSchema.safeParse({
        orderId: createId(),
        status: 'paid',
        version: 1,
        deliveryZone: 'bogota',
        deliveryWindow: null,
        pickupZones: ['tunja'],
        lines: [{ lotId: createId(), quantityMilli: '1000', unit: 'kg' }],
        deliveryAddress: 'Dirección completa',
      }).success,
    ).toBe(false);
  });

  it('valida check-ins HTTP y de sync sin coordenadas', () => {
    const id = createId();
    const stopId = createId();
    const clientAt = '2026-11-19T12:00:00.000Z';
    expect(createCheckinSchema.safeParse({ id, stopId, kind: 'pickup', clientAt }).success).toBe(
      true,
    );
    expect(
      createCheckinSchema.safeParse({ id, stopId, kind: 'pickup', clientAt, lat: 4.7 }).success,
    ).toBe(false);
    expect(checkinSyncPayloadSchema.safeParse({ stopId, kind: 'delivery', clientAt }).success).toBe(
      true,
    );
    expect(
      checkinSyncPayloadSchema.safeParse({ stopId, kind: 'delivery', clientAt, lng: -74 }).success,
    ).toBe(false);
  });

  it('valida incidencias', () => {
    expect(
      openIncidentSchema.safeParse({
        id: createId(),
        orderId: createId(),
        type: 'retraso',
        description: 'Retraso',
      }).success,
    ).toBe(true);
    expect(
      openIncidentSchema.safeParse({
        id: createId(),
        orderId: createId(),
        type: '',
        description: '',
      }).success,
    ).toBe(false);
  });
});
