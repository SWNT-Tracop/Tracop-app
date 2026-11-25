import type { CarrierProps } from '../../domain/carrier.js';
import type { CheckinProps } from '../../domain/checkin.js';
import type { IncidentProps } from '../../domain/incident.js';
import type { PlannedStopSnapshot, TripProps } from '../../domain/trip.js';
import type { TripStopProps } from '../../domain/trip-stop.js';
import type { LogisticsRepository } from '../../ports/logistics-ports.js';

export class InMemoryLogisticsRepository implements LogisticsRepository {
  readonly carriers = new Map<string, CarrierProps>();
  readonly trips = new Map<string, TripProps>();
  readonly stops = new Map<string, TripStopProps>();
  readonly checkins = new Map<string, CheckinProps>();
  readonly incidents = new Map<string, IncidentProps>();

  async upsertCarrier(profile: CarrierProps): Promise<CarrierProps> {
    this.carriers.set(profile.userId, profile);
    return profile;
  }

  async findCarrier(userId: string): Promise<CarrierProps | null> {
    return this.carriers.get(userId) ?? null;
  }

  async listCarriers(limit: number): Promise<readonly CarrierProps[]> {
    return [...this.carriers.values()].slice(0, limit);
  }

  async createTrip(trip: TripProps, stops: readonly TripStopProps[]): Promise<TripProps> {
    this.trips.set(trip.id, trip);
    for (const stop of stops) this.stops.set(stop.id, stop);
    return trip;
  }

  async findTrip(tripId: string): Promise<TripProps | null> {
    return this.trips.get(tripId) ?? null;
  }

  async findTripForUpdate(tripId: string): Promise<TripProps | null> {
    return this.findTrip(tripId);
  }

  async listTripsByCarrier(carrierId: string, limit: number): Promise<readonly TripProps[]> {
    return [...this.trips.values()].filter((trip) => trip.carrierId === carrierId).slice(0, limit);
  }

  async listTrips(limit: number): Promise<readonly TripProps[]> {
    return [...this.trips.values()].slice(0, limit);
  }

  async saveTrip(trip: TripProps, route: readonly PlannedStopSnapshot[]): Promise<void> {
    this.trips.set(trip.id, { ...trip, route });
  }

  async findStopsByTrip(tripId: string): Promise<readonly TripStopProps[]> {
    return [...this.stops.values()]
      .filter((stop) => stop.tripId === tripId)
      .sort((left, right) => left.sequence - right.sequence);
  }

  async findStop(stopId: string): Promise<TripStopProps | null> {
    return this.stops.get(stopId) ?? null;
  }

  async findStopByOrderAndKind(
    orderId: string,
    kind: TripStopProps['kind'],
  ): Promise<TripStopProps | null> {
    return (
      [...this.stops.values()].find((stop) => stop.orderId === orderId && stop.kind === kind) ??
      null
    );
  }

  async findDeliveringCarrierId(orderId: string): Promise<string | null> {
    const stop = [...this.stops.values()].find(
      (candidate) =>
        candidate.orderId === orderId &&
        candidate.kind === 'delivery' &&
        candidate.completedAt !== null &&
        this.trips.get(candidate.tripId)?.status !== 'cancelled',
    );
    return stop ? (this.trips.get(stop.tripId)?.carrierId ?? null) : null;
  }

  async completeStop(stopId: string, at: Date): Promise<void> {
    const stop = this.stops.get(stopId);
    if (stop) this.stops.set(stopId, { ...stop, completedAt: at });
  }

  async insertCheckin(checkin: CheckinProps): Promise<CheckinProps> {
    this.checkins.set(checkin.id, checkin);
    return checkin;
  }

  async findCheckinByStopAndKind(
    stopId: string,
    kind: CheckinProps['kind'],
  ): Promise<CheckinProps | null> {
    return (
      [...this.checkins.values()].find(
        (checkin) => checkin.stopId === stopId && checkin.kind === kind,
      ) ?? null
    );
  }

  async listCheckinsByTrip(tripId: string): Promise<readonly CheckinProps[]> {
    return [...this.checkins.values()].filter((checkin) => checkin.tripId === tripId);
  }

  async findConflictingOrderIds(): Promise<readonly string[]> {
    const grouped = new Map<string, Set<string>>();
    for (const stop of this.stops.values()) {
      const trip = this.trips.get(stop.tripId);
      if (!trip || trip.status === 'cancelled' || trip.status === 'completed') continue;
      const trips = grouped.get(stop.orderId) ?? new Set<string>();
      trips.add(trip.id);
      grouped.set(stop.orderId, trips);
    }
    return [...grouped.entries()].filter(([, trips]) => trips.size > 1).map(([orderId]) => orderId);
  }

  async createIncident(incident: IncidentProps): Promise<IncidentProps> {
    this.incidents.set(incident.id, incident);
    return incident;
  }

  async resolveIncident(incidentId: string, at: Date): Promise<IncidentProps | null> {
    const incident = this.incidents.get(incidentId);
    if (!incident) return null;
    const resolved = { ...incident, status: 'resolved' as const, closedAt: at };
    this.incidents.set(incidentId, resolved);
    return resolved;
  }

  async findIncident(incidentId: string): Promise<IncidentProps | null> {
    return this.incidents.get(incidentId) ?? null;
  }

  async listIncidents(limit: number): Promise<readonly IncidentProps[]> {
    return [...this.incidents.values()].slice(0, limit);
  }

  async listIncidentsForCarrier(
    carrierId: string,
    limit: number,
  ): Promise<readonly IncidentProps[]> {
    return [...this.incidents.values()]
      .filter((incident) => {
        if (incident.tripId === null) return false;
        return this.trips.get(incident.tripId)?.carrierId === carrierId;
      })
      .slice(0, limit);
  }
}
