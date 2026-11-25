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
  lockForProductProposal(categoryId: string, searchText: string): Promise<void>;
  lockPendingLimitByUser(userId: string): Promise<void>;
  findExactVisible(
    categoryId: string,
    searchText: string,
    viewerId: string,
    viewerRole: string,
  ): Promise<ProductProps | null>;
  /** Approved products of the category plus the pending ones the viewer may see. */
  findVisibleInCategory(
    categoryId: string,
    viewerId: string,
    viewerRole: string,
  ): Promise<readonly ProductProps[]>;
  /** Whether any approved or pending product (visible or not) already uses this name. */
  existsActiveBySearchText(categoryId: string, searchText: string): Promise<boolean>;
  countPendingByUser(userId: string): Promise<number>;
  findPending(viewerId: string, viewerRole: string): Promise<readonly ProductProps[]>;
}
export interface LotRepository {
  findById(id: string): Promise<LotProps | null>;
  findByIdForOwner(id: string, providerId: string): Promise<LotProps | null>;
  findMine(providerId: string): Promise<readonly LotProps[]>;
  findVisible(
    now: Date,
    bounds?: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  ): Promise<readonly (LotProps & { readonly availableQuantityMilli?: bigint })[]>;
  save(lot: LotProps): Promise<'created' | 'exists'>;
  update(lot: LotProps, expectedVersion: number): Promise<boolean>;
  findExpired(now: Date, limit: number): Promise<readonly LotProps[]>;
  findAllForChangeBackfill(): Promise<readonly LotProps[]>;
  softDelete(lot: LotProps, expectedVersion: number, deletedAt: Date): Promise<boolean>;
  lockForReservation(lotIds: readonly string[]): Promise<readonly LotProps[]>;
  getAvailableQuantity(lotId: string, now: Date): Promise<bigint>;
  findOrderReservationLotIds(orderId: string): Promise<readonly string[]>;
  reserveStock(input: {
    lotId: string;
    orderId: string;
    quantityMilli: bigint;
    expiresAt: Date;
    now: Date;
  }): Promise<'created' | 'exists'>;
  releaseOrderReservations(orderId: string, now: Date): Promise<readonly string[]>;
  findExpiredReservationOrderIds(now: Date, limit: number): Promise<readonly string[]>;
  /** Removes the expiry of the order's live reservations; returns how many were held. */
  holdOrderReservations(orderId: string, now: Date): Promise<number>;
  /** Gives held reservations an expiry again; returns how many changed. */
  resumeOrderReservationExpiry(orderId: string, expiresAt: Date, now: Date): Promise<number>;
  /** Marks held reservations as consumed; returns the affected lot ids, sorted. */
  consumeOrderReservations(orderId: string, now: Date): Promise<readonly string[]>;
  countActiveOrderReservations(orderId: string): Promise<number>;
  isOrderReservationExpired(orderId: string, now: Date): Promise<boolean>;
  getConsumedQuantity(lotId: string): Promise<bigint>;
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
export interface ChangeRecorderPort {
  record(change: {
    readonly entity: 'lot' | 'category' | 'product';
    readonly entityId: string;
    readonly op: string;
    readonly payload: Record<string, unknown>;
    readonly ownerUserId: string | null;
    readonly occurredAt: Date;
  }): Promise<string>;
  recordBaselineIfAbsent(change: {
    readonly entity: 'lot' | 'category' | 'product';
    readonly entityId: string;
    readonly op: string;
    readonly payload: Record<string, unknown>;
    readonly ownerUserId: string | null;
    readonly occurredAt: Date;
  }): Promise<string | null>;
}

export interface LotQuoteSnapshot {
  readonly id: string;
  readonly providerId: string;
  readonly unit: string;
  readonly unitPrice: bigint;
  readonly availableUntil: Date;
  readonly status: string;
  readonly availableQuantityMilli: bigint;
}

export interface CatalogOrderingApi {
  getLotQuote(lotId: string): Promise<LotQuoteSnapshot>;
  reserveLots(input: {
    readonly orderId: string;
    readonly lines: readonly { readonly lotId: string; readonly quantityMilli: bigint }[];
    readonly expiresAt: Date;
  }): Promise<void>;
  releaseOrderReservations(orderId: string): Promise<void>;
  findExpiredReservationOrderIds(now: Date, limit: number): Promise<readonly string[]>;
  /**
   * Exact pickup coordinates of the given lots (deleted lots included: they may still be picked
   * up). Not exposed by any controller; logistics decides who may see them.
   */
  getLotLocations(
    lotIds: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly lat: number; readonly lng: number }>>;
  holdOrderReservations(orderId: string): Promise<void>;
  resumeOrderReservationExpiry(orderId: string, expiresAt: Date): Promise<void>;
  consumeOrderReservations(orderId: string): Promise<void>;
  isOrderReservationExpired(orderId: string, now: Date): Promise<boolean>;
}

export const CATALOG_ORDERING_API = Symbol('CATALOG_ORDERING_API');

/** Lots per status (every status, zero included), for the backoffice. */
export interface CatalogMetricsQuery {
  lotsByStatus(): Promise<Readonly<Record<string, number>>>;
}

export const CATALOG_METRICS = Symbol('CATALOG_METRICS');

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
  readonly lot: LotProps & { readonly availableQuantityMilli?: bigint };
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
export const CHANGE_RECORDER = Symbol('CHANGE_RECORDER');

/** Public trust of providers (verified badge, visible rating), from trust via bootstrap. */
export interface ProviderTrustSummary {
  readonly verified: boolean;
  readonly rating: string | null;
  readonly ratingsCount: number;
}

export interface ProviderTrustPort {
  /** At most 50 distinct ids per call; unknown providers come back unverified and unrated. */
  get(providerIds: readonly string[]): Promise<ReadonlyMap<string, ProviderTrustSummary>>;
}

export const PROVIDER_TRUST = Symbol('PROVIDER_TRUST');
