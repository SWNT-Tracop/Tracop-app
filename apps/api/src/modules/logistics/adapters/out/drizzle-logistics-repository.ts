import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../../../shared/infra/database.js';
import type { CarrierProps } from '../../domain/carrier.js';
import type { CheckinProps } from '../../domain/checkin.js';
import type { IncidentProps } from '../../domain/incident.js';
import type { PlannedStopSnapshot, TripProps } from '../../domain/trip.js';
import type { TripStopProps } from '../../domain/trip-stop.js';
import type { LogisticsRepository } from '../../ports/logistics-ports.js';

type Row = Record<string, unknown>;
const rows = (result: { rows: unknown[] }): readonly Row[] => result.rows as Row[];
const one = (result: { rows: unknown[] }): Row | null => rows(result)[0] ?? null;
const text = (value: unknown): string => String(value);
const nullableText = (value: unknown): string | null => (value === null ? null : String(value));
const date = (value: unknown): Date => new Date(String(value));
const nullableDate = (value: unknown): Date | null =>
  value === null ? null : new Date(String(value));
const number = (value: unknown): number => Number(value);

const toCarrier = (row: Row): CarrierProps => ({
  userId: text(row.user_id),
  vehicleType: text(row.vehicle_type),
  capacityKg: number(row.capacity_kg),
  plate: text(row.plate),
  createdAt: date(row.created_at),
  updatedAt: date(row.updated_at),
});

const toTrip = (row: Row): TripProps => ({
  id: text(row.id),
  carrierId: text(row.carrier_id),
  status: text(row.status) as TripProps['status'],
  version: number(row.version),
  plannedAt: date(row.planned_at),
  createdAt: date(row.created_at),
  updatedAt: date(row.updated_at),
  deletedAt: nullableDate(row.deleted_at),
  route: (row.route ?? []) as TripProps['route'],
});

const toStop = (row: Row): TripStopProps => ({
  id: text(row.id),
  tripId: text(row.trip_id),
  orderId: text(row.order_id),
  orderVersion: number(row.order_version),
  kind: text(row.kind) as TripStopProps['kind'],
  sequence: number(row.sequence),
  zone: text(row.zone),
  scheduledAt: nullableDate(row.scheduled_at),
  completedAt: nullableDate(row.completed_at),
});

const toCheckin = (row: Row): CheckinProps => ({
  id: text(row.id),
  stopId: text(row.stop_id),
  tripId: text(row.trip_id),
  orderId: text(row.order_id),
  carrierId: text(row.carrier_id),
  kind: text(row.kind) as CheckinProps['kind'],
  clientAt: date(row.client_ts),
  serverAt: date(row.created_at),
  mediaRef: nullableText(row.media_ref),
});

const toIncident = (row: Row): IncidentProps => ({
  id: text(row.id),
  orderId: text(row.order_id),
  tripId: nullableText(row.trip_id),
  type: text(row.type),
  description: text(row.description),
  status: text(row.status) as IncidentProps['status'],
  openedAt: date(row.opened_at),
  closedAt: nullableDate(row.closed_at),
  deletedAt: nullableDate(row.deleted_at),
});

