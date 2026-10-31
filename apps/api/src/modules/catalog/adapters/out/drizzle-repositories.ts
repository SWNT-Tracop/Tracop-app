import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, isNull, lte, lt, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../../shared/infra/database.js';
import { APP_CLOCK, OUTBOX_WRITER, UNIT_OF_WORK } from '../../../../shared/infra/tokens.js';
import type { Clock } from '../../../../shared/kernel/clock.js';
import type { OutboxWriter } from '../../../../shared/ports/outbox-writer.js';
import type { UnitOfWork } from '../../../../shared/infra/unit-of-work.js';
import type { CategoryProps } from '../../domain/category.js';
import { quantityDecimalToMilli, quantityMilliToDecimal, type LotProps } from '../../domain/lot.js';
import type { ProductProps } from '../../domain/product.js';
import type {
  CatalogClock,
  CatalogEventWriter,
  CatalogUnitOfWork,
  CategoryRepository,
  LotRepository,
  ProductRepository,
} from '../../ports/catalog-ports.js';
import { categories, lots, products } from './drizzle-schema.js';

const normalizeSearchText = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es-CO');
const toCategory = (row: typeof categories.$inferSelect): CategoryProps => ({
  id: row.id,
  name: row.name,
  parentId: row.parentId,
  depth: row.depth,
});
const toProduct = (row: typeof products.$inferSelect): ProductProps => ({
  id: row.id,
  categoryId: row.categoryId,
  name: row.name,
  unit: row.unit as ProductProps['unit'],
  attributes: row.attributes as ProductProps['attributes'],
});
const toLot = (row: typeof lots.$inferSelect): LotProps => ({
  id: row.id,
  providerId: row.providerId,
  productId: row.productId,
  quantityMilli: quantityDecimalToMilli(row.quantity),
  unit: row.unit as LotProps['unit'],
  unitPrice: row.unitPrice,
  qualityGrade: row.qualityGrade,
  availableFrom: row.availableFrom,
  availableUntil: row.availableUntil,
  locationLat: row.locationLat,
  locationLng: row.locationLng,
  status: row.status as LotProps['status'],
  version: row.version,
});

@Injectable()
export class DrizzleCategoryRepository implements CategoryRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(APP_CLOCK) private readonly clock: Clock,
  ) {}
  async findById(id: string): Promise<CategoryProps | null> {
    const [row] = await this.database
      .current()
      .select()
      .from(categories)
      .where(and(eq(categories.id, id), isNull(categories.deletedAt)))
      .limit(1);
    return row ? toCategory(row) : null;
  }
  async findAll(): Promise<readonly CategoryProps[]> {
    return (
      await this.database
        .current()
        .select()
        .from(categories)
        .where(isNull(categories.deletedAt))
        .orderBy(asc(categories.depth), asc(categories.name))
    ).map(toCategory);
  }
  async save(category: CategoryProps): Promise<void> {
    const now = this.clock.now();
    await this.database
      .current()
      .insert(categories)
      .values({ ...category, createdAt: now, updatedAt: now, deletedAt: null })
      .onConflictDoUpdate({
        target: categories.id,
        set: {
          name: category.name,
          parentId: category.parentId,
          depth: category.depth,
          updatedAt: now,
        },
      });
  }
}

@Injectable()
export class DrizzleProductRepository implements ProductRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(APP_CLOCK) private readonly clock: Clock,
  ) {}
  async findById(id: string): Promise<ProductProps | null> {
    const [row] = await this.database
      .current()
      .select()
      .from(products)
      .where(and(eq(products.id, id), isNull(products.deletedAt)))
      .limit(1);
    return row ? toProduct(row) : null;
  }
  async findAll(
    filter: { categoryId?: string; q?: string } = {},
  ): Promise<readonly ProductProps[]> {
    const clauses = [isNull(products.deletedAt)];
    if (filter.categoryId) clauses.push(eq(products.categoryId, filter.categoryId));
    if (filter.q) {
      const tokens = normalizeSearchText(filter.q).trim().split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        const escaped = token.replace(/[\\%_]/g, '\\$&');
        clauses.push(sql`${products.searchText} LIKE ${`%${escaped}%`} ESCAPE E'\\'`);
      }
    }
    return (
      await this.database
        .current()
        .select()
        .from(products)
        .where(and(...clauses))
        .orderBy(asc(products.name))
    ).map(toProduct);
  }
  async save(product: ProductProps): Promise<void> {
    const now = this.clock.now();
    const searchText = normalizeSearchText(product.name);
    await this.database
      .current()
      .insert(products)
      .values({
        ...product,
        attributes: { ...product.attributes },
        searchText,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: products.id,
        set: {
          categoryId: product.categoryId,
          name: product.name,
          searchText,
          unit: product.unit,
          attributes: { ...product.attributes },
          updatedAt: now,
        },
      });
  }
}

