import type { CatalogService } from './catalog-service.js';
import type { LotPhotoService } from './lot-photo-service.js';

export interface CatalogMaintenanceResult {
  readonly expiredLots: number;
}

/** Public maintenance use cases of catalog, run by the worker. */
export interface CatalogMaintenanceApi {
  /** Expires every published lot past its availability, in batches. */
  expireLots(): Promise<number>;
  /** Expires stale photo reservations and deletes orphan objects past the grace period. */
  purgeOrphanPhotos(): Promise<number>;
}

const BATCH_SIZE = 100;
const MAX_BATCHES = 100;

export class CatalogMaintenanceService implements CatalogMaintenanceApi {
  constructor(
    private readonly catalog: Pick<CatalogService, 'expireLots'>,
    private readonly photos: Pick<LotPhotoService, 'purgeOrphans'>,
  ) {}

  async expireLots(): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const expired = await this.catalog.expireLots(BATCH_SIZE);
      total += expired;
      // Lots that cannot expire yet (active reservations) are skipped, not counted, so a
      // short batch means there is nothing more to do in this run.
      if (expired < BATCH_SIZE) break;
    }
    return total;
  }

  purgeOrphanPhotos(): Promise<number> {
    return this.photos.purgeOrphans();
  }
}

export const CATALOG_MAINTENANCE = Symbol('CATALOG_MAINTENANCE');
