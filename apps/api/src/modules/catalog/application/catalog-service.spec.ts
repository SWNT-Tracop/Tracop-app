import { CatalogService } from './catalog-service.js';
import type {
  CategoryRepository,
  ProductRepository,
  LotRepository,
} from '../ports/catalog-ports.js';
import type { CategoryProps } from '../domain/category.js';
import type { ProductProps } from '../domain/product.js';
import type { LotProps } from '../domain/lot.js';

const NOW = new Date('2026-10-30T12:00:00.000Z');
const categories: CategoryProps[] = [
  { id: 'root', name: 'Frutas', parentId: null, depth: 1 },
  { id: 'child', name: 'Tropicales', parentId: 'root', depth: 2 },
];
const products: ProductProps[] = [
  { id: 'mango', categoryId: 'child', name: 'Mango Tommy', unit: 'kg', attributes: {} },
  { id: 'papa', categoryId: 'root', name: 'Papa pastusa', unit: 'kg', attributes: {} },
];
const lot = (
  id: string,
  productId: string,
  unitPrice: bigint,
  lat = 5.5,
  lng = -73.4,
): LotProps => ({
  id,
  providerId: 'provider-1',
  productId,
  quantity: 1250, // quantityMilli: 1,250 (numeric(12,3) integer representation)
  unit: 'kg',
  unitPrice,
  qualityGrade: null,
  availableFrom: new Date('2026-10-30T00:00:00.000Z'),
  availableUntil: new Date('2026-11-02T00:00:00.000Z'),
  locationLat: lat,
  locationLng: lng,
  status: 'published',
  version: 2,
});

describe('CatalogService search', () => {
  const findVisible = jest.fn();
  const findAllProducts = jest.fn();
  const findAllCategories = jest.fn();
  let service: CatalogService;

  beforeEach(() => {
    jest.clearAllMocks();
    findVisible.mockResolvedValue([]);
    findAllProducts.mockResolvedValue(products);
    findAllCategories.mockResolvedValue(categories);
    service = new CatalogService(
      {
        findById: jest.fn(),
        findAll: findAllCategories,
        save: jest.fn(),
      } as unknown as CategoryRepository,
      {
        findById: jest.fn(),
        findAll: findAllProducts,
        save: jest.fn(),
      } as unknown as ProductRepository,
      { findVisible } as unknown as LotRepository,
      { run: jest.fn() } as never,
      { append: jest.fn() } as never,
      { now: () => NOW },
      { getProviderPublicSummaries: jest.fn() },
      { lotHorizonDays: 30 },
    );
  });

  it('filters by normalized multi-token query, descendant category, price and availability', async () => {
    findVisible.mockResolvedValue([
      lot('lot-1', 'mango', 2500n),
      lot('lot-2', 'mango', 4000n),
      lot('lot-3', 'papa', 2000n),
    ]);
    const result = await service.searchVisibleLots({
      limit: 10,
      sort: 'price',
      categoryId: 'root',
      q: 'MÁNGO tommy',
      minPrice: 2000,
      maxPrice: 3000,
      availableFrom: new Date('2026-11-01T00:00:00.000Z'),
    });
    expect(result.items.map(({ lot: item }) => item.id)).toEqual(['lot-1']);
    expect(findAllCategories).toHaveBeenCalled();
  });

  it('sorts by price with stable cursor pagination and applies geographic radius', async () => {
    findVisible.mockResolvedValue([
      lot('lot-c', 'mango', 3000n, 5.51, -73.4),
      lot('lot-a', 'mango', 1000n, 5.5, -73.4),
      lot('lot-b', 'mango', 2000n, 5.5, -73.4),
      lot('lot-far', 'mango', 10n, 8.5, -73.4),
    ]);
    const first = await service.searchVisibleLots({
      limit: 1,
      sort: 'price',
      lat: 5.5,
      lng: -73.4,
      radiusKm: 10,
    });
    expect(first.items.map(({ lot: item }) => item.id)).toEqual(['lot-a']);
    expect(first.items[0]?.distanceKm).toBe(0);
    expect(first.nextCursor).toEqual({ version: 1, sort: 'price', key: '1000', id: 'lot-a' });
    const second = await service.searchVisibleLots({
      limit: 1,
      sort: 'price',
      lat: 5.5,
      lng: -73.4,
      radiusKm: 10,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    });
    expect(second.items.map(({ lot: item }) => item.id)).toEqual(['lot-b']);
  });

  it('returns a recent-sorted page when distance sort lacks coordinates and excludes unknown products', async () => {
    findVisible.mockResolvedValue([
      lot('lot-a', 'mango', 100n),
      lot('lot-z', 'mango', 100n),
      lot('orphan', 'missing', 1n),
    ]);
    const result = await service.searchVisibleLots({ limit: 5, sort: 'distance' });
    expect(result.items.map(({ lot: item }) => item.id)).toEqual(['lot-z', 'lot-a']);
    expect(result.items.every((item) => item.distanceKm === undefined)).toBe(true);
  });

  it('passes computed bounding bounds to the repository when all location inputs are provided', async () => {
    await service.searchVisibleLots({
      limit: 10,
      sort: 'availability',
      lat: 5,
      lng: -73,
      radiusKm: 5,
    });
    expect(findVisible).toHaveBeenCalledWith(
      NOW,
      expect.objectContaining({ minLat: expect.any(Number), maxLng: expect.any(Number) }),
    );
  });
});
