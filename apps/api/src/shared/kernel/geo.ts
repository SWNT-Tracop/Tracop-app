export const COLOMBIA_BOUNDS = {
  minLat: -4.3,
  maxLat: 13.7,
  minLng: -81.8,
  maxLng: -66.9,
} as const;

if (
  COLOMBIA_BOUNDS.minLat >= COLOMBIA_BOUNDS.maxLat ||
  COLOMBIA_BOUNDS.minLng >= COLOMBIA_BOUNDS.maxLng
) {
  throw new Error('Colombia bounding box must have min < max for both axes.');
}

export const isWithinColombia = (lat: number, lng: number): boolean =>
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  lat >= COLOMBIA_BOUNDS.minLat &&
  lat <= COLOMBIA_BOUNDS.maxLat &&
  lng >= COLOMBIA_BOUNDS.minLng &&
  lng <= COLOMBIA_BOUNDS.maxLng;
