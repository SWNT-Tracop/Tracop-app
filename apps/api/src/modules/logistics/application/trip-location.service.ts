import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../../shared/kernel/domain-error.js';
import { AUDIT_WRITER, type AuditWriter } from '../../../shared/ports/audit-writer.js';
import {
  distinctPoints,
  locationAccess,
  locationPackExpiresAt,
  type GeoPoint,
} from '../domain/trip-location.js';
import type { TripStopProps } from '../domain/trip-stop.js';
import {
  LOGISTICS_CLOCK,
  LOGISTICS_REPOSITORY,
  type LogisticsActor,
  type LogisticsClock,
  type LogisticsRepository,
} from '../ports/logistics-ports.js';
import {
  LOCATION_RATE_LIMIT_PORT,
  LOCATION_SETTINGS,
  ORDER_LOCATION_PORT,
  type LocationRateLimitPort,
  type LocationSettings,
  type OrderLocationPort,
} from '../ports/trip-location-ports.js';

export interface StopLocation {
  readonly stopId: string;
  readonly kind: 'pickup' | 'delivery';
  readonly orderId: string;
  /** Pickup: the distinct lot coordinates of the order. */
  readonly points?: readonly GeoPoint[];
  /** Delivery: the order's full address. */
  readonly address?: string;
}

export interface LocationPack {
  readonly tripId: string;
  readonly expiresAt: Date;
  readonly stops: readonly StopLocation[];
}

/**
 * Exact pickup and delivery locations for the trip's assigned carrier and the staff (ADR-013).
 * Every authenticated request is audited as location.view, granted or denied, without the
 * location itself; anyone not allowed gets the same 404 as for a missing trip or stop.
 */
@Injectable()
export class TripLocationService {
  constructor(
    @Inject(LOGISTICS_REPOSITORY) private readonly repository: LogisticsRepository,
    @Inject(ORDER_LOCATION_PORT) private readonly locations: OrderLocationPort,
    @Inject(LOCATION_RATE_LIMIT_PORT) private readonly rateLimit: LocationRateLimitPort,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(LOGISTICS_CLOCK) private readonly clock: LogisticsClock,
    @Inject(LOCATION_SETTINGS) private readonly settings: LocationSettings,
  ) {}

  async stopLocation(actor: LogisticsActor, tripId: string, stopId: string): Promise<StopLocation> {
    this.rateLimit.consume(actor.sub, this.clock.now());
    const trip = await this.repository.findTrip(tripId);
    const stop = await this.repository.findStop(stopId);
    const granted = stop !== null && locationAccess(actor, trip, stop).granted;
    await this.record(actor, tripId, { scope: 'stop', stopId }, granted);
    if (!granted || !stop) throw new DomainError('Parada no encontrada.', 'not_found');
    return this.resolve(stop);
  }

  async locationPack(actor: LogisticsActor, tripId: string): Promise<LocationPack> {
    const now = this.clock.now();
    this.rateLimit.consume(actor.sub, now);
    const trip = await this.repository.findTrip(tripId);
    const access = locationAccess(actor, trip, null);
    await this.record(actor, tripId, { scope: 'pack' }, access.granted);
    if (!access.granted) throw new DomainError('Viaje no encontrado.', 'not_found');
    const pending = (await this.repository.findStopsByTrip(tripId)).filter(
      (stop) => stop.completedAt === null,
    );
    return {
      tripId,
      expiresAt: locationPackExpiresAt(now, pending, this.settings.maxTtlHours),
      stops: await Promise.all(pending.map((stop) => this.resolve(stop))),
    };
  }

  private async resolve(stop: TripStopProps): Promise<StopLocation> {
    const base = { stopId: stop.id, kind: stop.kind, orderId: stop.orderId };
    if (stop.kind === 'pickup')
      return { ...base, points: distinctPoints(await this.locations.pickupPoints(stop.orderId)) };
    const address = await this.locations.deliveryAddress(stop.orderId);
    return address === null ? base : { ...base, address };
  }

  /** Never the coordinates or the address: who looked, at which trip/stop, and the outcome. */
  private async record(
    actor: LogisticsActor,
    tripId: string,
    target: { readonly scope: 'stop' | 'pack'; readonly stopId?: string },
    granted: boolean,
  ): Promise<void> {
    await this.audit.record({
      actorId: actor.sub,
      actorRole: actor.role,
      action: 'location.view',
      entity: 'trip',
      entityId: tripId,
      before: null,
      after: { ...target, result: granted ? 'granted' : 'denied' },
    });
  }
}
