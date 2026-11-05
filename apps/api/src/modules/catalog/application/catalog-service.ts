import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../../shared/kernel/domain-error.js';
import { Category, type CategoryProps } from '../domain/category.js';
import { Lot, type LotProps } from '../domain/lot.js';
import { Product, type ProductProps } from '../domain/product.js';
import {
  CATALOG_CATEGORY_REPOSITORY,
  CATALOG_CLOCK,
  CATALOG_EVENT_WRITER,
  CATALOG_LOT_REPOSITORY,
  CATALOG_PRODUCT_REPOSITORY,
  CATALOG_UNIT_OF_WORK,
  CHANGE_RECORDER,
  type ChangeRecorderPort,
  PROVIDER_DIRECTORY,
  type CatalogClock,
  type CatalogCursor,
  type CatalogSearchCriteria,
  type CatalogSearchPage,
  type CatalogEventWriter,
  type CatalogUnitOfWork,
  type CategoryRepository,
  type LotRepository,
  type ProductRepository,
  type ProviderDirectoryPort,
} from '../ports/catalog-ports.js';
import { LOT_PHOTO_REPOSITORY, type LotPhotoRepository } from '../ports/lot-photo-ports.js';

export interface CatalogSettings {
  readonly lotHorizonDays: number;
}
export const CATALOG_SETTINGS = Symbol('CATALOG_SETTINGS');
const STAFF = ['operator', 'admin'] as const;
const PROVIDERS = ['producer', 'supplier'] as const;
type Actor = { readonly sub: string; readonly role: string };

@Injectable()
export class CatalogService {
  constructor(
    @Inject(CATALOG_CATEGORY_REPOSITORY) private readonly categories: CategoryRepository,
    @Inject(CATALOG_PRODUCT_REPOSITORY) private readonly products: ProductRepository,
    @Inject(CATALOG_LOT_REPOSITORY) private readonly lots: LotRepository,
    @Inject(CATALOG_UNIT_OF_WORK) private readonly uow: CatalogUnitOfWork,
    @Inject(CATALOG_EVENT_WRITER) private readonly events: CatalogEventWriter,
    @Inject(CATALOG_CLOCK) private readonly clock: CatalogClock,
    @Inject(PROVIDER_DIRECTORY) private readonly providers: ProviderDirectoryPort,
    @Inject(CATALOG_SETTINGS) private readonly settings: CatalogSettings,
    @Inject(CHANGE_RECORDER)
    private readonly changeRecorder: ChangeRecorderPort = {
      record: async () => '0',
      recordBaselineIfAbsent: async () => null,
    },
    @Inject(LOT_PHOTO_REPOSITORY)
    private readonly photos?: LotPhotoRepository,
  ) {}

  async createCategory(actor: Actor, input: Omit<CategoryProps, 'depth'>): Promise<CategoryProps> {
    this.requireRole(actor, STAFF);
    return this.uow.run(async () => {
      const parent = input.parentId ? await this.categories.findById(input.parentId) : null;
      if (input.parentId && !parent)
        throw new DomainError('Categoría padre no encontrada.', 'not_found');
      const ancestors = parent ? await this.categoryAncestors(parent) : [];
      Category.assertNoCycle(input.id, ancestors);
      const category = Category.create({ ...input, depth: parent ? parent.depth + 1 : 1 });
      await this.categories.save(category.props);
      await this.recordCategory(category.props);
      return category.props;
    });
  }

  async updateCategory(actor: Actor, id: string, input: { name: string }): Promise<CategoryProps> {
    this.requireRole(actor, STAFF);
    return this.uow.run(async () => {
      const current = await this.categories.findById(id);
      if (!current) throw new DomainError('Categoría no encontrada.', 'not_found');
      const updated = Category.create({ ...current, name: input.name });
      await this.categories.save(updated.props);
      await this.recordCategory(updated.props);
      return updated.props;
    });
  }

  async createProduct(actor: Actor, input: ProductProps): Promise<ProductProps> {
    this.requireRole(actor, STAFF);
    return this.uow.run(async () => {
      if (!(await this.categories.findById(input.categoryId)))
        throw new DomainError('Categoría no encontrada.', 'not_found');
      const product = Product.create(input);
      await this.products.save(product.props);
      await this.recordProduct(product.props);
      return product.props;
    });
  }

