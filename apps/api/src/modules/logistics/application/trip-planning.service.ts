import { Inject, Injectable } from '@nestjs/common';
import { OUTBOX_WRITER } from '../../../shared/ports/outbox-writer.js';
import { AUDIT_WRITER, type AuditWriter } from '../../../shared/ports/audit-writer.js';
import type { OutboxWriter } from '../../../shared/ports/outbox-writer.js';
import { DomainError } from '../../../shared/kernel/domain-error.js';
import { createId } from '../../../shared/kernel/ids.js';
import { Trip } from '../domain/trip.js';
import { TripStop } from '../domain/trip-stop.js';
import {
  recommendStops,
  zoneFromAddress,
  type PickupCandidate,
  type RecommendedStop,
} from '../domain/recommendation.js';
import type { PlannedStopSnapshot, TripProps } from '../domain/trip.js';
import type { TripStopProps } from '../domain/trip-stop.js';
import type { LogisticsEvent } from '../domain/logistics-events.js';
import {
  LOGISTICS_CHANGE_RECORDER,
  LOGISTICS_CLOCK,
  LOGISTICS_REPOSITORY,
  LOGISTICS_UNIT_OF_WORK,
  ORDERING_LOGISTICS_PORT,
  PROVIDER_ZONE_PORT,
  type LogisticsActor,
  type LogisticsChangeRecorder,
  type LogisticsClock,
  type LogisticsRepository,
  type LogisticsUnitOfWork,
  type OrderingLogisticsPort,
  type ProviderZonePort,
} from '../ports/logistics-ports.js';

export interface CreateTripInput {
  readonly id: string;
  readonly orderIds: readonly string[];
}

export interface LogisticsOrderCandidate {
  readonly orderId: string;
  readonly status: 'paid';
  readonly version: number;
  readonly deliveryZone: string;
  readonly deliveryWindow: string | null;
  readonly pickupZones: readonly string[];
  readonly lines: readonly {
    readonly lotId: string;
    readonly quantityMilli: string;
    readonly unit: string;
  }[];
}

@Injectable()
export class TripPlanningService {
  constructor(
    @Inject(LOGISTICS_REPOSITORY) private readonly repository: LogisticsRepository,
    @Inject(ORDERING_LOGISTICS_PORT) private readonly ordering: OrderingLogisticsPort,
    @Inject(PROVIDER_ZONE_PORT) private readonly providerZones: ProviderZonePort,
    @Inject(LOGISTICS_UNIT_OF_WORK) private readonly uow: LogisticsUnitOfWork,
    @Inject(LOGISTICS_CLOCK) private readonly clock: LogisticsClock,
    @Inject(LOGISTICS_CHANGE_RECORDER) private readonly changes: LogisticsChangeRecorder,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    // Injected by Nest (global backoffice module); the default only serves hand-built tests.
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter = { record: async () => undefined },
  ) {}

  async recommend(actor: LogisticsActor, limit = 50): Promise<readonly RecommendedStop[]> {
    this.requireCarrierOrOperator(actor);
    const candidates = await this.ordering.listPickupCandidates(
      actor,
      Math.min(Math.max(limit, 1), 200),
    );
    return this.buildRecommendation(candidates);
  }

  async listOrderCandidates(
    actor: LogisticsActor,
    limit = 50,
  ): Promise<readonly LogisticsOrderCandidate[]> {
    this.requireCarrierOrOperator(actor);
    const candidates = await this.ordering.listPickupCandidates(
      actor,
      Math.min(Math.max(limit, 1), 200),
    );
    const providerIds = [
      ...new Set(candidates.flatMap((candidate) => candidate.lines.map((line) => line.providerId))),
    ];
    const zones = await this.providerZones.getZones(providerIds);
    return candidates.map((candidate) => {
      const pickupZones = [
        ...new Set(candidate.lines.map((line) => zones.get(line.providerId) ?? 'sin-zona')),
      ];
      return {
        orderId: candidate.orderId,
        status: 'paid',
        version: candidate.version,
        deliveryZone: zoneFromAddress(candidate.deliveryAddress),
        deliveryWindow: candidate.deliveryWindow,
        pickupZones,
        lines: candidate.lines.map((line) => ({
          lotId: line.lotId,
          quantityMilli: line.quantityMilli.toString(),
          unit: line.unit,
        })),
      };
    });
  }

