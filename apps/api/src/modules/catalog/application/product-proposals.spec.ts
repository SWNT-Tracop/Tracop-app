import { CatalogService } from './catalog-service.js';
import type {
  CategoryRepository,
  ProductRepository,
  LotRepository,
  CatalogUnitOfWork,
  CatalogEventWriter,
  CatalogClock,
  ProviderDirectoryPort,
  ChangeRecorderPort,
} from '../ports/catalog-ports.js';
import { normalizeProductSearchText, type ProductProps } from '../domain/product.js';
import type { LotProps } from '../domain/lot.js';

const actor = { sub: '018f47a2-8b45-7cc2-9a1e-123456789abc', role: 'producer' };
const staff = { sub: '018f47a2-8b45-7cc2-9a1e-123456789abd', role: 'operator' };

const approved: ProductProps = {
  id: '018f47a2-8b45-7cc2-9a1e-123456789abe',
  categoryId: '018f47a2-8b45-7cc2-9a1e-123456789abf',
  name: 'Tomate chonto',
  unit: 'kg',
  attributes: {},
  status: 'approved',
};

const createHarness = () => {
  const products = new Map<string, ProductProps>([[approved.id, approved]]);
  const categories = new Map([
    [
      approved.categoryId,
      {
        id: approved.categoryId,
        name: 'Hortalizas',
        parentId: null,
        depth: 1,
      },
    ],
  ]);
  const lots = new Map<string, LotProps>();
  const categoryRepository: CategoryRepository = {
    findById: async (id) => categories.get(id) ?? null,
    findAll: async () => [...categories.values()],
    save: async () => undefined,
  };
  // Same visibility as DrizzleProductRepository: approved for everyone, pending for its
  // proposer and staff, rejected for nobody.
  const isStaff = (role: string) => role === 'operator' || role === 'admin';
  const visibleTo = (product: ProductProps, viewerId: string, viewerRole: string) =>
    product.status === 'approved' ||
    (product.status === 'pending_review' &&
      (isStaff(viewerRole) || product.proposedBy === viewerId));
  const productRepository: ProductRepository = {
    findById: async (id) => products.get(id) ?? null,
    findAll: async () => [...products.values()].filter((product) => product.status === 'approved'),
    save: async (product) => {
      products.set(product.id, product);
    },
    lockForProductProposal: async () => undefined,
    lockPendingLimitByUser: async () => undefined,
    findExactVisible: async (categoryId, searchText, viewerId, viewerRole) =>
      [...products.values()].find(
        (product) =>
          product.categoryId === categoryId &&
          normalizeProductSearchText(product.name) === searchText &&
          visibleTo(product, viewerId, viewerRole),
      ) ?? null,
    findVisibleInCategory: async (categoryId, viewerId, viewerRole) =>
      [...products.values()]
        .filter(
          (product) =>
            product.categoryId === categoryId && visibleTo(product, viewerId, viewerRole),
        )
        .sort((left, right) => left.name.localeCompare(right.name)),
    existsActiveBySearchText: async (categoryId, searchText) =>
      [...products.values()].some(
        (product) =>
          product.categoryId === categoryId &&
          normalizeProductSearchText(product.name) === searchText &&
          (product.status === 'approved' || product.status === 'pending_review'),
      ),
    countPendingByUser: async (userId) =>
      [...products.values()].filter(
        (product) => product.status === 'pending_review' && product.proposedBy === userId,
      ).length,
    findPending: async () =>
      [...products.values()].filter((product) => product.status === 'pending_review'),
  };
  const lotRepository: LotRepository = {
    findById: async (id) => lots.get(id) ?? null,
    findByIdForOwner: async (id, owner) =>
      lots.get(id)?.providerId === owner ? lots.get(id)! : null,
    findMine: async () => [],
    findVisible: async () => [],
    save: async (lot) => {
      lots.set(lot.id, lot);
      return 'created';
    },
    update: async () => true,
    findExpired: async () => [],
    findAllForChangeBackfill: async () => [],
    softDelete: async () => true,
    lockForReservation: async (ids) =>
      ids.map((id) => lots.get(id)).filter((lot) => lot !== undefined),
    getAvailableQuantity: async () => 0n,
    findOrderReservationLotIds: async () => [],
    reserveStock: async () => 'created',
    releaseOrderReservations: async () => [],
    findExpiredReservationOrderIds: async () => [],
    holdOrderReservations: async () => 0,
    resumeOrderReservationExpiry: async () => 0,
    consumeOrderReservations: async () => [],
    countActiveOrderReservations: async () => 0,
    isOrderReservationExpired: async () => false,
    getConsumedQuantity: async () => 0n,
  };
  const uow: CatalogUnitOfWork = { run: async (operation) => operation() };
  const eventWriter: CatalogEventWriter = { append: jest.fn(async () => undefined) };
  const clock: CatalogClock = { now: () => new Date('2026-11-19T12:00:00.000Z') };
  const providerDirectory: ProviderDirectoryPort = {
    getProviderPublicSummaries: async () => new Map(),
  };
  const changeRecorder: ChangeRecorderPort = {
    record: jest.fn(async () => '1'),
    recordBaselineIfAbsent: jest.fn(async () => '1'),
  };
  const service = new CatalogService(
    categoryRepository,
    productRepository,
    lotRepository,
    uow,
    eventWriter,
    clock,
    providerDirectory,
    { lotHorizonDays: 90, productProposalPendingLimit: 5 },
    changeRecorder,
  );
  return { service, products, lots, productRepository, eventWriter, changeRecorder };
};