  async updateProduct(
    actor: Actor,
    id: string,
    input: Omit<ProductProps, 'id'>,
  ): Promise<ProductProps> {
    this.requireRole(actor, STAFF);
    return this.uow.run(async () => {
      if (!(await this.products.findById(id)))
        throw new DomainError('Producto no encontrado.', 'not_found');
      if (!(await this.categories.findById(input.categoryId)))
        throw new DomainError('Categoría no encontrada.', 'not_found');
      const product = Product.create({ ...input, id });
      await this.products.save(product.props);
      await this.recordProduct(product.props);
      return product.props;
    });
  }

  async createLot(
    actor: Actor,
    input: Omit<LotProps, 'providerId' | 'status' | 'version'>,
  ): Promise<LotProps> {
    this.requireRole(actor, PROVIDERS);
    return this.uow.run(async () => {
      const existing = await this.lots.findById(input.id);
      if (existing) {
        if (existing.providerId === actor.sub) return existing;
        throw new DomainError('Conflicto de versión.', 'version_conflict');
      }
      const product = await this.products.findById(input.productId);
      if (!product) throw new DomainError('Producto no encontrado.', 'not_found');
      const lot = Lot.create(
        { ...input, providerId: actor.sub, status: 'draft', version: 1 },
        product.unit,
        this.clock.now(),
        this.settings.lotHorizonDays,
      );
      const outcome = await this.lots.save(lot.props);
      if (outcome === 'exists') {
        const raced = await this.lots.findById(input.id);
        if (raced?.providerId === actor.sub) return raced;
        throw new DomainError('Conflicto de versión.', 'version_conflict');
      }
      await this.recordLot(lot.props);
      return lot.props;
    });
  }

  async updateLot(
    actor: Actor,
    id: string,
    expectedVersion: number,
    patch: Partial<LotProps>,
  ): Promise<LotProps> {
    this.requireRole(actor, PROVIDERS);
    return this.uow.run(async () => {
      const current = await this.lots.findByIdForOwner(id, actor.sub);
      if (!current) throw new DomainError('Lote no encontrado.', 'not_found');
      if (current.version !== expectedVersion)
        throw new DomainError('Conflicto de versión.', 'version_conflict');
      if (current.status !== 'draft')
        throw new DomainError('Solo se edita un lote en borrador.', 'invalid_transition');
      const product = await this.products.findById(patch.productId ?? current.productId);
      if (!product) throw new DomainError('Producto no encontrado.', 'not_found');
      const validated = Lot.create(
        {
          ...current,
          productId: patch.productId ?? current.productId,
          quantityMilli: patch.quantityMilli ?? current.quantityMilli,
          unit: patch.unit ?? current.unit,
          unitPrice: patch.unitPrice ?? current.unitPrice,
          qualityGrade:
            patch.qualityGrade === undefined ? current.qualityGrade : patch.qualityGrade,
          availableFrom: patch.availableFrom ?? current.availableFrom,
          availableUntil: patch.availableUntil ?? current.availableUntil,
          locationLat: patch.locationLat ?? current.locationLat,
          locationLng: patch.locationLng ?? current.locationLng,
          providerId: actor.sub,
          status: 'draft',
          version: current.version + 1,
        },
        product.unit,
        this.clock.now(),
        this.settings.lotHorizonDays,
      ).props;
      const next = { ...validated, version: current.version + 1 };
      if (!(await this.lots.update(next, expectedVersion)))
        throw new DomainError('Conflicto de versión.', 'version_conflict');
      await this.recordLot(next);
      return next;
    });
  }

  async deleteLot(actor: Actor, id: string, expectedVersion: number): Promise<LotProps> {
    this.requireRole(actor, PROVIDERS);
    return this.uow.run(async () => {
      const current = await this.lots.findByIdForOwner(id, actor.sub);
      if (!current) throw new DomainError('Lote no encontrado.', 'not_found');
      if (current.version !== expectedVersion)
        throw new DomainError('Conflicto de versión.', 'version_conflict');
      const lot = Lot.reconstitute(current);
      lot.deleteDraft(this.clock.now());
      if (!(await this.lots.softDelete(lot.props, expectedVersion, this.clock.now())))
        throw new DomainError('Conflicto de versión.', 'version_conflict');
      await this.photos?.softDeleteForLot(id, this.clock.now());
      const deleted = { ...lot.props };
      await this.events.append(lot.drainEvents().map((event) => this.eventInput(event)));
      await this.recordLot(deleted, 'delete', { id, version: deleted.version, tombstone: true });
      return deleted;
    });
  }

