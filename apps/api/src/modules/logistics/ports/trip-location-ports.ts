import type { GeoPoint } from '../domain/trip-location.js';

/**
 * Where an order is picked up and delivered, from catalog (lot coordinates) and ordering
 * (delivery address), adapted in bootstrap. Logistics decides who may see it and stores nothing.
 */
export interface OrderLocationPort {
  pickupPoints(orderId: string): Promise<readonly GeoPoint[]>;
  deliveryAddress(orderId: string): Promise<string | null>;
}

export interface LocationRateLimitPort {
  /** Throws RateLimitExceeded when the user went over the limit. */
  consume(userId: string, now: Date): void;
}

export interface LocationSettings {
  readonly maxTtlHours: number;
}

export const ORDER_LOCATION_PORT = Symbol('ORDER_LOCATION_PORT');
export const LOCATION_RATE_LIMIT_PORT = Symbol('LOCATION_RATE_LIMIT_PORT');
export const LOCATION_SETTINGS = Symbol('LOCATION_SETTINGS');
