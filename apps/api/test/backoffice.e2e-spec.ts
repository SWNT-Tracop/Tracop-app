import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../src/bootstrap/app.module.js';
import { OrderingService } from '../src/modules/ordering/index.js';
import { createId } from '../src/shared/kernel/ids.js';
import { configureHttp } from '../src/bootstrap/http.js';
import { DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { PARAMETER_READER, type ParameterReader } from '../src/shared/ports/parameter-reader.js';
import { createStaffAccount } from './helpers/staff-account.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';

describePostgres('backoffice parameters and audit log (Nest + PostgreSQL)', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let phone = 3070000001;

  const http = () => request(app.getHttpServer());
  const staff = (role: 'admin' | 'finance' | 'operator') =>
    createStaffAccount(app, pool, role, `+57${phone++}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureHttp(app);
    await app.listen(0, '127.0.0.1');
    pool = app.get(DATABASE_POOL) as pg.Pool;
  });

  beforeEach(async () => {
    await resetPostgresFixtures(pool);
  });

  afterAll(async () => app.close());

  it('serves environment defaults until an admin stores a value, and audits the change', async () => {
    const admin = await staff('admin');
    const finance = await staff('finance');
    const reader = app.get<ParameterReader>(PARAMETER_READER);
    expect(await reader.get('payment.claim_window_hours')).toBe(48n);

    const listed = await http()
      .get('/backoffice/parameters')
      .set({ Authorization: `Bearer ${finance.token}` })
      .expect(200);
    expect(listed.body.items).toHaveLength(11);
    expect(
      listed.body.items.find((item: { key: string }) => item.key === 'payment.claim_window_hours'),
    ).toMatchObject({ value: '48', defaultValue: '48', provisional: true, updatedAt: null });

    await http()
      .put('/backoffice/parameters/payment.claim_window_hours')
      .set({ Authorization: `Bearer ${finance.token}` })
      .send({ value: '24' })
      .expect(403);
    await http()
      .put('/backoffice/parameters/payment.claim_window_hours')
      .set({ Authorization: `Bearer ${admin.token}` })
      .send({ value: '1000' })
      .expect(400);
    await http()
      .put('/backoffice/parameters/payment.unknown')
      .set({ Authorization: `Bearer ${admin.token}` })
      .send({ value: '1' })
      .expect(404);
    const updated = await http()
      .put('/backoffice/parameters/payment.claim_window_hours')
      .set({ Authorization: `Bearer ${admin.token}` })
      .set('X-Forwarded-For', '203.0.113.7')
      .send({ value: '24' })
      .expect(200);
    expect(updated.body).toMatchObject({ value: '24', defaultValue: '48' });
    expect(await reader.get('payment.claim_window_hours')).toBe(24n);

    const audit = await http()
      .get('/backoffice/audit?entity=parameter')
      .set({ Authorization: `Bearer ${admin.token}` })
      .expect(200);
    expect(audit.body.items).toEqual([
      expect.objectContaining({
        actorId: admin.userId,
        actorRole: 'admin',
        action: 'parameter.update',
        entityId: 'payment.claim_window_hours',
        before: { value: '48' },
        after: { value: '24' },
      }),
    ]);
    expect(audit.body.items[0]).not.toHaveProperty('ipHash');
    await http()
      .get('/backoffice/audit')
      .set({ Authorization: `Bearer ${finance.token}` })
      .expect(403);
  });

  it('stores only an HMAC of the client IP and refuses to change or delete audit rows', async () => {
    const admin = await staff('admin');
    await http()
      .put('/backoffice/parameters/order.freight_cop')
      .set({ Authorization: `Bearer ${admin.token}` })
      .send({ value: '12000' })
      .expect(200);

    const [row] = (
      await pool.query<{ ip_hash: string | null; request_id: string | null }>(
        `SELECT ip_hash, request_id FROM backoffice.audit_log`,
      )
    ).rows;
    // Without TRUST_PROXY the address is the socket peer (127.0.0.1 or its IPv6 form).
    const secret = process.env.RATE_LIMIT_HMAC_SECRET!;
    const candidates = ['127.0.0.1', '::ffff:127.0.0.1', '::1'].map((ip) =>
      createHmac('sha256', secret).update(ip).digest('hex'),
    );
    expect(candidates).toContain(row!.ip_hash);
    expect(row!.request_id).toMatch(/^[0-9a-f-]{36}$/);
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'backoffice' AND table_name = 'audit_log'`,
    );
    expect(columns.rows.map(({ column_name }) => column_name)).not.toContain('ip');

    await expect(
      pool.query(`UPDATE backoffice.audit_log SET action = 'x.y'`),
    ).rejects.toMatchObject({
      code: '23000',
    });
    await expect(pool.query(`DELETE FROM backoffice.audit_log`)).rejects.toMatchObject({
      code: '23000',
    });
  });

  it('serializes two admins changing the same parameter, even before it has a stored value', async () => {
    const admins = [await staff('admin'), await staff('admin')];
    for (let iteration = 0; iteration < 10; iteration += 1) {
      await pool.query(`TRUNCATE backoffice.audit_log, backoffice.parameters`);
      const responses = await Promise.all(
        admins.map((admin, index) =>
          http()
            .put('/backoffice/parameters/order.commission_rate_bps')
            .set({ Authorization: `Bearer ${admin.token}` })
            .send({ value: String((index + 1) * 100) }),
        ),
      );
      expect(responses.map(({ status }) => status)).toEqual([200, 200]);
      const audits = await pool.query<{ before: { value: string }; after: { value: string } }>(
        `SELECT before, after FROM backoffice.audit_log ORDER BY at, id`,
      );
      const stored = await pool.query<{ value: string }>(
        `SELECT value FROM backoffice.parameters WHERE key = 'order.commission_rate_bps'`,
      );
      // One change starts from the default, the other from the first one's value.
      expect(audits.rows).toHaveLength(2);
      expect(audits.rows[0]!.before.value).toBe('0');
      expect(audits.rows[1]!.before.value).toBe(audits.rows[0]!.after.value);
      expect(stored.rows[0]!.value).toBe(audits.rows[1]!.after.value);
    }
  }, 120_000);

  it('audits a staff account created by the CLI as a system action, without the phone or name', () => {
    const result = spawnSync(
      resolve('node_modules/.bin/tsx'),
      [
        '--tsconfig',
        'test/tsconfig.worker.json',
        'scripts/create-staff.ts',
        '--phone',
        '+573079999999',
        '--name',
        'Finanzas sintética',
        '--role',
        'finance',
      ],
      { env: { ...process.env, NODE_ENV: 'development' }, cwd: resolve('.'), encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    return pool
      .query<{
        actor_id: string | null;
        actor_role: string;
        action: string;
        entity_id: string;
        after: Record<string, unknown>;
      }>(`SELECT actor_id, actor_role, action, entity_id, after FROM backoffice.audit_log`)
      .then(async ({ rows }) => {
        const user = await pool.query<{ id: string }>(
          `SELECT id FROM identity.users WHERE phone = '+573079999999'`,
        );
        expect(rows).toEqual([
          {
            actor_id: null,
            actor_role: 'system',
            action: 'staff.create',
            entity_id: user.rows[0]!.id,
            after: { role: 'finance' },
          },
        ]);
      });
  }, 60_000);

  it('applies stored parameters to new quotes and audits staff catalog actions, through the real wiring', async () => {
    const admin = await staff('admin');
    const operator = await staff('operator');
    const auth = (account: { token: string }) => ({ Authorization: `Bearer ${account.token}` });
    for (const [key, value] of [
      ['order.commission_rate_bps', '1000'],
      ['order.freight_cop', '5000'],
      ['order.quote_ttl_hours', '2'],
    ])
      await http()
        .put(`/backoffice/parameters/${key}`)
        .set(auth(admin))
        .send({ value })
        .expect(200);

    const categoryId = createId();
    const productId = createId();
    await http()
      .post('/catalog/categories')
      .set(auth(operator))
      .send({ id: categoryId, name: 'Tubérculos', parentId: null })
      .expect(201);
    await http()
      .post('/catalog/products')
      .set(auth(operator))
      .send({ id: productId, categoryId, name: 'Papa criolla', unit: 'kg', attributes: {} })
      .expect(201);
    const lotId = createId();
    await pool.query(
      `INSERT INTO catalog.lots (id, provider_id, product_id, quantity, unit, unit_price, quality_grade,
         available_from, available_until, location_lat, location_lng, status, version, created_at, updated_at)
       VALUES ($1, $2, $3, 10, 'kg', 4500, NULL, NOW(), NOW() + INTERVAL '7 days', 4.6, -74.1,
         'published', 1, NOW(), NOW())`,
      [lotId, createId(), productId],
    );
    const buyerId = createId();
    const before = Date.now();
    const order = await app.get(OrderingService).createOrder(
      { sub: buyerId, role: 'buyer' },
      {
        id: createId(),
        buyerId,
        lines: [{ lotId, quantityMilli: 2000n }],
        deliveryAddress: 'Calle sintética 1, Bogotá',
        deliveryWindow: null,
      },
    );
    expect(order.quote).toMatchObject({
      subtotal: 9000n,
      commission: 900n,
      freight: 5000n,
      total: 14000n,
      providerNet: 8100n,
    });
    const ttl = order.quote.validUntil.getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(2 * 3_600_000 - 1000);
    expect(ttl).toBeLessThanOrEqual(2 * 3_600_000 + 5000);

    const audit = await pool.query<{ actor_id: string; action: string; entity_id: string }>(
      `SELECT actor_id, action, entity_id FROM backoffice.audit_log
       WHERE entity IN ('category', 'product') ORDER BY at, id`,
    );
    expect(audit.rows).toEqual([
      { actor_id: operator.userId, action: 'category.create', entity_id: categoryId },
      { actor_id: operator.userId, action: 'product.create', entity_id: productId },
    ]);
  });

  it('reports each module aggregates to the staff, computed on demand', async () => {
    const operator = await staff('operator');
    const categoryId = createId();
    const productId = createId();
    await pool.query(
      `INSERT INTO catalog.categories (id, name, depth, created_at, updated_at) VALUES ($1, 'C', 1, now(), now())`,
      [categoryId],
    );
    await pool.query(
      `INSERT INTO catalog.products (id, category_id, name, unit, search_text, attributes, created_at, updated_at)
       VALUES ($1, $2, 'Papa', 'kg', 'papa', '{}', now(), now())`,
      [productId, categoryId],
    );
    const lotId = createId();
    await pool.query(
      `INSERT INTO catalog.lots (id, provider_id, product_id, quantity, unit, unit_price, quality_grade,
         available_from, available_until, location_lat, location_lng, status, version, created_at, updated_at)
       VALUES ($1, $2, $3, 10, 'kg', 4500, NULL, NOW(), NOW() + INTERVAL '7 days', 4.6, -74.1,
         'published', 1, NOW(), NOW())`,
      [lotId, createId(), productId],
    );
    const buyerId = createId();
    await app.get(OrderingService).createOrder(
      { sub: buyerId, role: 'buyer' },
      {
        id: createId(),
        buyerId,
        lines: [{ lotId, quantityMilli: 1000n }],
        deliveryAddress: 'Calle sintética 3, Bogotá',
        deliveryWindow: null,
      },
    );

    const response = await http()
      .get('/backoffice/metrics')
      .set({ Authorization: `Bearer ${operator.token}` })
      .expect(200);

    expect(response.body).toMatchObject({
      ordersByStatus: expect.objectContaining({ quoted: 1, paid: 0, cancelled: 0 }),
      paidOrdersTotalCop: '0',
      lotsByStatus: expect.objectContaining({ published: 1, sold_out: 0 }),
      payments: {
        proofsAwaitingReview: 0,
        oldestProofUploadedAt: null,
        openDisputes: 0,
        settlementsIssued: { count: 0, amountCop: '0' },
        settlementsPaid: { count: 0, amountCop: '0' },
      },
      notificationDeliveries: { pending: 0, sent: 0, failed: 0, skipped: 0 },
      outbox: { pending: 2, deadLettered: 0 },
    });
    // Finance reads them too; non-staff roles get 403 (backoffice-service.spec.ts).
    const finance = await staff('finance');
    await http()
      .get('/backoffice/metrics')
      .set({ Authorization: `Bearer ${finance.token}` })
      .expect(200);
  });
});
