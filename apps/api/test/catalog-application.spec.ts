import { CatalogService } from '../src/modules/catalog/application/catalog-service.js';
import type { CategoryProps } from '../src/modules/catalog/domain/category.js';
import type { LotProps } from '../src/modules/catalog/domain/lot.js';
import type { ProductProps } from '../src/modules/catalog/domain/product.js';
import type {
  CategoryRepository,
  ProductRepository,
  LotRepository,
  CatalogUnitOfWork,
  CatalogEventWriter,
  CatalogClock,
  ProviderDirectoryPort,
} from '../src/modules/catalog/ports/catalog-ports.js';

describe('catalog application', () => {
  const categories = new Map<string, CategoryProps>();
  const products = new Map<string, ProductProps>([
    [
      'product',
      { id: 'product', categoryId: 'category', name: 'Papa', unit: 'kg', attributes: {} },
    ],
  ]);
  const lots = new Map<string, LotProps>();
  const emitted: Array<{ aggregate: string; type: string; payload: Record<string, unknown> }> = [];
  const categoryRepository: CategoryRepository = {
    findById: async (id) => categories.get(id) ?? null,
    findAll: async () => [...categories.values()],
    save: async (item) => {
      categories.set(item.id, item);
    },
  };
  const productRepository: ProductRepository = {
    findById: async (id) => products.get(id) ?? null,
    findAll: async () => [...products.values()],
    save: async (item) => {
      products.set(item.id, item);
    },
  };
  const lotRepository: LotRepository = {
    findById: async (id) => lots.get(id) ?? null,
    findByIdForOwner: async (id, owner) =>
      lots.get(id)?.providerId === owner ? lots.get(id)! : null,
    findMine: async (owner) => [...lots.values()].filter((lot) => lot.providerId === owner),
    findVisible: async (now, bounds) =>
      [...lots.values()].filter(
        (lot) =>
          lot.status === 'published' &&
          lot.availableUntil >= now &&
          (!bounds ||
            (lot.locationLat >= bounds.minLat &&
              lot.locationLat <= bounds.maxLat &&
              lot.locationLng >= bounds.minLng &&
              lot.locationLng <= bounds.maxLng)),
      ),
    save: async (item) => {
      if (lots.has(item.id)) return 'exists';
      lots.set(item.id, item);
      return 'created';
    },
    update: async (item, expected) => {
      if (lots.get(item.id)?.version !== expected) return false;
      lots.set(item.id, item);
      return true;
    },
    findExpired: async (now) =>
      [...lots.values()].filter((lot) => lot.status === 'published' && lot.availableUntil < now),
  };
  const uow: CatalogUnitOfWork = { run: async (operation) => operation() };
  const eventWriter: CatalogEventWriter = {
    append: async (events) => {
      emitted.push(...events);
    },
  };
  const clock: CatalogClock = { now: () => new Date('2026-10-30T12:00:00.000Z') };
  const directory: ProviderDirectoryPort = {
    getProviderPublicSummaries: async (ids) =>
      new Map(
        ids.map((id) => [
          id,
          { displayName: 'Finca', municipality: 'Tunja', department: 'Boyacá' },
        ]),
      ),
  };
  const service = new CatalogService(
    categoryRepository,
    productRepository,
    lotRepository,
    uow,
    eventWriter,
    clock,
    directory,
    { lotHorizonDays: 90 },
  );
  const actor = { sub: 'provider', role: 'producer' };
  const lotInput = {
    id: '018f47a2-8b45-7cc2-9a1e-123456789abc',
    productId: 'product',
    quantity: 3,
    unit: 'kg' as const,
    unitPrice: 1200n,
    qualityGrade: null,
    availableFrom: clock.now(),
    availableUntil: new Date('2026-10-31T12:00:00Z'),
    locationLat: 5.5,
    locationLng: -73.4,
  };

  beforeEach(() => {
    lots.clear();
    categories.clear();
    emitted.length = 0;
  });

  it('enforces staff/provider roles and category tree ownership', async () => {
    await expect(
      service.createCategory(actor, { id: 'c1', name: 'Raíces', parentId: null }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const staff = { sub: 'staff', role: 'operator' };
    const category = await service.createCategory(staff, {
      id: 'c1',
      name: 'Raíces',
      parentId: null,
    });
    expect(category.depth).toBe(1);
  });

  it('creates drafts idempotently for the same owner and hides another owner id as a version conflict', async () => {
    const created = await service.createLot(actor, lotInput);
    expect(created.status).toBe('draft');
    expect(await service.createLot(actor, lotInput)).toEqual(created);
    await expect(service.createLot({ ...actor, sub: 'other' }, lotInput)).rejects.toMatchObject({
      code: 'version_conflict',
    });
    await expect(service.getLot({ sub: 'other', role: 'buyer' }, created.id)).rejects.toMatchObject(
      { code: 'not_found' },
    );
  });

  it('publishes with expected version, emits one event and rejects stale updates', async () => {
    await service.createLot(actor, lotInput);
    const published = await service.publishLot(actor, lotInput.id, 1);
    expect(published.status).toBe('published');
    expect(emitted.map((item) => item.type)).toEqual(['LotPublished']);
    await expect(service.cancelLot(actor, lotInput.id, 1)).rejects.toMatchObject({
      code: 'version_conflict',
    });
  });

  it('requires provider profile at publish, not at draft creation', async () => {
    const noProfile: ProviderDirectoryPort = { getProviderPublicSummaries: async () => new Map() };
    const serviceWithoutProfile = new CatalogService(
      categoryRepository,
      productRepository,
      lotRepository,
      uow,
      eventWriter,
      clock,
      noProfile,
      { lotHorizonDays: 90 },
    );
    await serviceWithoutProfile.createLot(actor, lotInput);
    await expect(serviceWithoutProfile.publishLot(actor, lotInput.id, 1)).rejects.toMatchObject({
      code: 'profile_required',
    });
  });

  it('paginates deterministically with id tie-breaks for every sort including distance', async () => {
    const templates = [
      {
        ...lotInput,
        providerId: actor.sub,
        id: '018f47a2-8b45-7cc2-9a1e-123456789ab1',
        status: 'published' as const,
        version: 2,
        unitPrice: 1000n,
        locationLat: 5.5,
        availableFrom: new Date('2026-10-31T00:00:00Z'),
      },
      {
        ...lotInput,
        providerId: actor.sub,
        id: '018f47a2-8b45-7cc2-9a1e-123456789ab2',
        status: 'published' as const,
        version: 2,
        unitPrice: 1000n,
        locationLat: 5.5,
        availableFrom: new Date('2026-10-31T00:00:00Z'),
      },
      {
        ...lotInput,
        providerId: actor.sub,
        id: '018f47a2-8b45-7cc2-9a1e-123456789ab3',
        status: 'published' as const,
        version: 2,
        unitPrice: 2000n,
        locationLat: 5.6,
        availableFrom: new Date('2026-11-01T00:00:00Z'),
      },
    ];
    for (const item of templates) lots.set(item.id, item);
    for (const sort of ['price', 'availability', 'recent', 'distance'] as const) {
      const location = sort === 'distance' ? { lat: 5.5, lng: -73.4, radiusKm: 50 } : {};
      const first = await service.searchVisibleLots({ limit: 1, sort, ...location });
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).toBeDefined();
      const second = await service.searchVisibleLots({
        limit: 2,
        sort,
        cursor: first.nextCursor!,
        ...location,
      });
      expect(second.items.map(({ lot }) => lot.id)).not.toContain(first.items[0]!.lot.id);
    }
  });

  it('expires only lots with available_until strictly before now', async () => {
    const atBoundary = {
      ...lotInput,
      providerId: actor.sub,
      id: '018f47a2-8b45-7cc2-9a1e-123456789ab4',
      status: 'published' as const,
      version: 2,
      availableUntil: clock.now(),
    };
    const elapsed = {
      ...atBoundary,
      id: '018f47a2-8b45-7cc2-9a1e-123456789ab5',
      availableUntil: new Date(clock.now().getTime() - 1),
    };
    lots.set(atBoundary.id, atBoundary);
    lots.set(elapsed.id, elapsed);
    expect(await service.expireLots()).toBe(1);
    expect(lots.get(atBoundary.id)?.status).toBe('published');
    expect(lots.get(elapsed.id)?.status).toBe('expired');
    expect(emitted.map(({ type }) => type)).toEqual(['LotExpired']);
  });

  it('deduplicates concurrent same-owner creation and emits one event for concurrent publication', async () => {
    const [createdA, createdB] = await Promise.all([
      service.createLot(actor, lotInput),
      service.createLot(actor, lotInput),
    ]);
    expect(createdA.id).toBe(createdB.id);
    const results = await Promise.allSettled([
      service.publishLot(actor, lotInput.id, 1),
      service.publishLot(actor, lotInput.id, 1),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(emitted.filter((event) => event.type === 'LotPublished')).toHaveLength(1);
  });
});