  async createTrip(actor: LogisticsActor, input: CreateTripInput): Promise<TripProps> {
    this.requireCarrier(actor);
    if (input.orderIds.length === 0)
      throw new DomainError('El viaje debe incluir pedidos.', 'empty_trip');
    if (new Set(input.orderIds).size !== input.orderIds.length)
      throw new DomainError('Pedidos duplicados en el viaje.', 'duplicate_order');

    const carrier = await this.repository.findCarrier(actor.sub);
    if (!carrier)
      throw new DomainError('Perfil de transportista requerido.', 'carrier_profile_required');

    return this.uow.run(async () => {
      const now = this.clock.now();
      const candidates = await Promise.all(
        input.orderIds.map(async (orderId) => {
          const candidate = await this.ordering.getCandidate(actor, orderId);
          if (!candidate) throw new DomainError('Pedido no encontrado.', 'not_found');
          if (candidate.status !== 'paid')
            throw new DomainError('El pedido no está listo para recogida.', 'invalid_order_status');
          const pickup = await this.repository.findStopByOrderAndKind(orderId, 'pickup');
          const delivery = await this.repository.findStopByOrderAndKind(orderId, 'delivery');
          if (pickup || delivery)
            throw new DomainError(
              'El pedido ya está asignado a otro viaje.',
              'assignment_conflict',
            );
          return candidate;
        }),
      );

      const recommendation = await this.buildRecommendation(candidates);
      const versionByOrder = new Map(
        candidates.map((candidate) => [candidate.orderId, candidate.version]),
      );
      const route: PlannedStopSnapshot[] = recommendation.map((stop) => ({
        stopId: createId(),
        orderId: stop.orderId,
        kind: stop.kind,
        sequence: stop.sequence,
        zone: stop.zone,
      }));

      const trip = Trip.create({
        id: input.id,
        carrierId: carrier.userId,
        status: 'planned',
        version: 1,
        plannedAt: now,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        route,
      });
      const stops = route.map((stop) =>
        TripStop.create({
          id: stop.stopId,
          tripId: trip.props.id,
          orderId: stop.orderId,
          orderVersion: versionByOrder.get(stop.orderId)!,
          kind: stop.kind,
          sequence: stop.sequence,
          zone: stop.zone,
          scheduledAt: null,
          completedAt: null,
        }),
      );

      trip.assign(carrier.userId, now);
      const created = await this.repository.createTrip(
        trip.props,
        stops.map((stop) => stop.props),
      );
      for (const candidate of candidates)
        await this.ordering.transition(
          actor,
          candidate.orderId,
          candidate.version,
          'pickup_scheduled',
        );

      const events = trip.drainEvents();
      await this.publish(trip.props, events);
      return created;
    });
  }

  async assign(
    actor: LogisticsActor,
    tripId: string,
    expectedVersion: number,
    carrierId?: string,
  ): Promise<TripProps> {
    const target = carrierId ?? actor.sub;
    if (actor.role !== 'operator' && target !== actor.sub)
      throw new DomainError('Solo el operador puede reasignar viajes.', 'invalid_role');
    return this.mutateTrip(
      actor,
      tripId,
      expectedVersion,
      (trip, now) => {
        if (actor.role === 'operator') trip.reassign(target, now);
        else trip.assign(target, now);
      },
      'trip.reassign',
    );
  }

  async start(actor: LogisticsActor, tripId: string, expectedVersion: number): Promise<TripProps> {
    return this.mutateTrip(actor, tripId, expectedVersion, (trip, now) => trip.start(now));
  }

  async complete(
    actor: LogisticsActor,
    tripId: string,
    expectedVersion: number,
  ): Promise<TripProps> {
    return this.mutateTrip(actor, tripId, expectedVersion, (trip, now) => trip.complete(now));
  }

  async cancel(
    actor: LogisticsActor,
    tripId: string,
    expectedVersion: number,
    reason: string,
  ): Promise<TripProps> {
    return this.mutateTrip(
      actor,
      tripId,
      expectedVersion,
      (trip, now) => trip.cancel(now, reason),
      'trip.cancel',
    );
  }

  async listMine(actor: LogisticsActor, limit = 50): Promise<readonly TripProps[]> {
    this.requireCarrier(actor);
    return this.repository.listTripsByCarrier(actor.sub, Math.min(Math.max(limit, 1), 200));
  }

  async listAll(actor: LogisticsActor, limit = 50): Promise<readonly TripProps[]> {
    this.requireOperator(actor);
    return this.repository.listTrips(Math.min(Math.max(limit, 1), 200));
  }

