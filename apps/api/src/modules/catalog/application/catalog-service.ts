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
  PROVIDER_DIRECTORY,
  type CatalogClock,
  type CatalogEventWriter,
  type CatalogUnitOfWork,
  type CategoryRepository,
  type LotRepository,
  type ProductRepository,
  type ProviderDirectoryPort,
} from '../ports/catalog-ports.js';

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
  ) {}

  async createCategory(actor: Actor, input: Omit<CategoryProps, 'depth'>): Promise<CategoryProps> {
    this.requireRole(actor, STAFF);
    const parent = input.parentId ? await this.categories.findById(input.parentId) : null;
    if (input.parentId && !parent)
      throw new DomainError('Categoría padre no encontrada.', 'not_found');
    const ancestors = parent ? await this.categoryAncestors(parent) : [];
    Category.assertNoCycle(input.id, ancestors);
    const category = Category.create({ ...input, depth: parent ? parent.depth + 1 : 1 });
    await this.categories.save(category.props);
    return category.props;
  }

  async updateCategory(actor: Actor, id: string, input: { name: string }): Promise<CategoryProps> {
    this.requireRole(actor, STAFF);
    const current = await this.categories.findById(id);
    if (!current) throw new DomainError('Categoría no encontrada.', 'not_found');
    const updated = Category.create({ ...current, name: input.name });
    await this.categories.save(updated.props);
    return updated.props;
  }

  async createProduct(actor: Actor, input: ProductProps): Promise<ProductProps> {
    this.requireRole(actor, STAFF);
    if (!(await this.categories.findById(input.categoryId)))
      throw new DomainError('Categoría no encontrada.', 'not_found');
    const product = Product.create(input);
    await this.products.save(product.props);
    return product.props;
  }

  async updateProduct(
    actor: Actor,
    id: string,
    input: Omit<ProductProps, 'id'>,
  ): Promise<ProductProps> {
    this.requireRole(actor, STAFF);
    if (!(await this.products.findById(id)))
      throw new DomainError('Producto no encontrado.', 'not_found');
    if (!(await this.categories.findById(input.categoryId)))
      throw new DomainError('Categoría no encontrada.', 'not_found');
    const product = Product.create({ ...input, id });
    await this.products.save(product.props);
    return product.props;
  }

  async createLot(
    actor: Actor,
    input: Omit<LotProps, 'providerId' | 'status' | 'version'>,
  ): Promise<LotProps> {
    this.requireRole(actor, PROVIDERS);
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
    await this.lots.save(lot.props);
    return lot.props;
  }

  async updateLot(
    actor: Actor,
    id: string,
    expectedVersion: number,
    patch: Partial<LotProps>,
  ): Promise<LotProps> {
    this.requireRole(actor, PROVIDERS);
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
        ...patch,
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
    return next;
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
        }
      });
    }
    return expired.length;
  }

  async getMyLots(actor: Actor): Promise<readonly LotProps[]> {
    this.requireRole(actor, PROVIDERS);
    return this.lots.findMine(actor.sub);
  }
  async getLot(actor: Actor, id: string): Promise<LotProps> {
    const own = await this.lots.findByIdForOwner(id, actor.sub);
    if (own) return own;
    const lot = await this.lots.findById(id);
    if (!lot || !Lot.isVisibleNow(lot, this.clock.now()))
      throw new DomainError('Lote no encontrado.', 'not_found');
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
    await this.uow.run(async () => {
      if (!(await this.lots.update(lot.props, expectedVersion)))
        throw new DomainError('Conflicto de versión.', 'version_conflict');
      await this.events.append(lot.drainEvents().map((event) => this.eventInput(event)));
    });
    return lot.props;
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
}
