import { Inject, Injectable } from '@nestjs/common';
import { OUTBOX_WRITER } from '../../../shared/ports/outbox-writer.js';
import type { OutboxWriter } from '../../../shared/ports/outbox-writer.js';
import { DomainError } from '../../../shared/kernel/domain-error.js';
import { Checkin } from '../domain/checkin.js';
import { Trip } from '../domain/trip.js';
import type { CheckinProps } from '../domain/checkin.js';
import type { CheckinKind } from '../domain/trip-states.js';
import {
  LOGISTICS_CHANGE_RECORDER,
  LOGISTICS_CLOCK,
  LOGISTICS_REPOSITORY,
  LOGISTICS_UNIT_OF_WORK,
  ORDERING_LOGISTICS_PORT,
  type LogisticsActor,
  type LogisticsChangeRecorder,
  type LogisticsClock,
  type LogisticsRepository,
  type LogisticsUnitOfWork,
  type OrderingLogisticsPort,
} from '../ports/logistics-ports.js';

export interface RecordCheckinInput {
  readonly id: string;
  readonly stopId: string;
  readonly kind: CheckinKind;
  readonly clientAt: Date;
  readonly mediaRef?: string;
}

const ORDER_STATUS_BY_KIND: Record<CheckinKind, 'in_transit' | 'delivered'> = {
  pickup: 'in_transit',
  delivery: 'delivered',
};

@Injectable()
export class CheckinService {
  constructor(
    @Inject(LOGISTICS_REPOSITORY) private readonly repository: LogisticsRepository,
    @Inject(ORDERING_LOGISTICS_PORT) private readonly ordering: OrderingLogisticsPort,
    @Inject(LOGISTICS_UNIT_OF_WORK) private readonly uow: LogisticsUnitOfWork,
    @Inject(LOGISTICS_CLOCK) private readonly clock: LogisticsClock,
    @Inject(LOGISTICS_CHANGE_RECORDER) private readonly changes: LogisticsChangeRecorder,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
  ) {}

  async record(
    actor: LogisticsActor,
    input: RecordCheckinInput,
    baseVersion?: number,
  ): Promise<CheckinProps> {
    if (actor.role !== 'carrier')
      throw new DomainError('Solo el transportista puede registrar check-ins.', 'invalid_role');

    return this.uow.run(async () => {
      const stop = await this.repository.findStop(input.stopId);
      if (!stop) throw new DomainError('Parada no encontrada.', 'not_found');
      // Locks the trip so check-ins and trip mutations on it are serialized.
      const trip = await this.repository.findTripForUpdate(stop.tripId);
      if (!trip || trip.carrierId !== actor.sub)
        throw new DomainError('Parada no encontrada.', 'not_found');
      if (baseVersion !== undefined && baseVersion !== trip.version) {
        const conflict = new DomainError(
          'Conflicto de versión.',
          'version_conflict',
        ) as DomainError & {
          serverVersion: number;
        };
        conflict.serverVersion = trip.version;
        throw conflict;
      }
      if (trip.status !== 'assigned' && trip.status !== 'in_progress')
        throw new DomainError('El viaje no admite check-ins.', 'invalid_transition');
      const previous = await this.repository.findCheckinByStopAndKind(stop.id, input.kind);
      if (previous) throw new DomainError('Check-in ya registrado.', 'invalid_transition');
      if (stop.completedAt)
        throw new DomainError('La parada ya fue completada.', 'invalid_transition');

      const now = this.clock.now();
      const checkin = Checkin.create({
        id: input.id,
        stopId: stop.id,
        tripId: trip.id,
        orderId: stop.orderId,
        carrierId: actor.sub,
        kind: input.kind,
        clientAt: input.clientAt,
        serverAt: now,
        mediaRef: input.mediaRef ?? null,
        stopKind: stop.kind,
      });
      const saved = await this.repository.insertCheckin(checkin.props);
      await this.repository.completeStop(stop.id, now);

      const candidate = await this.ordering.getCandidate(actor, stop.orderId);
      if (!candidate) throw new DomainError('Pedido no encontrado.', 'not_found');
      await this.ordering.transition(
        actor,
        stop.orderId,
        candidate.version,
        ORDER_STATUS_BY_KIND[input.kind],
      );

      const eventType = input.kind === 'pickup' ? 'PickupConfirmed' : 'DeliveryConfirmed';
      await this.outbox.append([
        {
          aggregate: 'checkin',
          type: eventType,
          payload: {
            checkinId: saved.id,
            stopId: stop.id,
            orderId: stop.orderId,
            tripId: trip.id,
          },
        },
      ]);
      await this.changes.record({
        entity: 'checkin',
        entityId: saved.id,
        op: 'upsert',
        payload: {
          stopId: saved.stopId,
          tripId: saved.tripId,
          orderId: saved.orderId,
          kind: saved.kind,
          clientAt: saved.clientAt.toISOString(),
          eventType,
        },
        ownerUserId: actor.sub,
        occurredAt: now,
      });

      await this.completeTripIfNeeded(trip.id, now);
      return saved;
    });
  }

  async getTripVersion(stopId: string, actor: LogisticsActor): Promise<number> {
    const stop = await this.repository.findStop(stopId);
    if (!stop) throw new DomainError('Parada no encontrada.', 'not_found');
    const trip = await this.repository.findTrip(stop.tripId);
    if (!trip || trip.carrierId !== actor.sub)
      throw new DomainError('Parada no encontrada.', 'not_found');
    return trip.version;
  }

  private async completeTripIfNeeded(tripId: string, now: Date): Promise<void> {
    const current = await this.repository.findTrip(tripId);
    if (!current) return;
    const stops = await this.repository.findStopsByTrip(tripId);
    if (stops.length === 0 || stops.some((stop) => stop.completedAt === null)) return;

    const trip = Trip.reconstitute(current);
    if (trip.props.status === 'assigned') trip.start(now);
    trip.complete(now);
    const saved = { ...trip.props, route: current.route };
    await this.repository.saveTrip(saved, current.route);
    await this.outbox.append(
      trip.drainEvents().map((event) => ({
        aggregate: 'trip',
        type: event.type,
        payload: event.payload,
      })),
    );
    await this.changes.record({
      entity: 'trip',
      entityId: saved.id,
      op: 'upsert',
      payload: { status: saved.status, version: saved.version, route: saved.route },
      ownerUserId: saved.carrierId,
      occurredAt: now,
    });
  }
}