@Injectable()
export class DrizzleLogisticsRepository implements LogisticsRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private get db() {
    return this.database.current();
  }

  async upsertCarrier(profile: CarrierProps): Promise<CarrierProps> {
    const result = await this.db.execute(sql`
      INSERT INTO logistics.carriers
        (user_id, vehicle_type, capacity_kg, plate, created_at, updated_at)
      VALUES (${profile.userId}::uuid, ${profile.vehicleType}, ${profile.capacityKg}, ${profile.plate},
              ${profile.createdAt}, ${profile.updatedAt})
      ON CONFLICT (user_id) DO UPDATE SET
        vehicle_type = EXCLUDED.vehicle_type,
        capacity_kg = EXCLUDED.capacity_kg,
        plate = EXCLUDED.plate,
        updated_at = EXCLUDED.updated_at,
        deleted_at = NULL
      RETURNING *
    `);
    return toCarrier(one(result)!);
  }

  async findCarrier(userId: string): Promise<CarrierProps | null> {
    const result = await this.db.execute(
      sql`SELECT * FROM logistics.carriers WHERE user_id = ${userId}::uuid AND deleted_at IS NULL`,
    );
    const row = one(result);
    return row ? toCarrier(row) : null;
  }

  async listCarriers(limit: number): Promise<readonly CarrierProps[]> {
    const result = await this.db.execute(
      sql`SELECT * FROM logistics.carriers WHERE deleted_at IS NULL ORDER BY user_id LIMIT ${limit}`,
    );
    return rows(result).map(toCarrier);
  }

  async createTrip(trip: TripProps, stops: readonly TripStopProps[]): Promise<TripProps> {
    const inserted = await this.db.execute(sql`
      INSERT INTO logistics.trips
        (id, carrier_id, status, version, planned_at, route, created_at, updated_at)
      VALUES (${trip.id}::uuid, ${trip.carrierId}::uuid, ${trip.status}, ${trip.version},
              ${trip.plannedAt}, ${JSON.stringify(trip.route)}::jsonb, ${trip.createdAt}, ${trip.updatedAt})
      RETURNING *
    `);
    for (const stop of stops) {
      await this.db.execute(sql`
        INSERT INTO logistics.trip_stops
          (id, trip_id, order_id, order_version, kind, sequence, zone, scheduled_at, completed_at)
        VALUES (${stop.id}::uuid, ${stop.tripId}::uuid, ${stop.orderId}::uuid, ${stop.orderVersion},
                ${stop.kind}, ${stop.sequence}, ${stop.zone}, ${stop.scheduledAt}, ${stop.completedAt})
      `);
    }
    return toTrip(one(inserted)!);
  }

  async findTrip(tripId: string): Promise<TripProps | null> {
    const result = await this.db.execute(
      sql`SELECT * FROM logistics.trips WHERE id = ${tripId}::uuid AND deleted_at IS NULL`,
    );
    const row = one(result);
    return row ? toTrip(row) : null;
  }

  async findTripForUpdate(tripId: string): Promise<TripProps | null> {
    const result = await this.db.execute(
      sql`SELECT * FROM logistics.trips WHERE id = ${tripId}::uuid AND deleted_at IS NULL FOR UPDATE`,
    );
    const row = one(result);
    return row ? toTrip(row) : null;
  }

  async listTripsByCarrier(carrierId: string, limit: number): Promise<readonly TripProps[]> {
    const result = await this.db.execute(sql`
      SELECT * FROM logistics.trips
      WHERE carrier_id = ${carrierId}::uuid AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT ${limit}
    `);
    return rows(result).map(toTrip);
  }

  async listTrips(limit: number): Promise<readonly TripProps[]> {
    const result = await this.db.execute(
      sql`SELECT * FROM logistics.trips WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ${limit}`,
    );
    return rows(result).map(toTrip);
  }

  async saveTrip(trip: TripProps, route: readonly PlannedStopSnapshot[]): Promise<void> {
    await this.db.execute(sql`
      UPDATE logistics.trips
      SET status = ${trip.status}, version = ${trip.version}, updated_at = ${trip.updatedAt},
          route = ${JSON.stringify(route)}::jsonb
      WHERE id = ${trip.id}::uuid
    `);
  }

  async findStopsByTrip(tripId: string): Promise<readonly TripStopProps[]> {
    const result = await this.db.execute(sql`
      SELECT * FROM logistics.trip_stops WHERE trip_id = ${tripId}::uuid ORDER BY sequence
    `);
    return rows(result).map(toStop);
  }

  async findStop(stopId: string): Promise<TripStopProps | null> {
    const result = await this.db.execute(
      sql`SELECT * FROM logistics.trip_stops WHERE id = ${stopId}::uuid`,
    );
    const row = one(result);
    return row ? toStop(row) : null;
  }

  async findDeliveringCarrierId(orderId: string): Promise<string | null> {
    const result = await this.db.execute(sql`
      SELECT t.carrier_id FROM logistics.trip_stops s
      JOIN logistics.trips t ON t.id = s.trip_id
      WHERE s.order_id = ${orderId}::uuid AND s.kind = 'delivery' AND s.completed_at IS NOT NULL
        AND t.deleted_at IS NULL AND t.status <> 'cancelled'
      ORDER BY s.completed_at DESC
      LIMIT 1
    `);
    const row = one(result);
    return row ? String(row.carrier_id) : null;
  }

  async findStopByOrderAndKind(
    orderId: string,
    kind: TripStopProps['kind'],
  ): Promise<TripStopProps | null> {
    const result = await this.db.execute(sql`
      SELECT s.* FROM logistics.trip_stops s
      JOIN logistics.trips t ON t.id = s.trip_id
      WHERE s.order_id = ${orderId}::uuid AND s.kind = ${kind}
        AND t.deleted_at IS NULL AND t.status NOT IN ('cancelled', 'completed')
      LIMIT 1
    `);
    const row = one(result);
    return row ? toStop(row) : null;
  }

  async completeStop(stopId: string, at: Date): Promise<void> {
    await this.db.execute(
      sql`UPDATE logistics.trip_stops SET completed_at = ${at} WHERE id = ${stopId}::uuid`,
    );
  }

  async insertCheckin(checkin: CheckinProps): Promise<CheckinProps> {
    const result = await this.db.execute(sql`
      INSERT INTO logistics.checkins
        (id, stop_id, trip_id, order_id, carrier_id, kind, client_ts, media_ref, created_at)
      VALUES (${checkin.id}::uuid, ${checkin.stopId}::uuid, ${checkin.tripId}::uuid,
              ${checkin.orderId}::uuid, ${checkin.carrierId}::uuid, ${checkin.kind},
              ${checkin.clientAt}, ${checkin.mediaRef}, ${checkin.serverAt})
      RETURNING *
    `);
    return toCheckin(one(result)!);
  }

  async findCheckinByStopAndKind(
    stopId: string,
    kind: CheckinProps['kind'],
  ): Promise<CheckinProps | null> {
    const result = await this.db.execute(sql`
      SELECT * FROM logistics.checkins WHERE stop_id = ${stopId}::uuid AND kind = ${kind} LIMIT 1
    `);
    const row = one(result);
    return row ? toCheckin(row) : null;
  }

  async listCheckinsByTrip(tripId: string): Promise<readonly CheckinProps[]> {
    const result = await this.db.execute(
      sql`SELECT * FROM logistics.checkins WHERE trip_id = ${tripId}::uuid ORDER BY created_at`,
    );
    return rows(result).map(toCheckin);
  }

  async findConflictingOrderIds(): Promise<readonly string[]> {
    const result = await this.db.execute(sql`
      SELECT s.order_id FROM logistics.trip_stops s
      JOIN logistics.trips t ON t.id = s.trip_id
      WHERE t.status IN ('planned', 'assigned', 'in_progress')
      GROUP BY s.order_id HAVING COUNT(DISTINCT t.id) > 1
    `);
    return rows(result).map((row) => text(row.order_id));
  }

  async createIncident(incident: IncidentProps): Promise<IncidentProps> {
    const result = await this.db.execute(sql`
      INSERT INTO logistics.incidents
        (id, order_id, trip_id, type, description, status, opened_at, closed_at, deleted_at)
      VALUES (${incident.id}::uuid, ${incident.orderId}::uuid, ${incident.tripId}::uuid,
              ${incident.type}, ${incident.description}, ${incident.status}, ${incident.openedAt},
              ${incident.closedAt}, ${incident.deletedAt})
      RETURNING *
    `);
    return toIncident(one(result)!);
  }

  async resolveIncident(incidentId: string, at: Date): Promise<IncidentProps | null> {
    const result = await this.db.execute(sql`
      UPDATE logistics.incidents SET status = 'resolved', closed_at = ${at}
      WHERE id = ${incidentId}::uuid AND status = 'open'
      RETURNING *
    `);
    const row = one(result);
    return row ? toIncident(row) : null;
  }

  async findIncident(incidentId: string): Promise<IncidentProps | null> {
    const result = await this.db.execute(
      sql`SELECT * FROM logistics.incidents WHERE id = ${incidentId}::uuid AND deleted_at IS NULL`,
    );
    const row = one(result);
    return row ? toIncident(row) : null;
  }

  async listIncidents(limit: number): Promise<readonly IncidentProps[]> {
    const result = await this.db.execute(
      sql`SELECT * FROM logistics.incidents WHERE deleted_at IS NULL ORDER BY opened_at DESC LIMIT ${limit}`,
    );
    return rows(result).map(toIncident);
  }

  async listIncidentsForCarrier(
    carrierId: string,
    limit: number,
  ): Promise<readonly IncidentProps[]> {
    const result = await this.db.execute(sql`
      SELECT i.* FROM logistics.incidents i
      INNER JOIN logistics.trips t ON t.id = i.trip_id
      WHERE i.deleted_at IS NULL AND t.deleted_at IS NULL
        AND t.carrier_id = ${carrierId}::uuid
      ORDER BY i.opened_at DESC
      LIMIT ${limit}
    `);
    return rows(result).map(toIncident);
  }
}
