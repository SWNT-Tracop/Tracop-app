export const TRIP_STATES = [
  'planned',
  'assigned',
  'in_progress',
  'completed',
  'cancelled',
] as const;

export type TripStatus = (typeof TRIP_STATES)[number];

export const CHECKIN_KINDS = ['pickup', 'delivery'] as const;

export type CheckinKind = (typeof CHECKIN_KINDS)[number];

export const TRIP_TRANSITIONS: Readonly<Record<TripStatus, readonly TripStatus[]>> = {
  planned: ['assigned', 'cancelled'],
  assigned: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export const ORDER_LOGISTICS_TRANSITIONS = ['pickup_scheduled', 'in_transit', 'delivered'] as const;

export type OrderLogisticsStatus = (typeof ORDER_LOGISTICS_TRANSITIONS)[number];
