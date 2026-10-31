import type { CategoryProps } from '../domain/category.js';
import type { LotProps } from '../domain/lot.js';
import type { ProductProps } from '../domain/product.js';
export interface ProviderPublicSummary {
  readonly displayName: string;
  readonly municipality: string;
  readonly department: string;
}

export interface CategoryRepository {
  findById(id: string): Promise<CategoryProps | null>;
  findAll(): Promise<readonly CategoryProps[]>;
  save(category: CategoryProps): Promise<void>;
}
export interface ProductRepository {
  findById(id: string): Promise<ProductProps | null>;
  findAll(filter?: { categoryId?: string; q?: string }): Promise<readonly ProductProps[]>;
  save(product: ProductProps): Promise<void>;
}
export interface LotRepository {
  findById(id: string): Promise<LotProps | null>;
  findByIdForOwner(id: string, providerId: string): Promise<LotProps | null>;
  findMine(providerId: string): Promise<readonly LotProps[]>;
  findVisible(now: Date): Promise<readonly LotProps[]>;
  save(lot: LotProps): Promise<'created' | 'exists'>;
  update(lot: LotProps, expectedVersion: number): Promise<boolean>;
  findExpired(now: Date, limit: number): Promise<readonly LotProps[]>;
}
export interface CatalogUnitOfWork {
  run<T>(operation: () => Promise<T>): Promise<T>;
}
export interface CatalogEventWriter {
  append(
    events: readonly { aggregate: string; type: string; payload: Record<string, unknown> }[],
  ): Promise<void>;
}
export interface ProviderDirectoryPort {
  getProviderPublicSummaries(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, ProviderPublicSummary>>;
}
export interface CatalogClock {
  now(): Date;
}
export interface CatalogCursor {
  readonly version: 1;
  readonly sort: 'price' | 'distance' | 'availability' | 'recent';
  readonly key: string;
  readonly id: string;
}
export interface CatalogSearchCriteria {
  readonly limit: number;
  readonly sort: CatalogCursor['sort'];
  readonly cursor?: CatalogCursor;
  readonly categoryId?: string;
  readonly productId?: string;
  readonly q?: string;
  readonly minPrice?: number;
  readonly maxPrice?: number;
  readonly availableFrom?: Date;
  readonly availableUntil?: Date;
  readonly lat?: number;
  readonly lng?: number;
  readonly radiusKm?: number;
}
export interface CatalogSearchItem {
  readonly lot: LotProps;
  readonly distanceKm?: number;
}
export interface CatalogSearchPage {
  readonly items: readonly CatalogSearchItem[];
  readonly nextCursor?: CatalogCursor;
}

export const CATALOG_CATEGORY_REPOSITORY = Symbol('CATALOG_CATEGORY_REPOSITORY');
export const CATALOG_PRODUCT_REPOSITORY = Symbol('CATALOG_PRODUCT_REPOSITORY');
export const CATALOG_LOT_REPOSITORY = Symbol('CATALOG_LOT_REPOSITORY');
export const CATALOG_UNIT_OF_WORK = Symbol('CATALOG_UNIT_OF_WORK');
export const CATALOG_EVENT_WRITER = Symbol('CATALOG_EVENT_WRITER');
export const PROVIDER_DIRECTORY = Symbol('PROVIDER_DIRECTORY');
export const CATALOG_CLOCK = Symbol('CATALOG_CLOCK');