  async backfillChanges(): Promise<{ readonly recorded: number; readonly skipped: number }> {
    let recorded = 0;
    let skipped = 0;
    for (const category of await this.categories.findAll()) {
      const sequence = await this.uow.run(() =>
        this.changeRecorder.recordBaselineIfAbsent({
          entity: 'category',
          entityId: category.id,
          op: 'upsert',
          payload: this.categoryPayload(category),
          ownerUserId: null,
          occurredAt: this.clock.now(),
        }),
      );
      if (sequence) recorded += 1;
      else skipped += 1;
    }
    for (const product of await this.products.findAll()) {
      const sequence = await this.uow.run(() =>
        this.changeRecorder.recordBaselineIfAbsent({
          entity: 'product',
          entityId: product.id,
          op: 'upsert',
          payload: this.productPayload(product),
          ownerUserId: null,
          occurredAt: this.clock.now(),
        }),
      );
      if (sequence) recorded += 1;
      else skipped += 1;
    }
    for (const lot of await this.lots.findAllForChangeBackfill()) {
      const sequence = await this.uow.run(() =>
        this.changeRecorder.recordBaselineIfAbsent({
          entity: 'lot',
          entityId: lot.id,
          op: 'upsert',
          payload: this.lotPayload(lot),
          ownerUserId: this.lotOwner(lot),
          occurredAt: this.clock.now(),
        }),
      );
      if (sequence) recorded += 1;
      else skipped += 1;
    }
    return { recorded, skipped };
  }

  async publishLot(actor: Actor, id: string, expectedVersion: number): Promise<LotProps> {
    this.requireRole(actor, PROVIDERS);
    return this.transitionOwnedLot(actor, id, expectedVersion, 'published');
  }
  async cancelLot(actor: Actor, id: string, expectedVersion: number): Promise<LotProps> {
    this.requireRole(actor, PROVIDERS);
    return this.transitionOwnedLot(actor, id, expectedVersion, 'cancelled');
  }

  async expireLots(limit = 100): Promise<number> {
    const expired = await this.lots.findExpired(this.clock.now(), limit);
    for (const item of expired) {
      const lot = Lot.reconstitute(item);
      lot.transition('expired', this.clock.now());
      await this.uow.run(async () => {
        if (await this.lots.update(lot.props, item.version)) {
          await this.events.append(lot.drainEvents().map((event) => this.eventInput(event)));
          await this.recordLot(lot.props);
        }
      });
    }
    return expired.length;
  }

