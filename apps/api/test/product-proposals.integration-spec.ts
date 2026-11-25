import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../src/bootstrap/app.module.js';
import { CatalogService } from '../src/modules/catalog/application/catalog-service.js';
import {
  PROVIDER_PROFILE_SERVICE,
  type ProviderProfileService,
} from '../src/modules/identity/index.js';
import { SyncService } from '../src/modules/sync/application/sync-service.js';
import { APP_CLOCK, DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';

const PUBLIC_PRODUCT_KEYS = ['attributes', 'categoryId', 'id', 'name', 'status', 'unit'];

describePostgres('Product proposals PostgreSQL concurrency', () => {
  const now = new Date('2026-11-20T12:00:00.000Z');
  let app: INestApplication;
  let pool: pg.Pool;
  let catalog: CatalogService;
  let categoryId: string;

  const propose = (
    proposer: { sub: string; role: string },
    name: string,
    options: { confirm?: boolean } = {},
  ) =>
    catalog.createProductProposal(proposer, {
      id: uuidv7(),
      categoryId,
      name,
      unit: 'kg',
      attributes: {},
      ...options,
    });

  const errorCode = (outcome: PromiseSettledResult<unknown>) =>
    outcome.status === 'rejected' &&
    outcome.reason instanceof Error &&
    'code' in outcome.reason &&
    typeof outcome.reason.code === 'string'
      ? outcome.reason.code
      : undefined;

  const insertUser = async (id: string, role: string, index: number) =>
    pool.query(
      `INSERT INTO identity.users (id, role, full_name, phone, status, locale, created_at, updated_at)
       VALUES ($1, $2, 'Persona sintética', $3, 'active', 'es-CO', $4, $4)`,
      [id, role, `+573009${String(index).padStart(6, '0')}`, now],
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CLOCK)
      .useValue({ now: () => new Date(now) })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    pool = app.get(DATABASE_POOL) as pg.Pool;
    catalog = app.get(CatalogService);
    await resetPostgresFixtures(pool);
  });

  beforeEach(async () => {
    await resetPostgresFixtures(pool);
    categoryId = uuidv7();
    await pool.query(
      `INSERT INTO catalog.categories (id,name,parent_id,depth,created_at,updated_at)
       VALUES ($1,'Verduras',NULL,1,$2,$2)`,
      [categoryId, now],
    );
  });

  afterAll(async () => app.close());

  it('deduplicates 20 concurrent proposals for the same normalized product', async () => {
    const userId = uuidv7();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        propose({ sub: userId, role: 'producer' }, 'Tomate Cherry', { confirm: true }),
      ),
    );
    expect(results.filter((result) => result.created).length).toBe(1);
    expect(results.filter((result) => !result.created).length).toBe(19);
  });

  it('lets exactly one of 20 concurrent providers propose a new name; the rest get 409', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        propose({ sub: uuidv7(), role: 'producer' }, 'Gulupa morada', { confirm: true }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled').length).toBe(1);
    expect(results.map(errorCode).filter((code) => code === 'product_pending_review').length).toBe(
      19,
    );
  });

  it('allows exactly five pending proposals per user under concurrent calls', async () => {
    const userId = uuidv7();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        propose({ sub: userId, role: 'supplier' }, `Producto sintético ${index}`, {
          confirm: true,
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled').length).toBe(5);
    expect(results.map(errorCode).filter((code) => code === 'pending_limit_reached').length).toBe(
      15,
    );
  });

  it('matches by complete tokens against the real repository', async () => {
    const staff = { sub: uuidv7(), role: 'operator' };
    const proposer = { sub: uuidv7(), role: 'producer' };
    const papaCriolla = await propose(proposer, 'Papa criolla');
    await catalog.approveProductProposal(staff, papaCriolla.product.id);

    const papa = await propose(proposer, 'Papa').catch((error: unknown) => error);
    expect(papa).toMatchObject({
      code: 'product_similar_exists',
      details: { suggestions: [expect.objectContaining({ id: papaCriolla.product.id })] },
    });
    await expect(propose(proposer, 'Criolla papa')).rejects.toMatchObject({
      code: 'product_similar_exists',
    });
    await expect(propose(proposer, 'PAPA  Criolla')).resolves.toMatchObject({
      created: false,
      product: { id: papaCriolla.product.id },
    });
    await expect(propose(proposer, 'Papaya')).resolves.toMatchObject({ created: true });
    await expect(propose(proposer, 'Papa pastusa')).resolves.toMatchObject({ created: true });
  });

  it('keeps pending proposals visible only to their proposer or staff', async () => {
    const proposer = uuidv7();
    const thirdParty = uuidv7();
    const proposal = await propose({ sub: proposer, role: 'producer' }, 'Aguacate Hass', {
      confirm: true,
    });
    expect(proposal.created).toBe(true);
    expect(
      (await catalog.listProductProposals({ sub: proposer, role: 'producer' })).map((p) => p.id),
    ).toContain(proposal.product.id);
    expect(
      (await catalog.listProductProposals({ sub: thirdParty, role: 'producer' })).map((p) => p.id),
    ).not.toContain(proposal.product.id);
    expect(
      (await catalog.listProductProposals({ sub: thirdParty, role: 'operator' })).map((p) => p.id),
    ).toContain(proposal.product.id);
    expect((await catalog.listProducts({ categoryId })).map((product) => product.id)).not.toContain(
      proposal.product.id,
    );
  });

  it('publishes pending, approved and rejected product changes with owner visibility', async () => {
    const proposer = uuidv7();
    const thirdParty = uuidv7();
    const sync = app.get(SyncService);
    const pull = (sub: string, role: string) => sync.pull({ sub, role, did: uuidv7() }, '0', 500);
    const changesFor = async (sub: string, role: string, entityId: string) =>
      (await pull(sub, role)).changes.filter(
        (change) => change.entity === 'product' && change.entityId === entityId,
      );

    const proposal = await propose({ sub: proposer, role: 'producer' }, 'Pitahaya', {
      confirm: true,
    });
    expect((await changesFor(proposer, 'producer', proposal.product.id)).map((c) => c.op)).toEqual([
      'upsert',
    ]);
    expect(await changesFor(thirdParty, 'buyer', proposal.product.id)).toEqual([]);

    const reviewer = uuidv7();
    await catalog.approveProductProposal({ sub: reviewer, role: 'operator' }, proposal.product.id);
    const audit = await pool.query<{ actor_id: string; action: string; after: unknown }>(
      `SELECT actor_id, action, after FROM backoffice.audit_log WHERE entity_id = $1`,
      [proposal.product.id],
    );
    expect(audit.rows).toEqual([
      { actor_id: reviewer, action: 'product_proposal.approve', after: { status: 'approved' } },
    ]);
    const approvedForThird = await changesFor(thirdParty, 'buyer', proposal.product.id);
    expect(approvedForThird.map((change) => change.op)).toEqual(['upsert']);
    expect(Object.keys(approvedForThird[0]!.payload).sort()).toEqual(PUBLIC_PRODUCT_KEYS);

    const rejected = await propose({ sub: proposer, role: 'producer' }, 'Fruta rechazada', {
      confirm: true,
    });
    await catalog.rejectProductProposal(
      { sub: uuidv7(), role: 'admin' },
      rejected.product.id,
      'Motivo sintético',
    );
    const rejectedForProposer = await changesFor(proposer, 'producer', rejected.product.id);
    expect(rejectedForProposer.map((change) => change.op)).toEqual(['upsert', 'delete']);
    expect(rejectedForProposer[1]!.payload).toMatchObject({
      status: 'rejected',
      rejectionReason: 'Motivo sintético',
    });
    expect(await changesFor(thirdParty, 'buyer', rejected.product.id)).toEqual([]);
  });

  it('blocks publishing a lot whose product is pending and allows it once approved', async () => {
    const proposer = uuidv7();
    await insertUser(proposer, 'producer', 1);
    await (app.get(PROVIDER_PROFILE_SERVICE) as ProviderProfileService).upsertProviderProfile(
      proposer,
      {
        displayName: 'Finca sintética',
        municipality: 'Tunja',
        department: 'Boyacá',
        lat: 5.5,
        lng: -73.4,
        description: 'Dato sintético',
      },
    );
    const owner = { sub: proposer, role: 'producer' };
    const proposal = await propose(owner, 'Producto pendiente', { confirm: true });
    const lot = await catalog.createLot(owner, {
      id: uuidv7(),
      productId: proposal.product.id,
      quantityMilli: 1000n,
      unit: 'kg',
      unitPrice: 5000n,
      availableFrom: now,
      availableUntil: new Date(now.getTime() + 86_400_000),
      locationLat: 5.5,
      locationLng: -73.0,
      qualityGrade: null,
    });

    await expect(catalog.publishLot(owner, lot.id, 1)).rejects.toMatchObject({
      code: 'product_pending_review',
    });
    await catalog.approveProductProposal({ sub: uuidv7(), role: 'operator' }, proposal.product.id);
    await expect(catalog.publishLot(owner, lot.id, 1)).resolves.toMatchObject({
      status: 'published',
    });
  });

  it('lets a provider propose again a name that staff rejected', async () => {
    const proposer = { sub: uuidv7(), role: 'producer' };
    const first = await propose(proposer, 'Producto reaprobado', { confirm: true });
    await catalog.rejectProductProposal(
      { sub: uuidv7(), role: 'admin' },
      first.product.id,
      'Calidad insuficiente',
    );
    const second = await propose(proposer, 'Producto reaprobado', { confirm: true });
    expect(second.created).toBe(true);
    expect(second.product.id).not.toBe(first.product.id);
  });

  it('restricts reviewing proposals to staff and listing to providers and staff', async () => {
    const proposer = uuidv7();
    const proposal = await propose({ sub: proposer, role: 'producer' }, 'Producto staff', {
      confirm: true,
    });
    await expect(
      catalog.listProductProposals({ sub: proposer, role: 'buyer' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      catalog.approveProductProposal({ sub: proposer, role: 'producer' }, proposal.product.id),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      catalog.rejectProductProposal({ sub: proposer, role: 'buyer' }, proposal.product.id, 'x'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      catalog.approveProductProposal({ sub: uuidv7(), role: 'operator' }, proposal.product.id),
    ).resolves.toMatchObject({ status: 'approved', proposedBy: proposer });
  });

  it('writes ProductProposed, ProductApproved and ProductRejected to the outbox', async () => {
    const proposer = { sub: uuidv7(), role: 'producer' };
    const staff = { sub: uuidv7(), role: 'operator' };
    const approved = await propose(proposer, 'Evento aprobado', { confirm: true });
    await catalog.approveProductProposal(staff, approved.product.id);
    const rejected = await propose(proposer, 'Evento rechazado', { confirm: true });
    await catalog.rejectProductProposal(staff, rejected.product.id, 'Motivo sintético');
    const typesOf = async (productId: string) =>
      (
        await pool.query<{ type: string }>(
          `SELECT type FROM shared.outbox_events WHERE aggregate = $1`,
          [`product:${productId}`],
        )
      ).rows
        .map((row) => row.type)
        .sort();
    expect(await typesOf(approved.product.id)).toEqual(['ProductApproved', 'ProductProposed']);
    expect(await typesOf(rejected.product.id)).toEqual(['ProductProposed', 'ProductRejected']);
  });

  it('enforces the review CHECK in PostgreSQL', async () => {
    const insert = (status: string, proposedBy: string | null, reviewedBy: string | null) =>
      pool
        .query(
          `INSERT INTO catalog.products (id, category_id, name, search_text, unit, attributes,
             status, proposed_by, reviewed_by, reviewed_at, rejection_reason, created_at, updated_at)
           VALUES ($1, $2, $3, $3, 'kg', '{}', $4, $5, $6::uuid,
             CASE WHEN $6::uuid IS NULL THEN NULL ELSE $7::timestamptz END,
             CASE WHEN $4 = 'rejected' THEN 'motivo' ELSE NULL END, $7, $7)`,
          [uuidv7(), categoryId, `check ${uuidv7()}`, status, proposedBy, reviewedBy, now],
        )
        .then(
          () => 'inserted',
          (error: { code?: string; constraint?: string }) => `${error.code}:${error.constraint}`,
        );
    const user = uuidv7();
    const violation = '23514:products_proposal_review_check';
    expect(await insert('approved', null, null)).toBe('inserted');
    expect(await insert('pending_review', user, null)).toBe('inserted');
    expect(await insert('approved', user, user)).toBe('inserted');
    expect(await insert('rejected', user, user)).toBe('inserted');
    expect(await insert('approved', user, null)).toBe(violation);
    expect(await insert('rejected', user, null)).toBe(violation);
    expect(await insert('pending_review', null, null)).toBe(violation);
    expect(await insert('pending_review', user, user)).toBe(violation);
  });
});
