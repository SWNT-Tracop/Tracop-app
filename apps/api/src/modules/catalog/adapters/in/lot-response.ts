import type { LotProps } from '../../domain/lot.js';
import type { ProviderPublicSummary } from '../../ports/catalog-ports.js';

export const serializeLotForViewer = (
  lot: LotProps,
  provider: ProviderPublicSummary,
  viewerId: string,
  distanceKm?: number,
): Record<string, unknown> => {
  const { locationLat, locationLng, providerId, ...publicFields } = lot;
  return {
    ...publicFields,
    ...(viewerId === providerId ? { providerId } : {}),
    unitPrice: lot.unitPrice.toString(),
    provider,
    ...(viewerId === providerId ? { locationLat, locationLng } : {}),
    ...(viewerId !== providerId && distanceKm !== undefined
      ? { distanceKm: Math.max(1, Math.round(distanceKm)) }
      : {}),
  };
};