  async getMyLots(actor: Actor): Promise<readonly LotProps[]> {
    this.requireRole(actor, PROVIDERS);
    return this.lots.findMine(actor.sub);
  }
  async searchVisibleLots(criteria: CatalogSearchCriteria): Promise<CatalogSearchPage> {
    const now = this.clock.now();
    const bounds =
      criteria.lat !== undefined && criteria.lng !== undefined && criteria.radiusKm !== undefined
        ? {
            minLat: criteria.lat - criteria.radiusKm / 110.5,
            maxLat: criteria.lat + criteria.radiusKm / 110.5,
            minLng:
              criteria.lng - criteria.radiusKm / (110.5 * Math.cos((criteria.lat * Math.PI) / 180)),
            maxLng:
              criteria.lng + criteria.radiusKm / (110.5 * Math.cos((criteria.lat * Math.PI) / 180)),
          }
        : undefined;
    const allLots = await this.lots.findVisible(now, bounds);
    const allProducts = await this.products.findAll();
    const productById = new Map(allProducts.map((item) => [item.id, item]));
    const productsByCategory = new Set<string>();
    if (criteria.categoryId) {
      const allCategories = await this.categories.findAll();
      const descendants = new Set([criteria.categoryId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const category of allCategories) {
          if (
            category.parentId &&
            descendants.has(category.parentId) &&
            !descendants.has(category.id)
          ) {
            descendants.add(category.id);
            changed = true;
          }
        }
      }
      for (const product of allProducts)
        if (descendants.has(product.categoryId)) productsByCategory.add(product.id);
    }
    const tokens =
      criteria.q
        ?.normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('es-CO')
        .trim()
        .split(/\s+/)
        .filter(Boolean) ?? [];
    const result = allLots.flatMap((lot) => {
      const product = productById.get(lot.productId);
      if (!product || (criteria.productId && lot.productId !== criteria.productId)) return [];
      if (criteria.categoryId && !productsByCategory.has(lot.productId)) return [];
      const productText = product.name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('es-CO');
      if (tokens.some((token) => !productText.includes(token))) return [];
      if (criteria.minPrice !== undefined && lot.unitPrice < BigInt(criteria.minPrice)) return [];
      if (criteria.maxPrice !== undefined && lot.unitPrice > BigInt(criteria.maxPrice)) return [];
      if (criteria.availableFrom && lot.availableUntil < criteria.availableFrom) return [];
      if (criteria.availableUntil && lot.availableFrom > criteria.availableUntil) return [];
      let distanceKm: number | undefined;
      if (
        criteria.lat !== undefined &&
        criteria.lng !== undefined &&
        criteria.radiusKm !== undefined
      ) {
        const latDelta = criteria.radiusKm / 110.5;
        const lngDelta = criteria.radiusKm / (110.5 * Math.cos((criteria.lat * Math.PI) / 180));
        if (
          Math.abs(lot.locationLat - criteria.lat) > latDelta ||
          Math.abs(lot.locationLng - criteria.lng) > lngDelta
        )
          return [];
        distanceKm = this.haversine(criteria.lat, criteria.lng, lot.locationLat, lot.locationLng);
        if (distanceKm > criteria.radiusKm + 1e-9) return [];
      }
      return [{ lot, ...(distanceKm !== undefined ? { distanceKm } : {}) }];
    });
    const selectedSort =
      criteria.sort === 'distance' && criteria.lat === undefined ? 'recent' : criteria.sort;
    result.sort((left, right) => {
      let order = 0;
      if (selectedSort === 'price')
        order =
          left.lot.unitPrice < right.lot.unitPrice
            ? -1
            : left.lot.unitPrice > right.lot.unitPrice
              ? 1
              : 0;
      else if (selectedSort === 'distance')
        order = (left.distanceKm ?? Infinity) - (right.distanceKm ?? Infinity);
      else if (selectedSort === 'availability')
        order = left.lot.availableFrom.getTime() - right.lot.availableFrom.getTime();
      else order = right.lot.id.localeCompare(left.lot.id);
      return order || left.lot.id.localeCompare(right.lot.id);
    });
    const afterCursor = criteria.cursor
      ? result.filter((item) => this.isAfterCursor(item, criteria.cursor!))
      : result;
    const pageItems = afterCursor.slice(0, criteria.limit);
    const last = pageItems.at(-1);
    const nextCursor =
      afterCursor.length > criteria.limit && last
        ? {
            version: 1 as const,
            sort: selectedSort,
            key: this.sortKey(last, selectedSort),
            id: last.lot.id,
          }
        : undefined;
    return { items: pageItems, ...(nextCursor ? { nextCursor } : {}) };
  }
  async getLot(actor: Actor, id: string): Promise<LotProps> {
    const own = await this.lots.findByIdForOwner(id, actor.sub);
    if (own) return own;
    const lot = await this.lots.findById(id);
    if (!lot || !Lot.isVisibleNow(lot, this.clock.now()))
      throw new DomainError('Lote no encontrado.', 'not_found');
    return lot;
  }

  async getOwnedLot(actor: Actor, id: string): Promise<LotProps> {
    this.requireRole(actor, PROVIDERS);
    const lot = await this.lots.findByIdForOwner(id, actor.sub);
    if (!lot) throw new DomainError('Lote no encontrado.', 'not_found');
    return lot;
  }

  async listCategories(): Promise<readonly CategoryProps[]> {
    return this.categories.findAll();
  }
  async listProducts(filter?: {
    categoryId?: string;
    q?: string;
  }): Promise<readonly ProductProps[]> {
    return this.products.findAll(filter);
  }

  private async transitionOwnedLot(
    actor: Actor,
    id: string,
    expectedVersion: number,
    status: 'published' | 'cancelled',
  ): Promise<LotProps> {
    return this.uow.run(async () => {
      const current = await this.lots.findByIdForOwner(id, actor.sub);
      if (!current) throw new DomainError('Lote no encontrado.', 'not_found');
      if (current.version !== expectedVersion)
        throw new DomainError('Conflicto de versión.', 'version_conflict');
      const lot = Lot.reconstitute(current);
      if (status === 'published') {
        const provider = await this.providers.getProviderPublicSummaries([actor.sub]);
        if (!provider.has(actor.sub))
          throw new DomainError(
            'Completa el perfil de proveedor antes de publicar.',
            'profile_required',
          );
      }
      lot.transition(status, this.clock.now());
      if (!(await this.lots.update(lot.props, expectedVersion)))
        throw new DomainError('Conflicto de versión.', 'version_conflict');
      await this.events.append(lot.drainEvents().map((event) => this.eventInput(event)));
      if (status === 'cancelled') {
        await this.recordLot(lot.props, 'cancel', {
          ...this.lotPayload(lot.props),
          tombstone: true,
        });
      } else {
        await this.recordLot(lot.props);
      }
      return lot.props;
    });
  }

