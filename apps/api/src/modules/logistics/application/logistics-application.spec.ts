import { createId } from '../../../shared/kernel/ids.js';
import { InMemoryLogisticsRepository } from '../adapters/out/in-memory-logistics-repository.js';
import type {
  LogisticsActor,
  LogisticsChangeRecorder,
  LogisticsClock,
  LogisticsUnitOfWork,
  OrderCandidate,
  OrderingLogisticsPort,
  ProviderZonePort,
} from '../ports/logistics-ports.js';
import { CarrierProfileService } from './carrier-profile.service.js';
import { CheckinService } from './checkin.service.js';
import { IncidentService } from './incident.service.js';
import { TripPlanningService } from './trip-planning.service.js';

const now = new Date('2026-11-19T12:00:00.000Z');
const carrier: LogisticsActor = { sub: createId(), role: 'carrier' };
const otherCarrier: LogisticsActor = { sub: createId(), role: 'carrier' };
const operator: LogisticsActor = { sub: createId(), role: 'operator' };
const buyer: LogisticsActor = { sub: createId(), role: 'buyer' };
const providerId = createId();
const orderA = createId();
const orderB = createId();

const candidates: readonly OrderCandidate[] = [
  {
    orderId: orderA,
    providerId,
    status: 'paid',
    version: 1,
    deliveryAddress: 'Calle 1, Bogotá',
    deliveryWindow: null,
    lines: [{ lotId: createId(), providerId, quantityMilli: 1000n, unit: 'kg' }],
  },
  {
    orderId: orderB,
    providerId,
    status: 'paid',
    version: 1,
    deliveryAddress: 'Carrera 2, Bogotá',
    deliveryWindow: null,
    lines: [{ lotId: createId(), providerId, quantityMilli: 2000n, unit: 'kg' }],
  },
];

const createHarness = () => {
  const repository = new InMemoryLogisticsRepository();
  const ordering: jest.Mocked<OrderingLogisticsPort> = {
    listPickupCandidates: jest.fn<
      ReturnType<OrderingLogisticsPort['listPickupCandidates']>,
      Parameters<OrderingLogisticsPort['listPickupCandidates']>
    >(async () => candidates),
    getCandidate: jest.fn(
      async (...args: Parameters<OrderingLogisticsPort['getCandidate']>) =>
        candidates.find((candidate) => candidate.orderId === args[1]) ?? null,
    ),
    transition: jest.fn<
      ReturnType<OrderingLogisticsPort['transition']>,
      Parameters<OrderingLogisticsPort['transition']>
    >(async () => undefined),
  };
  const zones: ProviderZonePort = {
    getZones: jest.fn(async () => new Map([[providerId, 'boyaca']])),
  };
  const uow: LogisticsUnitOfWork = { run: async (operation) => operation() };
  const clock: LogisticsClock = { now: () => now };
  const changes: jest.Mocked<LogisticsChangeRecorder> = {
    record: jest.fn<
      ReturnType<LogisticsChangeRecorder['record']>,
      Parameters<LogisticsChangeRecorder['record']>
    >(async () => '1'),
  };
  const outbox = { append: jest.fn(async () => undefined) };
  const carriers = new CarrierProfileService(repository, uow, clock);
  const trips = new TripPlanningService(repository, ordering, zones, uow, clock, changes, outbox);
  const checkins = new CheckinService(repository, ordering, uow, clock, changes, outbox);
  const incidents = new IncidentService(repository, uow, clock, outbox);
  return { repository, ordering, zones, changes, outbox, carriers, trips, checkins, incidents };
};

const registerCarrier = async (h: ReturnType<typeof createHarness>) => {
  await h.carriers.upsertMine(carrier, {
    vehicleType: 'Camion',
    capacityKg: 2000,
    plate: 'ABC123',
  });
};

const planTrip = async (h: ReturnType<typeof createHarness>) => {
  await registerCarrier(h);
  return h.trips.createTrip(carrier, { id: createId(), orderIds: [orderA, orderB] });
};

