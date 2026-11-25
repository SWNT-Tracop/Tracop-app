import type { TripProps } from './trip.js';
import type { TripStopProps } from './trip-stop.js';
import { distinctPoints, locationAccess, locationPackExpiresAt } from './trip-location.js';

const now = new Date('2026-11-25T15:00:00.000Z');
const trip: TripProps = {
  id: 'trip',
  carrierId: 'carrier',
  status: 'assigned',
  version: 2,
  plannedAt: now,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  route: [],
};
const stop: TripStopProps = {
  id: 'stop',
  tripId: 'trip',
  orderId: 'order',
  orderVersion: 1,
  kind: 'pickup',
  sequence: 1,
  zone: 'tunja',
  scheduledAt: null,
  completedAt: null,
};

describe('trip location access', () => {
  it('grants the assigned carrier, operators and admins', () => {
    for (const actor of [
      { sub: 'carrier', role: 'carrier' },
      { sub: 'o', role: 'operator' },
      { sub: 'a', role: 'admin' },
    ])
      expect(locationAccess(actor, trip, stop)).toEqual({ granted: true });
    expect(
      locationAccess({ sub: 'carrier', role: 'carrier' }, { ...trip, status: 'in_progress' }, null),
    ).toEqual({ granted: true });
  });

  it.each([
    [{ sub: 'other', role: 'carrier' }, trip, stop, 'not_allowed'],
    [{ sub: 'carrier', role: 'buyer' }, trip, stop, 'not_allowed'],
    [{ sub: 'f', role: 'finance' }, trip, stop, 'not_allowed'],
    [{ sub: 'carrier', role: 'carrier' }, null, stop, 'not_found'],
    [{ sub: 'carrier', role: 'carrier' }, { ...trip, status: 'planned' }, stop, 'trip_inactive'],
    [{ sub: 'carrier', role: 'carrier' }, { ...trip, status: 'completed' }, stop, 'trip_inactive'],
    [{ sub: 'carrier', role: 'carrier' }, { ...trip, status: 'cancelled' }, stop, 'trip_inactive'],
    [{ sub: 'carrier', role: 'carrier' }, trip, { ...stop, tripId: 'x' }, 'not_found'],
    [{ sub: 'carrier', role: 'carrier' }, trip, { ...stop, completedAt: now }, 'stop_completed'],
  ] as const)('denies %j (%s)', (actor, currentTrip, currentStop, reason) => {
    expect(locationAccess(actor, currentTrip as TripProps | null, currentStop)).toEqual({
      granted: false,
      reason,
    });
  });
});

describe('pickup points and pack expiry', () => {
  it('removes duplicates and keeps at most 20 points', () => {
    expect(
      distinctPoints([
        { lat: 5.5, lng: -73.3 },
        { lat: 5.5, lng: -73.3 },
        { lat: 5.6, lng: -73.4 },
      ]),
    ).toEqual([
      { lat: 5.5, lng: -73.3 },
      { lat: 5.6, lng: -73.4 },
    ]);
    const many = Array.from({ length: 30 }, (_, index) => ({ lat: 5 + index / 100, lng: -73 }));
    expect(distinctPoints(many)).toHaveLength(20);
  });

  it('expires at the planned end or the TTL cap, whichever comes first', () => {
    const at = (hours: number) => new Date(now.getTime() + hours * 3_600_000);
    expect(locationPackExpiresAt(now, [stop], 24)).toEqual(at(24));
    expect(locationPackExpiresAt(now, [{ ...stop, scheduledAt: at(6) }, stop], 24)).toEqual(at(6));
    expect(locationPackExpiresAt(now, [{ ...stop, scheduledAt: at(30) }], 24)).toEqual(at(24));
    expect(locationPackExpiresAt(now, [{ ...stop, scheduledAt: at(-1) }], 24)).toEqual(at(24));
  });
});