  private async recordCategory(category: CategoryProps): Promise<void> {
    await this.changeRecorder.record({
      entity: 'category',
      entityId: category.id,
      op: 'upsert',
      payload: this.categoryPayload(category),
      ownerUserId: null,
      occurredAt: this.clock.now(),
    });
  }

  private async recordProduct(product: ProductProps): Promise<void> {
    await this.changeRecorder.record({
      entity: 'product',
      entityId: product.id,
      op: 'upsert',
      payload: this.productPayload(product),
      ownerUserId: null,
      occurredAt: this.clock.now(),
    });
  }

  private async recordLot(
    lot: LotProps,
    op = 'upsert',
    payload: Record<string, unknown> = this.lotPayload(lot),
  ): Promise<void> {
    await this.changeRecorder.record({
      entity: 'lot',
      entityId: lot.id,
      op,
      payload,
      ownerUserId: this.lotOwner(lot),
      occurredAt: this.clock.now(),
    });
  }

  private lotPayload(lot: LotProps): Record<string, unknown> {
    return {
      id: lot.id,
      productId: lot.productId,
      quantityMilli: lot.quantityMilli.toString(),
      unit: lot.unit,
      unitPrice: Number(lot.unitPrice),
      qualityGrade: lot.qualityGrade,
      availableFrom: lot.availableFrom.toISOString(),
      availableUntil: lot.availableUntil.toISOString(),
      locationLat: lot.locationLat,
      locationLng: lot.locationLng,
      status: lot.status,
      version: lot.version,
    };
  }

  private lotOwner(lot: LotProps): string | null {
    return lot.providerId;
  }

  private categoryPayload(category: CategoryProps): Record<string, unknown> {
    return {
      id: category.id,
      name: category.name,
      parentId: category.parentId,
      depth: category.depth,
    };
  }

  private productPayload(product: ProductProps): Record<string, unknown> {
    return {
      id: product.id,
      categoryId: product.categoryId,
      name: product.name,
      unit: product.unit,
      attributes: product.attributes,
    };
  }

  private eventInput(event: { type: string; lotId: string }): {
    aggregate: string;
    type: string;
    payload: Record<string, unknown>;
  } {
    return { aggregate: `lot:${event.lotId}`, type: event.type, payload: { ...event } };
  }
  private requireRole(actor: Actor, roles: readonly string[]): void {
    if (!roles.includes(actor.role))
      throw new DomainError('No tienes permiso para esta acción.', 'forbidden');
  }
  private async categoryAncestors(category: CategoryProps): Promise<string[]> {
    const result = [category.id];
    let cursor = category;
    while (cursor.parentId) {
      const parent = await this.categories.findById(cursor.parentId);
      if (!parent) break;
      result.push(parent.id);
      cursor = parent;
    }
    return result;
  }

  private haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const radians = (degrees: number): number => (degrees * Math.PI) / 180;
    const dLat = radians(lat2 - lat1);
    const dLng = radians(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLng / 2) ** 2;
    return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  private sortKey(
    item: { lot: LotProps; distanceKm?: number },
    sort: CatalogCursor['sort'],
  ): string {
    if (sort === 'price') return item.lot.unitPrice.toString();
    if (sort === 'distance') return String(item.distanceKm ?? 0);
    if (sort === 'availability') return String(item.lot.availableFrom.getTime());
    return item.lot.id;
  }
  private isAfterCursor(
    item: { lot: LotProps; distanceKm?: number },
    cursor: CatalogCursor,
  ): boolean {
    const key = this.sortKey(item, cursor.sort);
    let compare = 0;
    if (cursor.sort === 'price')
      compare = BigInt(key) < BigInt(cursor.key) ? -1 : BigInt(key) > BigInt(cursor.key) ? 1 : 0;
    else if (cursor.sort === 'distance' || cursor.sort === 'availability')
      compare = Number(key) - Number(cursor.key);
    else return item.lot.id.localeCompare(cursor.id) < 0;
    return compare > 0 || (compare === 0 && item.lot.id.localeCompare(cursor.id) > 0);
  }
}