const proposalInput = (id: string, name: string, confirm?: boolean) => ({
  id,
  categoryId: approved.categoryId,
  name,
  unit: 'kg' as const,
  attributes: {},
  ...(confirm === undefined ? {} : { confirm }),
});

const withProduct = (
  harness: ReturnType<typeof createHarness>,
  id: string,
  name: string,
  extra: Partial<ProductProps> = {},
): ProductProps => {
  const product: ProductProps = { ...approved, id, name, ...extra };
  harness.products.set(product.id, product);
  return product;
};

const otherProducer = { sub: '018f47a2-8b45-7cc2-9a1e-123456789aaa', role: 'producer' };

describe('Catalog product proposals', () => {
  it('returns the existing product with created:false for the same normalized name', async () => {
    const harness = createHarness();
    const result = await harness.service.createProductProposal(
      actor,
      proposalInput('018f47a2-8b45-7cc2-9a1e-123456789ab0', '  TOMATE   chonto '),
    );
    expect(result).toMatchObject({ created: false, product: { id: approved.id } });
    expect(harness.eventWriter.append).not.toHaveBeenCalled();
  });

  it('answers 409 product_similar_exists for papa vs papa criolla and creates with confirm', async () => {
    const harness = createHarness();
    const papaCriolla = withProduct(
      harness,
      '018f47a2-8b45-7cc2-9a1e-123456789ac0',
      'Papa criolla',
    );

    await expect(
      harness.service.createProductProposal(
        actor,
        proposalInput('018f47a2-8b45-7cc2-9a1e-123456789ac1', 'Papa'),
      ),
    ).rejects.toMatchObject({
      code: 'product_similar_exists',
      details: { suggestions: [expect.objectContaining({ id: papaCriolla.id })] },
    });

    const confirmed = await harness.service.createProductProposal(
      actor,
      proposalInput('018f47a2-8b45-7cc2-9a1e-123456789ac1', 'Papa', true),
    );
    expect(confirmed).toMatchObject({ created: true, product: { status: 'pending_review' } });
  });

  it('treats the same tokens in another order as similar, not exact', async () => {
    const harness = createHarness();
    withProduct(harness, '018f47a2-8b45-7cc2-9a1e-123456789ac0', 'Papa criolla');
    await expect(
      harness.service.createProductProposal(
        actor,
        proposalInput('018f47a2-8b45-7cc2-9a1e-123456789ac2', 'Criolla papa'),
      ),
    ).rejects.toMatchObject({ code: 'product_similar_exists' });
  });

  it.each([
    ['Papa', 'Papaya'],
    ['Papa pastusa', 'Papa criolla'],
  ])('creates %s without confirm when only %s exists', async (proposed, existing) => {
    const harness = createHarness();
    withProduct(harness, '018f47a2-8b45-7cc2-9a1e-123456789ac3', existing);
    const result = await harness.service.createProductProposal(
      actor,
      proposalInput('018f47a2-8b45-7cc2-9a1e-123456789ac4', proposed),
    );
    expect(result).toMatchObject({ created: true, product: { name: proposed } });
  });

  it('returns at most five suggestions', async () => {
    const harness = createHarness();
    for (let index = 0; index < 7; index += 1)
      withProduct(harness, `018f47a2-8b45-7cc2-9a1e-12345678a00${index}`, `Mango variedad${index}`);
    await expect(
      harness.service.createProductProposal(
        actor,
        proposalInput('018f47a2-8b45-7cc2-9a1e-123456789ac5', 'Mango'),
      ),
    ).rejects.toMatchObject({
      details: { suggestions: expect.objectContaining({ length: 5 }) },
    });
  });

  it("answers 409 product_pending_review for another provider's pending name", async () => {
    const harness = createHarness();
    withProduct(harness, '018f47a2-8b45-7cc2-9a1e-123456789ac6', 'Gulupa', {
      status: 'pending_review',
      proposedBy: otherProducer.sub,
    });
    const failure = await harness.service
      .createProductProposal(actor, proposalInput('018f47a2-8b45-7cc2-9a1e-123456789ac7', 'gulupa'))
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'product_pending_review', details: undefined });
  });

  it('enforces the configured pending limit per user', async () => {
    const harness = createHarness();
    for (let index = 0; index < 5; index += 1)
      withProduct(harness, `018f47a2-8b45-7cc2-9a1e-12345678b00${index}`, `Fruta ${index}x`, {
        status: 'pending_review',
        proposedBy: actor.sub,
      });
    await expect(
      harness.service.createProductProposal(
        actor,
        proposalInput('018f47a2-8b45-7cc2-9a1e-123456789ab3', 'Otra cosa', true),
      ),
    ).rejects.toMatchObject({ code: 'pending_limit_reached' });
  });

  it('approves and rejects proposals keeping the proposer and recording the reviewer', async () => {
    const harness = createHarness();
    const proposed = withProduct(harness, '018f47a2-8b45-7cc2-9a1e-123456789ab4', 'Lulo', {
      status: 'pending_review',
      proposedBy: actor.sub,
    });

    const approvedProposal = await harness.service.approveProductProposal(staff, proposed.id);
    expect(approvedProposal).toMatchObject({
      status: 'approved',
      proposedBy: actor.sub,
      reviewedBy: staff.sub,
      reviewedAt: new Date('2026-11-19T12:00:00.000Z'),
    });

    harness.products.set(proposed.id, proposed);
    const rejected = await harness.service.rejectProductProposal(staff, proposed.id, 'Duplicado');
    expect(rejected).toMatchObject({
      status: 'rejected',
      proposedBy: actor.sub,
      reviewedBy: staff.sub,
      rejectionReason: 'Duplicado',
    });
  });

  it('blocks publishing a lot that uses a non-approved product', async () => {
    const harness = createHarness();
    const pending = withProduct(harness, '018f47a2-8b45-7cc2-9a1e-123456789ab5', 'Maracuyá', {
      status: 'pending_review',
      proposedBy: actor.sub,
    });
    const lot: LotProps = {
      id: '018f47a2-8b45-7cc2-9a1e-123456789ab6',
      providerId: actor.sub,
      productId: pending.id,
      quantityMilli: 1000n,
      unit: 'kg',
      unitPrice: 5000n,
      qualityGrade: null,
      availableFrom: new Date('2026-11-19T12:00:00.000Z'),
      availableUntil: new Date('2026-12-19T12:00:00.000Z'),
      locationLat: 5.5,
      locationLng: -73.4,
      status: 'draft',
      version: 1,
    };
    harness.lots.set(lot.id, lot);
    await expect(harness.service.publishLot(actor, lot.id, 1)).rejects.toMatchObject({
      code: 'product_pending_review',
    });
  });

  describe('role-based product views', () => {
    const PUBLIC_KEYS = ['attributes', 'categoryId', 'id', 'name', 'status', 'unit'];
    const reviewedProposal = (harness: ReturnType<typeof createHarness>) =>
      withProduct(harness, '018f47a2-8b45-7cc2-9a1e-123456789ad0', 'Uchuva', {
        status: 'approved',
        proposedBy: otherProducer.sub,
        reviewedBy: staff.sub,
        reviewedAt: new Date('2026-11-19T12:00:00.000Z'),
      });
    const recordedPayloads = (harness: ReturnType<typeof createHarness>) =>
      (harness.changeRecorder.record as jest.Mock).mock.calls.map(
        ([change]: [
          { payload: Record<string, unknown>; ownerUserId: string | null; op: string },
        ]) => change,
      );

    it('lists products without proposer or reviewer identifiers', async () => {
      const harness = createHarness();
      reviewedProposal(harness);
      const listed = await harness.service.listProducts();
      expect(listed.length).toBe(2);
      for (const product of listed) expect(Object.keys(product).sort()).toEqual(PUBLIC_KEYS);
    });

    it('returns suggestions without proposer or reviewer identifiers', async () => {
      const harness = createHarness();
      reviewedProposal(harness);
      const failure = (await harness.service
        .createProductProposal(
          actor,
          proposalInput('018f47a2-8b45-7cc2-9a1e-123456789ad1', 'Uchuva dulce'),
        )
        .catch((error: unknown) => error)) as { details: { suggestions: object[] } };
      expect(failure.details.suggestions.length).toBe(1);
      for (const suggestion of failure.details.suggestions)
        expect(Object.keys(suggestion).sort()).toEqual(PUBLIC_KEYS);
    });

    it('lists own proposals for providers without identifiers and full rows for staff', async () => {
      const harness = createHarness();
      withProduct(harness, '018f47a2-8b45-7cc2-9a1e-123456789ad2', 'Feijoa', {
        status: 'pending_review',
        proposedBy: actor.sub,
      });
      const own = await harness.service.listProductProposals(actor);
      expect(own.map((product) => Object.keys(product).sort())).toEqual([
        [...PUBLIC_KEYS, 'rejectionReason'].sort(),
      ]);
      const forStaff = await harness.service.listProductProposals(staff);
      expect(forStaff[0]).toMatchObject({ proposedBy: actor.sub });
      await expect(
        harness.service.listProductProposals({ sub: actor.sub, role: 'buyer' }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('publishes approved products to sync without identifiers and pending ones to their owner', async () => {
      const harness = createHarness();
      const pending = withProduct(harness, '018f47a2-8b45-7cc2-9a1e-123456789ad3', 'Borojó', {
        status: 'pending_review',
        proposedBy: actor.sub,
      });
      await harness.service.approveProductProposal(staff, pending.id);
      await harness.service.createProductProposal(
        actor,
        proposalInput('018f47a2-8b45-7cc2-9a1e-123456789ad4', 'Arazá'),
      );
      const [approvedChange, pendingChange] = recordedPayloads(harness);
      expect(approvedChange).toMatchObject({ op: 'upsert', ownerUserId: null });
      expect(Object.keys(approvedChange!.payload).sort()).toEqual(PUBLIC_KEYS);
      expect(pendingChange).toMatchObject({ op: 'upsert', ownerUserId: actor.sub });
      expect(Object.keys(pendingChange!.payload).sort()).toEqual(
        [...PUBLIC_KEYS, 'rejectionReason'].sort(),
      );
    });

    it('sends the rejection reason only to the proposer as a tombstone', async () => {
      const harness = createHarness();
      const pending = withProduct(harness, '018f47a2-8b45-7cc2-9a1e-123456789ad5', 'Copoazú', {
        status: 'pending_review',
        proposedBy: actor.sub,
      });
      await harness.service.rejectProductProposal(staff, pending.id, 'Nombre ambiguo');
      expect(recordedPayloads(harness)).toEqual([
        expect.objectContaining({
          op: 'delete',
          ownerUserId: actor.sub,
          payload: expect.objectContaining({ rejectionReason: 'Nombre ambiguo' }),
        }),
      ]);
    });
  });

  describe('updateProduct', () => {
    it('keeps the review state of a pending proposal and its owner-scoped visibility', async () => {
      const harness = createHarness();
      const pending = withProduct(harness, '018f47a2-8b45-7cc2-9a1e-123456789ae0', 'Curuba', {
        status: 'pending_review',
        proposedBy: actor.sub,
        reviewedBy: null,
        reviewedAt: null,
        rejectionReason: null,
      });
      const updated = await harness.service.updateProduct(staff, pending.id, {
        categoryId: approved.categoryId,
        name: 'Curuba larga',
        unit: 'kg',
        attributes: {},
      });
      expect(updated).toMatchObject({
        name: 'Curuba larga',
        status: 'pending_review',
        proposedBy: actor.sub,
      });
      expect(harness.changeRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({ op: 'upsert', ownerUserId: actor.sub }),
      );
    });

    it('keeps a rejected proposal rejected', async () => {
      const harness = createHarness();
      const rejected = withProduct(harness, '018f47a2-8b45-7cc2-9a1e-123456789ae1', 'Nombre malo', {
        status: 'rejected',
        proposedBy: actor.sub,
        reviewedBy: staff.sub,
        reviewedAt: new Date('2026-11-19T12:00:00.000Z'),
        rejectionReason: 'Ambiguo',
      });
      const updated = await harness.service.updateProduct(staff, rejected.id, {
        categoryId: approved.categoryId,
        name: 'Nombre corregido',
        unit: 'kg',
        attributes: {},
      });
      expect(updated).toMatchObject({ status: 'rejected', rejectionReason: 'Ambiguo' });
    });
  });
});