  async findById(actor: LogisticsActor, tripId: string): Promise<TripProps> {
    this.requireCarrierOrOperator(actor);
    const trip = await this.repository.findTrip(tripId);
    if (!trip) throw new DomainError('Viaje no encontrado.', 'not_found');
    if (actor.role !== 'operator' && trip.carrierId !== actor.sub)
      throw new DomainError('Viaje no encontrado.', 'not_found');
    return trip;
  }

  async listStops(actor: LogisticsActor, tripId: string): Promise<readonly TripStopProps[]> {
    await this.findById(actor, tripId);
    return this.repository.findStopsByTrip(tripId);
  }

  /** Who delivered an order, for settling the freight; internal (no actor). */
  async findDeliveringCarrier(orderId: string): Promise<string | null> {
    return this.repository.findDeliveringCarrierId(orderId);
  }

  async resolveConflicts(actor: LogisticsActor): Promise<readonly string[]> {
    this.requireOperator(actor);
    return this.repository.findConflictingOrderIds();
  }

  private async buildRecommendation(
    candidates: readonly Awaited<ReturnType<OrderingLogisticsPort['getCandidate']>>[],
  ): Promise<readonly RecommendedStop[]> {
    const available = candidates.filter((candidate): candidate is NonNullable<typeof candidate> =>
      Boolean(candidate),
    );
    const providers = [...new Set(available.map((candidate) => candidate.providerId))];
    const zones = await this.providerZones.getZones(providers);
    const pickupCandidates: PickupCandidate[] = available.map((candidate) => ({
      orderId: candidate.orderId,
      providerId: candidate.providerId,
      pickupZone: zones.get(candidate.providerId) ?? 'sin-zona',
      deliveryZone: zoneFromAddress(candidate.deliveryAddress),
      deliveryWindow: candidate.deliveryWindow,
    }));
    return recommendStops(pickupCandidates);
  }

  private async mutateTrip(
    actor: LogisticsActor,
    tripId: string,
    expectedVersion: number,
    mutation: (trip: Trip, now: Date) => void,
    /** Recorded in the audit log when an operator (staff) performs the change. */
    operatorAuditAction?: string,
  ): Promise<TripProps> {
    this.requireCarrierOrOperator(actor);
    return this.uow.run(async () => {
      // The row lock makes the version check and the write atomic for concurrent mutations.
      const current = await this.repository.findTripForUpdate(tripId);
      if (!current) throw new DomainError('Viaje no encontrado.', 'not_found');
      if (actor.role !== 'operator' && current.carrierId !== actor.sub)
        throw new DomainError('Viaje no encontrado.', 'not_found');
      if (current.version !== expectedVersion) {
        const conflict = new DomainError(
          'Conflicto de versión.',
          'version_conflict',
        ) as DomainError & {
          serverVersion: number;
        };
        conflict.serverVersion = current.version;
        throw conflict;
      }
      const trip = Trip.reconstitute(current);
      mutation(trip, this.clock.now());
      const saved = { ...trip.props, route: current.route };
      await this.repository.saveTrip(saved, current.route);
      const events = trip.drainEvents();
      await this.publish(saved, events);
      if (operatorAuditAction && actor.role === 'operator')
        await this.audit.record({
          actorId: actor.sub,
          actorRole: actor.role,
          action: operatorAuditAction,
          entity: 'trip',
          entityId: tripId,
          before: { status: current.status, carrierId: current.carrierId },
          after: { status: saved.status, carrierId: saved.carrierId },
        });
      return saved;
    });
  }

  private async publish(trip: TripProps, events: readonly LogisticsEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.outbox.append(
      events.map((event) => ({ aggregate: 'trip', type: event.type, payload: event.payload })),
    );
    await this.changes.record({
      entity: 'trip',
      entityId: trip.id,
      op: 'upsert',
      payload: { status: trip.status, version: trip.version, route: trip.route },
      ownerUserId: trip.carrierId,
      occurredAt: new Date(events[events.length - 1]!.occurredAt),
    });
  }

  private requireCarrier(actor: LogisticsActor): void {
    if (actor.role !== 'carrier') throw new DomainError('Solo transportistas.', 'invalid_role');
  }

  private requireOperator(actor: LogisticsActor): void {
    if (actor.role !== 'operator')
      throw new DomainError('Solo el operador puede resolver conflictos.', 'invalid_role');
  }

  private requireCarrierOrOperator(actor: LogisticsActor): void {
    if (actor.role !== 'carrier' && actor.role !== 'operator')
      throw new DomainError('Rol no autorizado.', 'invalid_role');
  }
}
