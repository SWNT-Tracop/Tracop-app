import { isLogisticsStaff } from './logistics-staff.js';
import type { TripProps } from './trip.js';
import type { TripStopProps } from './trip-stop.js';

export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

export const MAX_PICKUP_POINTS = 20;

export type LocationDenial = 'not_found' | 'not_allowed' | 'trip_inactive' | 'stop_completed';

/**
 * Who may see where a stop is: the trip's assigned carrier and the staff, only while the trip is
 * assigned or in progress and the stop is not completed yet (ADR-013).
 */
export const locationAccess = (
  actor: { readonly sub: string; readonly role: string },
  trip: TripProps | null,
  stop: TripStopProps | null,
): { readonly granted: true } | { readonly granted: false; readonly reason: LocationDenial } => {
  if (!trip) return { granted: false, reason: 'not_found' };
  const isAssignedCarrier = actor.role === 'carrier' && trip.carrierId === actor.sub;
  if (!isAssignedCarrier && !isLogisticsStaff(actor.role))
    return { granted: false, reason: 'not_allowed' };
  if (trip.status !== 'assigned' && trip.status !== 'in_progress')
    return { granted: false, reason: 'trip_inactive' };
  if (stop === null) return { granted: true };
  if (stop.tripId !== trip.id) return { granted: false, reason: 'not_found' };
  if (stop.completedAt !== null) return { granted: false, reason: 'stop_completed' };
  return { granted: true };
};

/** Distinct pickup points (an order may span several lots), at most MAX_PICKUP_POINTS. */
export const distinctPoints = (points: readonly GeoPoint[]): readonly GeoPoint[] => {
  const seen = new Set<string>();
  const distinct: GeoPoint[] = [];
  for (const point of points) {
    const key = `${point.lat}|${point.lng}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push({ lat: point.lat, lng: point.lng });
    if (distinct.length === MAX_PICKUP_POINTS) break;
  }
  return distinct;
};

/**
 * When a downloaded location pack must be discarded: the latest scheduled time of the pending
 * stops (the trip's planned end), capped at maxTtlHours from now. Trips have no planned end yet
 * (stops are created unscheduled), so today it is now + maxTtlHours.
 */
export const locationPackExpiresAt = (
  now: Date,
  pendingStops: readonly TripStopProps[],
  maxTtlHours: number,
): Date => {
  const cap = now.getTime() + maxTtlHours * 3_600_000;
  const scheduled = pendingStops
    .map((stop) => stop.scheduledAt?.getTime())
    .filter((time): time is number => time !== undefined && time > now.getTime());
  return new Date(scheduled.length ? Math.min(cap, Math.max(...scheduled)) : cap);
};
