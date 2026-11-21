import { createId } from '../../../shared/kernel/ids.js';
import { DomainError } from '../../../shared/kernel/domain-error.js';
import { Carrier } from './carrier.js';
import { Checkin } from './checkin.js';
import { Incident } from './incident.js';
import { Trip } from './trip.js';
import { TripStop } from './trip-stop.js';
import { recommendStops, zoneFromAddress } from './recommendation.js';

const now = new Date('2026-11-19T12:00:00.000Z');
const carrierId = createId();
const orderA = createId();
const orderB = createId();

const tripProps = () => ({
  id: createId(),
  carrierId,
  status: 'planned' as const,
  version: 1,
  plannedAt: now,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  route: [
    {
      stopId: createId(),
      orderId: orderA,
      kind: 'pickup' as const,
      sequence: 1,
      zone: 'bogota',
    },
  ],
});

const stopProps = (kind: 'pickup' | 'delivery' = 'pickup') => ({
  id: createId(),
  tripId: createId(),
  orderId: orderA,
  orderVersion: 1,
  kind,
  sequence: 1,
  zone: 'bogota',
  scheduledAt: null,
  completedAt: null,
});

describe('logistics domain', () => {
  it('rechaza un viaje sin paradas o con versión inválida', () => {
    const base = tripProps();
    expect(() => Trip.create({ ...base, route: [] })).toThrow(DomainError);
    expect(() => Trip.create({ ...base, version: 0 })).toThrow(DomainError);
    expect(() => Trip.create({ ...base, status: 'in_progress', route: base.route })).toThrow(
      'planeado',
    );
  });

  it('recorre la máquina de estados y emite eventos', () => {
    const trip = Trip.create(tripProps());
    trip.assign(carrierId, now);
    trip.start(now);
    trip.complete(now);
    expect(trip.props.status).toBe('completed');
    expect(trip.props.version).toBe(4);
    expect(trip.drainEvents().map((event) => event.type)).toEqual([
      'TripAssigned',
      'TripStarted',
      'TripCompleted',
    ]);
    expect(() => trip.start(now)).toThrow('Transición de viaje inválida');
  });

  it('reasigna y cancela con eventos', () => {
    const trip = Trip.create(tripProps());
    trip.assign(carrierId, now);
    trip.reassign(createId(), now);
    expect(trip.props.carrierId).not.toBe(carrierId);
    trip.cancel(now, 'conflicto');
    expect(trip.props.status).toBe('cancelled');
    expect(trip.drainEvents().map((event) => event.type)).toEqual([
      'TripAssigned',
      'TripAssigned',
      'TripCancelled',
    ]);
    expect(() => trip.assign(carrierId, now)).toThrow(DomainError);
    const inProgress = Trip.create(tripProps());
    inProgress.assign(carrierId, now);
    inProgress.start(now);
    expect(() => inProgress.reassign(carrierId, now)).toThrow(DomainError);
  });

  it('valida paradas y su compleción', () => {
    const stop = TripStop.create(stopProps());
    expect(() => TripStop.create({ ...stopProps(), sequence: 0 })).toThrow(DomainError);
    expect(() => TripStop.create({ ...stopProps(), orderVersion: 0 })).toThrow(DomainError);
    expect(() => TripStop.create({ ...stopProps(), zone: ' ' })).toThrow(DomainError);
    stop.complete(now);
    expect(stop.props.completedAt).toEqual(now);
    expect(() => stop.complete(now)).toThrow('ya fue completada');
  });

  it('valida check-ins sin coordenadas', () => {
    const stop = stopProps('pickup');
    const input = {
      id: createId(),
      stopId: stop.id,
      tripId: stop.tripId,
      orderId: stop.orderId,
      carrierId,
      kind: 'pickup' as const,
      clientAt: new Date(now.getTime() - 1000),
      serverAt: now,
      mediaRef: null,
      stopKind: stop.kind,
    };
    expect(Checkin.create(input).props.kind).toBe('pickup');
    expect(() => Checkin.create({ ...input, kind: 'delivery' })).toThrow('no coincide');
    expect(() => Checkin.create({ ...input, clientAt: new Date('2020-01-01T00:00:00Z') })).toThrow(
      'fuera de rango',
    );
    expect(() => Checkin.create({ ...input, clientAt: new Date('invalid') })).toThrow('inválida');
    expect(() => Checkin.create({ ...input, mediaRef: 'x'.repeat(513) })).toThrow('evidencia');
    expect(Checkin.reconstitute(Checkin.create(input).props).props.id).toBe(input.id);
  });

  it('valida perfil de transportista', () => {
    const input = {
      userId: carrierId,
      vehicleType: 'Camion',
      capacityKg: 1200,
      plate: 'abc123',
      createdAt: now,
      updatedAt: now,
    };
    expect(Carrier.create(input).props.plate).toBe('ABC123');
    expect(() => Carrier.create({ ...input, plate: 'a!' })).toThrow('Placa');
    expect(() => Carrier.create({ ...input, vehicleType: 'x' })).toThrow('vehículo');
    expect(() => Carrier.create({ ...input, capacityKg: 0 })).toThrow('Capacidad');
    expect(Carrier.reconstitute(Carrier.create(input).props).props.capacityKg).toBe(1200);
  });

  it('abre y resuelve incidencias', () => {
    const incident = Incident.create({
      id: createId(),
      orderId: orderA,
      tripId: null,
      type: 'daño',
      description: 'Producto dañado',
      status: 'open',
      openedAt: now,
      closedAt: null,
      deletedAt: null,
    });
    expect(() => Incident.create({ ...incident.props, status: 'resolved' })).toThrow('abierta');
    expect(() => Incident.create({ ...incident.props, type: '' })).toThrow('Tipo');
    expect(() => Incident.create({ ...incident.props, description: '' })).toThrow('Descripción');
    incident.resolve(now);
    expect(incident.props.status).toBe('resolved');
    expect(() => incident.resolve(now)).toThrow('ya está resuelta');
  });

  it('recomienda recogidas agrupadas por zona y luego entregas', () => {
    expect(zoneFromAddress(' Carrera 7 # 1, Bogotá ')).toBe('bogotá');
    expect(zoneFromAddress('Carrera 7 # 1')).toBe('zona de entrega');
    expect(() => zoneFromAddress('  ')).toThrow(DomainError);
    const result = recommendStops([
      {
        orderId: orderB,
        providerId: 'p2',
        pickupZone: 'boyaca',
        deliveryZone: 'zona b',
        deliveryWindow: null,
      },
      {
        orderId: orderA,
        providerId: 'p1',
        pickupZone: 'cundinamarca',
        deliveryZone: 'zona a',
        deliveryWindow: null,
      },
    ]);
    expect(result.map((stop) => stop.kind)).toEqual(['pickup', 'pickup', 'delivery', 'delivery']);
    expect(result.map((stop) => stop.sequence)).toEqual([1, 2, 3, 4]);
    expect(result[2]?.zone).toBe('zona a');
    expect(() =>
      recommendStops([
        {
          orderId: orderA,
          providerId: 'p1',
          pickupZone: 'a',
          deliveryZone: 'b',
          deliveryWindow: null,
        },
        {
          orderId: orderA,
          providerId: 'p1',
          pickupZone: 'a',
          deliveryZone: 'b',
          deliveryWindow: null,
        },
      ]),
    ).toThrow('duplicados');
  });
});