describe('logistics application', () => {
  it('gestiona el perfil del transportista con RBAC', async () => {
    const h = createHarness();
    await expect(h.carriers.getMine(carrier)).rejects.toThrow('no encontrado');
    await registerCarrier(h);
    expect((await h.carriers.getMine(carrier)).plate).toBe('ABC123');
    expect((await h.carriers.list(operator)).length).toBe(1);
    await expect(
      h.carriers.upsertMine(buyer, { vehicleType: 'Camion', capacityKg: 1, plate: 'ABC123' }),
    ).rejects.toThrow('transportistas');
    await expect(h.carriers.list(carrier)).rejects.toThrow('operador');
  });

  it('recomienda paradas por zonas y crea el viaje asignado al carrier', async () => {
    const h = createHarness();
    const recommendation = await h.trips.recommend(carrier, 10);
    expect(recommendation).toHaveLength(4);
    expect(recommendation.slice(0, 2).every((stop) => stop.kind === 'pickup')).toBe(true);
    expect(h.ordering.listPickupCandidates).toHaveBeenCalledWith(carrier, 10);

    const trip = await planTrip(h);
    expect(trip.status).toBe('assigned');
    expect(trip.route).toHaveLength(4);
    expect(h.ordering.transition).toHaveBeenCalledTimes(2);
    expect(h.ordering.transition).toHaveBeenCalledWith(carrier, orderA, 1, 'pickup_scheduled');
    expect(h.changes.record).toHaveBeenCalledWith(expect.objectContaining({ entity: 'trip' }));
    expect(h.outbox.append).toHaveBeenCalled();
    expect(await h.trips.listStops(carrier, trip.id)).toHaveLength(4);
  });

  it('expone candidatos pagados con solo los datos necesarios para planear', async () => {
    const h = createHarness();
    const [candidate] = await h.trips.listOrderCandidates(carrier);
    expect(candidate).toMatchObject({
      orderId: orderA,
      status: 'paid',
      deliveryZone: 'bogotá',
      pickupZones: ['boyaca'],
      lines: [{ quantityMilli: '1000', unit: 'kg' }],
    });
    expect(candidate).not.toHaveProperty('deliveryAddress');
    expect(candidate).not.toHaveProperty('buyerId');
    expect(candidate).not.toHaveProperty('providerId');
    await expect(h.trips.listOrderCandidates(buyer)).rejects.toThrow('Rol');
  });

  it('rechaza viajes inválidos y pedidos ya asignados', async () => {
    const h = createHarness();
    await expect(h.trips.createTrip(carrier, { id: createId(), orderIds: [] })).rejects.toThrow(
      'pedidos',
    );
    await expect(
      h.trips.createTrip(carrier, { id: createId(), orderIds: [orderA, orderA] }),
    ).rejects.toThrow('duplicados');
    await expect(
      h.trips.createTrip(carrier, { id: createId(), orderIds: [orderA] }),
    ).rejects.toThrow('Perfil');
    await planTrip(h);
    await expect(
      h.trips.createTrip(carrier, { id: createId(), orderIds: [orderA] }),
    ).rejects.toThrow('otro viaje');
    await expect(h.trips.recommend(buyer)).rejects.toThrow('Rol');
  });

  it('aplica transiciones de viaje con control de versión y propiedad', async () => {
    const h = createHarness();
    const trip = await planTrip(h);
    expect((await h.trips.listMine(carrier))[0]?.id).toBe(trip.id);
    expect((await h.trips.listAll(operator))[0]?.id).toBe(trip.id);
    expect((await h.trips.findById(carrier, trip.id)).id).toBe(trip.id);
    await expect(h.trips.findById(otherCarrier, trip.id)).rejects.toThrow('no encontrado');
    await expect(h.trips.listMine(operator)).rejects.toThrow('transportistas');
    await expect(h.trips.listAll(carrier)).rejects.toThrow('operador');
    await expect(h.trips.start(carrier, trip.id, 5)).rejects.toMatchObject({
      code: 'version_conflict',
    });
    const reassigned = await h.trips.assign(operator, trip.id, trip.version, carrier.sub);
    expect(reassigned.carrierId).toBe(carrier.sub);
    const started = await h.trips.start(carrier, trip.id, reassigned.version);
    expect(started.status).toBe('in_progress');
    const cancelled = await h.trips.cancel(carrier, trip.id, started.version, 'lluvia');
    expect(cancelled.status).toBe('cancelled');
    expect(await h.trips.resolveConflicts(operator)).toEqual([]);
    await expect(h.trips.resolveConflicts(carrier)).rejects.toThrow('operador');
  });

  it('registra check-ins, mueve el pedido y completa el viaje', async () => {
    const h = createHarness();
    const trip = await planTrip(h);
    const stops = await h.trips.listStops(carrier, trip.id);
    const pickupA = stops.find((stop) => stop.orderId === orderA && stop.kind === 'pickup')!;
    const deliveryA = stops.find((stop) => stop.orderId === orderA && stop.kind === 'delivery')!;
    const pickupB = stops.find((stop) => stop.orderId === orderB && stop.kind === 'pickup')!;
    const deliveryB = stops.find((stop) => stop.orderId === orderB && stop.kind === 'delivery')!;
    const input = (stopId: string, kind: 'pickup' | 'delivery', id = createId()) => ({
      id,
      stopId,
      kind,
      clientAt: new Date(now.getTime() - 1000),
    });

    expect((await h.checkins.record(carrier, input(pickupA.id, 'pickup'), trip.version)).kind).toBe(
      'pickup',
    );
    expect(h.ordering.transition).toHaveBeenCalledWith(carrier, orderA, 1, 'in_transit');
    expect(await h.checkins.getTripVersion(pickupA.id, carrier)).toBe(trip.version);
    await expect(
      h.checkins.record(carrier, input(pickupA.id, 'pickup'), trip.version),
    ).rejects.toThrow('ya registrado');
    await h.checkins.record(carrier, input(deliveryA.id, 'delivery'), trip.version);
    await h.checkins.record(carrier, input(pickupB.id, 'pickup'), trip.version);
    await h.checkins.record(carrier, input(deliveryB.id, 'delivery'), trip.version);
    expect((await h.repository.findTrip(trip.id))?.status).toBe('completed');
    expect(h.changes.record).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'checkin', op: 'upsert' }),
    );
  });

  it('rechaza check-ins ajenos, conflictivos y de parada inexistente', async () => {
    const h = createHarness();
    const trip = await planTrip(h);
    const stop = (await h.trips.listStops(carrier, trip.id))[0]!;
    const input = { id: createId(), stopId: stop.id, kind: stop.kind, clientAt: now };
    await expect(h.checkins.record(otherCarrier, input)).rejects.toThrow('No autorizado');
    await expect(h.checkins.record(buyer, input)).rejects.toThrow('transportista');
    await expect(h.checkins.record(carrier, input, 99)).rejects.toMatchObject({
      code: 'version_conflict',
    });
    await expect(h.checkins.record(carrier, { ...input, stopId: createId() })).rejects.toThrow(
      'no encontrada',
    );
    await expect(h.checkins.getTripVersion(createId(), carrier)).rejects.toThrow('no encontrada');
    const other = {
      ...input,
      id: createId(),
      stopId: (await h.trips.listStops(carrier, trip.id))[1]!.id,
      kind: 'delivery' as const,
    };
    await expect(h.checkins.record(carrier, other)).rejects.toThrow('no coincide');
  });

  it('gestiona incidencias con propiedad y resolución', async () => {
    const h = createHarness();
    const trip = await planTrip(h);
    const incident = await h.incidents.open(carrier, {
      id: createId(),
      orderId: orderA,
      tripId: trip.id,
      type: 'retraso',
      description: 'Retraso en la recogida',
    });
    expect(incident.status).toBe('open');
    expect((await h.incidents.list(carrier))[0]?.id).toBe(incident.id);
    expect((await h.incidents.resolve(operator, incident.id)).status).toBe('resolved');
    await expect(h.incidents.resolve(carrier, incident.id)).rejects.toThrow('ya está resuelta');
    await expect(
      h.incidents.open(buyer, {
        id: createId(),
        orderId: orderA,
        type: 'retraso',
        description: 'x',
      }),
    ).rejects.toThrow('Rol');

    const foreignTripId = createId();
    const ownStops = await h.trips.listStops(carrier, trip.id);
    const foreignStops = ownStops.map((stop) => ({
      ...stop,
      id: createId(),
      tripId: foreignTripId,
    }));
    await h.repository.createTrip(
      { ...trip, id: foreignTripId, carrierId: otherCarrier.sub },
      foreignStops,
    );
    const foreign = await h.incidents.open(operator, {
      id: createId(),
      orderId: orderB,
      tripId: foreignTripId,
      type: 'retraso',
      description: 'x',
    });
    expect((await h.incidents.list(carrier)).map((item) => item.id)).not.toContain(foreign.id);
    expect((await h.incidents.list(otherCarrier)).map((item) => item.id)).toContain(foreign.id);
    await expect(h.incidents.resolve(carrier, foreign.id)).rejects.toThrow('no encontrada');
    await expect(
      h.incidents.open(carrier, {
        id: createId(),
        orderId: orderA,
        type: 'retraso',
        description: 'sin viaje',
      }),
    ).rejects.toThrow('viaje');
  });
});
