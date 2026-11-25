import { CatalogMaintenanceService } from './catalog-maintenance-service.js';

describe('CatalogMaintenanceService', () => {
  it('expires lots in batches until a short batch', async () => {
    const batches = [100, 100, 7];
    const catalog = { expireLots: jest.fn(async () => batches.shift() ?? 0) };
    const photos = { purgeOrphans: jest.fn(async () => 4) };
    const service = new CatalogMaintenanceService(catalog, photos);
    expect(await service.expireLots()).toBe(207);
    expect(catalog.expireLots).toHaveBeenCalledTimes(3);
    expect(catalog.expireLots).toHaveBeenCalledWith(100);
    expect(await service.purgeOrphanPhotos()).toBe(4);
  });

  it('stops after a bounded number of batches', async () => {
    const catalog = { expireLots: jest.fn(async () => 100) };
    const service = new CatalogMaintenanceService(catalog, { purgeOrphans: async () => 0 });
    expect(await service.expireLots()).toBe(10_000);
    expect(catalog.expireLots).toHaveBeenCalledTimes(100);
  });
});