@Injectable()
export class DrizzleLotRepository implements LotRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(APP_CLOCK) private readonly clock: Clock,
  ) {}
  async findById(id: string): Promise<LotProps | null> {
    const [row] = await this.database
      .current()
      .select()
      .from(lots)
      .where(and(eq(lots.id, id), isNull(lots.deletedAt)))
      .limit(1);
    return row ? toLot(row) : null;
  }
  async findByIdForOwner(id: string, providerId: string): Promise<LotProps | null> {
    const [row] = await this.database
      .current()
      .select()
      .from(lots)
      .where(and(eq(lots.id, id), eq(lots.providerId, providerId), isNull(lots.deletedAt)))
      .limit(1);
    return row ? toLot(row) : null;
  }
  async findMine(providerId: string): Promise<readonly LotProps[]> {
    return (
      await this.database
        .current()
        .select()
        .from(lots)
        .where(and(eq(lots.providerId, providerId), isNull(lots.deletedAt)))
        .orderBy(asc(lots.createdAt))
    ).map(toLot);
  }
  async findVisible(
    now: Date,
    bounds?: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  ): Promise<readonly LotProps[]> {
    const predicates = [
      eq(lots.status, 'published'),
      gte(lots.availableUntil, now),
      isNull(lots.deletedAt),
    ];
    if (bounds)
      predicates.push(
        gte(lots.locationLat, bounds.minLat),
        lte(lots.locationLat, bounds.maxLat),
        gte(lots.locationLng, bounds.minLng),
        lte(lots.locationLng, bounds.maxLng),
      );
    return (
      await this.database
        .current()
        .select()
        .from(lots)
        .where(and(...predicates))
        .orderBy(asc(lots.availableFrom), asc(lots.id))
    ).map(toLot);
  }
  async save(lot: LotProps): Promise<'created' | 'exists'> {
    const now = this.clock.now();
    const { quantityMilli, ...lotColumns } = lot;
    const rows = await this.database
      .current()
      .insert(lots)
      .values({
        ...lotColumns,
        quantity: quantityMilliToDecimal(quantityMilli),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoNothing()
      .returning({ id: lots.id });
    return rows.length ? 'created' : 'exists';
  }
  async update(lot: LotProps, expectedVersion: number): Promise<boolean> {
    const rows = await this.database
      .current()
      .update(lots)
      .set({
        productId: lot.productId,
        quantity: quantityMilliToDecimal(lot.quantityMilli),
        unit: lot.unit,
        unitPrice: lot.unitPrice,
        qualityGrade: lot.qualityGrade,
        availableFrom: lot.availableFrom,
        availableUntil: lot.availableUntil,
        locationLat: lot.locationLat,
        locationLng: lot.locationLng,
        status: lot.status,
        version: expectedVersion + 1,
        updatedAt: this.clock.now(),
      })
      .where(
        and(
          eq(lots.id, lot.id),
          eq(lots.providerId, lot.providerId),
          eq(lots.version, expectedVersion),
          isNull(lots.deletedAt),
        ),
      )
      .returning({ id: lots.id });
    return rows.length === 1;
  }
  async findExpired(now: Date, limit: number): Promise<readonly LotProps[]> {
    return (
      await this.database
        .current()
        .select()
        .from(lots)
        .where(
          and(eq(lots.status, 'published'), lt(lots.availableUntil, now), isNull(lots.deletedAt)),
        )
        .limit(limit)
    ).map(toLot);
  }
}

@Injectable()
export class DrizzleCatalogUnitOfWork implements CatalogUnitOfWork {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}
  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.uow.run(operation);
  }
}
@Injectable()
export class SharedCatalogEventWriter implements CatalogEventWriter {
  constructor(@Inject(OUTBOX_WRITER) private readonly writer: OutboxWriter) {}
  append(
    events: readonly { aggregate: string; type: string; payload: Record<string, unknown> }[],
  ): Promise<void> {
    return this.writer.append(events);
  }
}
@Injectable()
export class SharedCatalogClock implements CatalogClock {
  constructor(@Inject(APP_CLOCK) private readonly clock: Clock) {}
  now(): Date {
    return this.clock.now();
  }
}
