import type { CarrierProps } from '../domain/carrier.js';
import type { CheckinProps } from '../domain/checkin.js';
import type { IncidentProps } from '../domain/incident.js';
import type { PlannedStopSnapshot, TripProps } from '../domain/trip.js';
import type { TripStopProps } from '../domain/trip-stop.js';
import type { OrderLogisticsStatus } from '../domain/trip-states.js';

export interface LogisticsActor {
  readonly sub: string;
  readonly role: string;
}

export interface OrderCandidate {
  readonly orderId: string;
  readonly providerId: string;
  readonly status: string;
  readonly version: number;
  readonly deliveryAddress: string;
  readonly deliveryWindow: string | null;
  readonly lines: readonly {
    readonly lotId: string;
    readonly providerId: string;
    readonly quantityMilli: bigint;
    readonly unit: string;
  }[];
}

export interface LogisticsRepository {
  upsertCarrier(profile: CarrierProps): Promise<CarrierProps>;
  findCarrier(userId: string): Promise<CarrierProps | null>;
  listCarriers(limit: number): Promise<readonly CarrierProps[]>;
  createTrip(trip: TripProps, stops: readonly TripStopProps[]): Promise<TripProps>;
  findTrip(tripId: string): Promise<TripProps | null>;
  listTripsByCarrier(carrierId: string, limit: number): Promise<readonly TripProps[]>;
  listTrips(limit: number): Promise<readonly TripProps[]>;
  saveTrip(trip: TripProps, route: readonly PlannedStopSnapshot[]): Promise<void>;
  findStopsByTrip(tripId: string): Promise<readonly TripStopProps[]>;
  findStop(stopId: string): Promise<TripStopProps | null>;
  findStopByOrderAndKind(
    orderId: string,
    kind: TripStopProps['kind'],
  ): Promise<TripStopProps | null>;
  completeStop(stopId: string, at: Date): Promise<void>;
  insertCheckin(checkin: CheckinProps): Promise<CheckinProps>;
  findCheckinByStopAndKind(
    stopId: string,
    kind: CheckinProps['kind'],
  ): Promise<CheckinProps | null>;
  listCheckinsByTrip(tripId: string): Promise<readonly CheckinProps[]>;
  findConflictingOrderIds(): Promise<readonly string[]>;
  createIncident(incident: IncidentProps): Promise<IncidentProps>;
  resolveIncident(incidentId: string, at: Date): Promise<IncidentProps | null>;
  findIncident(incidentId: string): Promise<IncidentProps | null>;
  listIncidents(limit: number): Promise<readonly IncidentProps[]>;
  listIncidentsForCarrier(carrierId: string, limit: number): Promise<readonly IncidentProps[]>;
}

export interface LogisticsClock {
  now(): Date;
}

export interface LogisticsUnitOfWork {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export interface ChangeInput {
  readonly entity: string;
  readonly entityId: string;
  readonly op: string;
  readonly payload: Record<string, unknown>;
  readonly ownerUserId: string | null;
  readonly occurredAt: Date;
}

export interface LogisticsChangeRecorder {
  record(change: ChangeInput): Promise<string>;
}

export interface OrderingLogisticsPort {
  listPickupCandidates(actor: LogisticsActor, limit: number): Promise<readonly OrderCandidate[]>;
  getCandidate(actor: LogisticsActor, orderId: string): Promise<OrderCandidate | null>;
  transition(
    actor: LogisticsActor,
    orderId: string,
    expectedVersion: number,
    next: OrderLogisticsStatus,
  ): Promise<void>;
}

export interface ProviderZonePort {
  getZones(providerIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

export const LOGISTICS_REPOSITORY = Symbol('LOGISTICS_REPOSITORY');
export const LOGISTICS_CLOCK = Symbol('LOGISTICS_CLOCK');
export const LOGISTICS_UNIT_OF_WORK = Symbol('LOGISTICS_UNIT_OF_WORK');
export const LOGISTICS_CHANGE_RECORDER = Symbol('LOGISTICS_CHANGE_RECORDER');
export const ORDERING_LOGISTICS_PORT = Symbol('ORDERING_LOGISTICS_PORT');
export const PROVIDER_ZONE_PORT = Symbol('PROVIDER_ZONE_PORT');
