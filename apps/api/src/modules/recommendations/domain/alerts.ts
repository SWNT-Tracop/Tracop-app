import { DomainError } from '../../../shared/kernel/domain-error.js';
import { isWithinColombia } from '../../../shared/kernel/geo.js';

export const ALERT_MAX_RADIUS_KM = 300;
/** The alert's centre is stored rounded to 2 decimals (~1.1 km): never the buyer's exact point. */
export const roundCoordinate = (value: number): number => Math.round(value * 100) / 100;

export interface AlertProps {
  readonly id: string;
  readonly buyerId: string;
  readonly productId: string;
  readonly maxPrice: bigint;
  readonly radiusKm: number;
  readonly centerLat: number;
  readonly centerLng: number;
  readonly createdAt: Date;
}

export const newAlert = (input: {
  readonly id: string;
  readonly buyerId: string;
  readonly productId: string;
  readonly maxPrice: bigint;
  readonly radiusKm: number;
  readonly lat: number;
  readonly lng: number;
  readonly now: Date;
}): AlertProps => {
  if (input.maxPrice <= 0n)
    throw new DomainError('El precio máximo debe ser positivo.', 'invalid_price');
  if (
    !Number.isInteger(input.radiusKm) ||
    input.radiusKm < 1 ||
    input.radiusKm > ALERT_MAX_RADIUS_KM
  )
    throw new DomainError('Radio inválido.', 'invalid_radius');
  if (!isWithinColombia(input.lat, input.lng))
    throw new DomainError('Las coordenadas deben estar dentro de Colombia.', 'invalid_coordinates');
  return {
    id: input.id,
    buyerId: input.buyerId,
    productId: input.productId,
    maxPrice: input.maxPrice,
    radiusKm: input.radiusKm,
    centerLat: roundCoordinate(input.lat),
    centerLng: roundCoordinate(input.lng),
    createdAt: input.now,
  };
};

/** Great-circle distance in kilometres. */
export const haversineKm = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(lat2 - lat1);
  const dLng = radians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

export interface PublishedLotFacts {
  readonly lotId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly unitPrice: bigint;
  readonly lat: number;
  readonly lng: number;
}

/** Same product, price within the maximum, inside the radius, and not the buyer's own lot. */
export const alertMatches = (alert: AlertProps, lot: PublishedLotFacts): boolean =>
  alert.productId === lot.productId &&
  alert.buyerId !== lot.providerId &&
  lot.unitPrice <= alert.maxPrice &&
  haversineKm(alert.centerLat, alert.centerLng, lot.lat, lot.lng) <= alert.radiusKm;
