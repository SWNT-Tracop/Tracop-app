import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type pg from 'pg';
import request from 'supertest';
import { AppModule } from '../src/bootstrap/app.module.js';
import { InMemoryOtpSender } from '../src/modules/identity/adapters/out/otp-senders.js';
import { OTP_SENDER } from '../src/modules/identity/ports/tokens.js';
import { loadAppEnvironment } from '../src/shared/infra/env.js';
import { APP_ENVIRONMENT, DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { createId } from '../src/shared/kernel/ids.js';
import { createStaffAccount } from './helpers/staff-account.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';

describePostgres('admin account actions: role change and suspension (Nest + PostgreSQL)', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let otp: InMemoryOtpSender;
  let admin: string;
  let adminId: string;
  let operator: string;
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const buyer = async (phone: string) => {
    const deviceId = createId();
    await http()
      .post('/auth/register')
      .send({
        phone,
        role: 'buyer',
        fullName: 'Jurado sintético',
        deviceId,
        platform: 'web',
        consent: { accepted: true, version: 'v0-draft' },
      })
      .expect(201);
    const verified = await http()
      .post('/auth/otp/verify')
      .send({ phone, deviceId, platform: 'web', code: otp.sent.at(-1)?.code })
      .expect(201);
    return {
      token: verified.body.accessToken as string,
      refresh: verified.body.refreshToken as string,
      deviceId,
      id: verified.body.user.id as string,
    };
  };

  beforeAll(async () => {
    otp = new InMemoryOtpSender();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_ENVIRONMENT)
      .useValue({ ...loadAppEnvironment(), OTP_PHONE_COOLDOWN_LIMIT: 5, OTP_PHONE_LIMIT: 10 })
      .overrideProvider(OTP_SENDER)
      .useValue(otp)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    pool = app.get(DATABASE_POOL) as pg.Pool;
    await resetPostgresFixtures(pool);
    const adminAccount = await createStaffAccount(app, pool, 'admin', '+573069990001');
    admin = adminAccount.token;
    adminId = adminAccount.userId;
    operator = (await createStaffAccount(app, pool, 'operator', '+573069990002')).token;
  });

  afterAll(async () => {
    await app.close();
  });

  it('finds an account by phone without exposing the phone', async () => {
    const account = await buyer('3077000001');
    const found = await http()
      .get('/staff/users')
      .query({ phone: '3077000001' })
      .set(auth(admin))
      .expect(200);
    expect(found.body).toEqual({
      id: account.id,
      role: 'buyer',
      status: 'active',
      fullName: 'Jurado sintético',
      phoneLast4: '0001',
    });
    await http().get('/staff/users').query({ phone: '3077000001' }).set(auth(operator)).expect(403);
    await http().get('/staff/users').query({ phone: '3077009999' }).set(auth(admin)).expect(404);
  });

  it('changes a buyer into a producer, signs them out and audits it', async () => {
    const account = await buyer('3077000002');
    await http().get('/lots/mine').set(auth(account.token)).expect(403);

    const changed = await http()
      .post(`/staff/users/${account.id}/role`)
      .set(auth(admin))
      .send({ role: 'producer', reason: 'Prueba del jurado como productor' })
      .expect(200);
    expect(changed.body).toMatchObject({ role: 'producer', status: 'active' });

    // The old session is gone: neither the access token nor the refresh token work.
    await http().get('/me').set(auth(account.token)).expect(401);
    await http()
      .post('/auth/refresh')
      .send({ refreshToken: account.refresh, deviceId: account.deviceId })
      .expect(401);

    const audit = await pool.query<{ action: string; before: unknown; after: unknown }>(
      `SELECT action, before, after FROM backoffice.audit_log WHERE entity_id = $1`,
      [account.id],
    );
    expect(audit.rows).toEqual([
      {
        action: 'user.change_role',
        before: { role: 'buyer' },
        after: { role: 'producer', status: 'active', reason: 'Prueba del jurado como productor' },
      },
    ]);
    const events = await pool.query<{ type: string }>(
      `SELECT type FROM shared.outbox_events WHERE aggregate = $1 AND type IN ('UserRoleChanged', 'SessionRevoked') ORDER BY type`,
      [account.id],
    );
    expect(events.rows.map(({ type }) => type)).toEqual(['SessionRevoked', 'UserRoleChanged']);

    // Signing in again gives a producer session.
    await http().post('/auth/otp/request').send({ phone: '3077000002' }).expect(201);
    const again = await http()
      .post('/auth/otp/verify')
      .send({
        phone: '3077000002',
        deviceId: account.deviceId,
        platform: 'web',
        code: otp.sent.at(-1)?.code,
      })
      .expect(201);
    expect(again.body.user.role).toBe('producer');
    await http().get('/lots/mine').set(auth(again.body.accessToken)).expect(200);
  });

  it('refuses staff roles, the same role, the own account and a missing reason', async () => {
    const account = await buyer('3077000003');
    const change = (userId: string, body: Record<string, unknown>) =>
      http().post(`/staff/users/${userId}/role`).set(auth(admin)).send(body);
    expect((await change(account.id, { role: 'admin', reason: 'Intento' })).status).toBe(400);
    expect((await change(account.id, { role: 'buyer', reason: 'Igual' })).body.code).toBe(
      'same_role',
    );
    expect((await change(adminId, { role: 'buyer', reason: 'Propia' })).body.code).toBe(
      'own_account',
    );
    expect((await change(account.id, { role: 'producer', reason: ' ' })).status).toBe(400);
    const otherAdmin = await createStaffAccount(app, pool, 'admin', '+573069990003');
    expect(
      (
        await http()
          .post(`/staff/users/${otherAdmin.userId}/suspend`)
          .set(auth(admin))
          .send({ reason: 'Otro admin' })
      ).body.code,
    ).toBe('staff_account');
    expect(
      (
        await http()
          .post(`/staff/users/${account.id}/role`)
          .set(auth(operator))
          .send({ role: 'producer', reason: 'Operador' })
      ).status,
    ).toBe(403);
  });

  it('suspends an account at once and reactivates it', async () => {
    const account = await buyer('3077000004');
    const sentBefore = otp.sent.length;
    await http()
      .post(`/staff/users/${account.id}/suspend`)
      .set(auth(admin))
      .send({ reason: 'Cuenta de prueba de la sustentación' })
      .expect(200)
      .expect(({ body }) => expect(body.status).toBe('suspended'));
    await http().get('/me').set(auth(account.token)).expect(401);
    await http().post('/auth/otp/request').send({ phone: '3077000004' }).expect(201);
    expect(otp.sent).toHaveLength(sentBefore);

    await http()
      .post(`/staff/users/${account.id}/suspend`)
      .set(auth(admin))
      .send({ reason: 'Otra vez' })
      .expect(409);
    await http()
      .post(`/staff/users/${account.id}/reactivate`)
      .set(auth(admin))
      .send({ reason: 'Fin de la prueba' })
      .expect(200)
      .expect(({ body }) => expect(body.status).toBe('active'));
    await http().post('/auth/otp/request').send({ phone: '3077000004' }).expect(201);
    expect(otp.sent).toHaveLength(sentBefore + 1);
  });
});
