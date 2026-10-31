import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import pg from 'pg';
import { AppModule } from '../src/bootstrap/app.module.js';
import { APP_ENVIRONMENT, DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { HmacPasswordlessHasher } from '../src/modules/identity/adapters/out/crypto-services.js';
import { PostgresRateLimiter } from '../src/modules/identity/adapters/out/drizzle-repositories.js';
import { PhoneNumber } from '../src/modules/identity/domain/phone-number.js';
import { OTP_SENDER } from '../src/modules/identity/ports/tokens.js';
import { InMemoryOtpSender } from '../src/modules/identity/adapters/out/otp-senders.js';
import type { AppEnvironment } from '../src/shared/infra/env.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';

describePostgres('identity authentication flow (PostgreSQL Testcontainers)', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let otpSender: InMemoryOtpSender;
  let phoneSequence = 1;

  const nextPhone = (): string => `300${String(phoneSequence++).padStart(7, '0')}`;
  const nextDevice = (): string => randomUUID();

  const register = async (phone = nextPhone(), role = 'buyer') => {
    const deviceId = nextDevice();
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        phone,
        role,
        fullName: 'Persona de prueba',
        deviceId,
        platform: 'web',
        consent: { accepted: true, version: 'v0-draft' },
      });
    return { response, phone, deviceId };
  };

  const verify = async (phone: string, deviceId: string, code: string) =>
    request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone, deviceId, platform: 'web', code });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await resetPostgresFixtures(pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    otpSender = app.get(OTP_SENDER) as InMemoryOtpSender;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('completes registration, OTP verification, /me, refresh rotation and logout', async () => {
    const { response: registered, phone, deviceId } = await register();
    expect(registered.status).toBe(201);
    expect(registered.body.message).toBe('Si el registro puede continuar, recibirás un código.');
    const code = otpSender.sent.at(-1)?.code;
    expect(code).toMatch(/^\d{6}$/);

    const verified = await verify(phone, deviceId, code!);
    expect(verified.status).toBe(201);
    expect(verified.body.user.status).toBe('active');
    const originalRefresh = verified.body.refreshToken as string;

    const me = await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${verified.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.phone).toBe(`+57${phone}`);

    const refreshed = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: originalRefresh, deviceId });
    expect(refreshed.status).toBe(201);
    await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
      .expect(201);
    expect(
      (
        await request(app.getHttpServer())
          .post('/auth/refresh')
          .send({ refreshToken: refreshed.body.refreshToken, deviceId })
      ).status,
    ).toBe(401);
  });

  it('detects a reused rotated refresh token and revokes every session in its family', async () => {
    const { phone, deviceId } = await register();
    const verified = await verify(phone, deviceId, otpSender.sent.at(-1)!.code);
    expect(verified.status).toBe(201);
    const oldRefreshToken = verified.body.refreshToken as string;
    const rotated = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: oldRefreshToken, deviceId });
    expect(rotated.status).toBe(201);
    const refreshReuse = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: oldRefreshToken, deviceId });
    expect(refreshReuse.status).toBe(401);
    await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${rotated.body.accessToken}`)
      .expect(401);

    const familyRows = await pool.query<{ revoked_reason: string | null; revoked_at: Date | null }>(
      'SELECT revoked_reason, revoked_at FROM identity.sessions WHERE family_id = $1',
      [await thisFamilyId(pool, oldRefreshToken)],
    );
    expect(familyRows.rows.length).toBeGreaterThanOrEqual(2);
    expect(
      familyRows.rows.every(
        (row) => row.revoked_reason === 'reuse_detected' && row.revoked_at !== null,
      ),
    ).toBe(true);
    const revocationEvents = await pool.query<{ count: string }>(
      `SELECT count(*) FROM shared.outbox_events WHERE type = 'SessionRevoked' AND payload->>'reason' = 'reuse_detected'`,
    );
    expect(Number(revocationEvents.rows[0]?.count)).toBeGreaterThan(0);
  });

  it('requires the current consent version and rejects privileged self-registration', async () => {
    const phone = nextPhone();
    const base = {
      phone,
      role: 'buyer',
      fullName: 'Persona',
      deviceId: nextDevice(),
      platform: 'web',
    };
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ ...base, consent: { accepted: true, version: 'old-version' } })
      .expect(409);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ ...base, consent: { accepted: false, version: 'v0-draft' } })
      .expect(400);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ ...base, role: 'admin', consent: { accepted: true, version: 'v0-draft' } })
      .expect(403);
  });

  it('keeps consent records append-only in PostgreSQL', async () => {
    const account = await register();
    const consent = await pool.query<{ id: string }>(
      `SELECT c.id FROM identity.consents c
       JOIN identity.users u ON u.id = c.user_id WHERE u.phone = $1`,
      [`+57${account.phone}`],
    );
    expect(consent.rowCount).toBe(1);
    await expect(
      pool.query('UPDATE identity.consents SET version = $1 WHERE id = $2', [
        'tampered',
        consent.rows[0]!.id,
      ]),
    ).rejects.toThrow('append-only');
  });

  it('rejects unauthenticated access and protected profile changes', async () => {
    await request(app.getHttpServer()).get('/me').expect(401);
    const account = await register();
    const verified = await verify(account.phone, account.deviceId, otpSender.sent.at(-1)!.code);
    const auth = `Bearer ${verified.body.accessToken}`;
    await request(app.getHttpServer())
      .patch('/me')
      .set('Authorization', auth)
      .send({ role: 'admin' })
      .expect(400);
    const updated = await request(app.getHttpServer())
      .patch('/me')
      .set('Authorization', auth)
      .send({ fullName: 'Nombre actualizado' })
      .expect(200);
    expect(updated.body.fullName).toBe('Nombre actualizado');
  });

  it('rejects an expired OTP and an incorrect OTP', async () => {
    const expiredUser = await register();
    const expiredCode = otpSender.sent.at(-1)!.code;
    await pool.query(
      `UPDATE identity.otp_codes SET expires_at = now() - interval '1 second'
       WHERE user_id = (SELECT id FROM identity.users WHERE phone = $1)`,
      [`+57${expiredUser.phone}`],
    );
    expect((await verify(expiredUser.phone, expiredUser.deviceId, expiredCode)).status).toBe(401);

    const wrongUser = await register();
    const correctCode = otpSender.sent.at(-1)!.code;
    const wrongCode = correctCode === '999999' ? '000000' : '999999';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await verify(wrongUser.phone, wrongUser.deviceId, wrongCode);
      expect([401, 429]).toContain(result.status);
    }
    expect(correctCode).not.toBe(wrongCode);
    expect((await verify(wrongUser.phone, wrongUser.deviceId, correctCode)).status).toBe(429);
  });

  it('returns the same generic OTP response for existing and unknown phone numbers', async () => {
    const existingPhone = nextPhone();
    const createdAt = new Date();
    await pool.query(
      `INSERT INTO identity.users (id, role, full_name, phone, status, locale, phone_verified_at, created_at, updated_at)
       VALUES ($1, 'buyer', 'Usuario preexistente', $2, 'active', 'es-CO', $3, $3, $3)`,
      [randomUUID(), `+57${existingPhone}`, createdAt],
    );
    const existingResponse = await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone: existingPhone });
    const unknownResponse = await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone: nextPhone() });
    expect(existingResponse.status).toBe(201);
    expect(unknownResponse.status).toBe(201);
    expect(existingResponse.body).toEqual(unknownResponse.body);
  });

  it('rate limits OTP requests without revealing account existence', async () => {
    const phone = nextPhone();
    const first = await request(app.getHttpServer()).post('/auth/otp/request').send({ phone });
    const second = await request(app.getHttpServer()).post('/auth/otp/request').send({ phone });
    expect(first.status).toBe(201);
    expect(first.body.message).toBe('Si el número puede autenticarse, recibirás un código.');
    expect(second.status).toBe(429);
  });

  it('rejects invalid phone syntax and requests OTP generically for unknown numbers', async () => {
    await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone: 'not-a-phone' })
      .expect(400);
    const unknown = await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone: nextPhone() })
      .expect(201);
    expect(unknown.body.message).toBe('Si el número puede autenticarse, recibirás un código.');
  });

  it('logs out the current session', async () => {
    const account = await register();
    const verified = await verify(account.phone, account.deviceId, otpSender.sent.at(-1)!.code);
    const authorization = `Bearer ${verified.body.accessToken}`;
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', authorization)
      .expect(201);
    await request(app.getHttpServer()).get('/me').set('Authorization', authorization).expect(401);
  });

  it('keeps one live refresh family per device across repeated OTP logins', async () => {
    const account = await register();
    const firstLogin = await verify(account.phone, account.deviceId, otpSender.sent.at(-1)!.code);
    expect(firstLogin.status).toBe(201);
    const userResult = await pool.query<{ id: string }>(
      'SELECT id FROM identity.users WHERE phone = $1',
      [`+57${account.phone}`],
    );
    const userId = userResult.rows[0]!.id;
    const environment = app.get<AppEnvironment>(APP_ENVIRONMENT);
    const hasher = new HmacPasswordlessHasher(environment);
    const secondCode = '654321';
    const parsedPhone = PhoneNumber.parse(account.phone);
    if (!parsedPhone.ok) throw parsedPhone.error;
    await pool.query(
      `INSERT INTO identity.otp_codes (id, user_id, code_hash, purpose, attempts, max_attempts, expires_at, created_at)
       VALUES ($1, $2, $3, 'login', 0, 5, now() + interval '5 minutes', now())`,
      [randomUUID(), userId, hasher.hashOtp(parsedPhone.value, 'login', secondCode)],
    );
    const secondLogin = await verify(account.phone, account.deviceId, secondCode);
    expect(secondLogin.status).toBe(201);
    const sessionRows = await pool.query<{
      family_id: string;
      revoked_reason: string | null;
      revoked_at: Date | null;
    }>(
      'SELECT family_id, revoked_reason, revoked_at FROM identity.sessions WHERE user_id = $1 AND device_id = $2 ORDER BY created_at',
      [userId, account.deviceId],
    );
    expect(sessionRows.rows).toHaveLength(2);
    expect(sessionRows.rows[0]!.family_id).not.toBe(sessionRows.rows[1]!.family_id);
    expect(sessionRows.rows[0]!.revoked_reason).toBe('new_login');
    expect(sessionRows.rows[0]!.revoked_at).not.toBeNull();
    expect(sessionRows.rows[1]!.revoked_at).toBeNull();
  });

  it('allows exactly 3 of 20 concurrent rate-limit consumes for the same key and window', async () => {
    const env = app.get<AppEnvironment>(APP_ENVIRONMENT);
    const poolToken = app.get<pg.Pool>(DATABASE_POOL);
    const limiter = new PostgresRateLimiter(poolToken, new HmacPasswordlessHasher(env));
    const key = `integration:concurrency:${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => limiter.consume(key, 3, 600)),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(3);
    expect(results.filter((result) => !result.allowed)).toHaveLength(17);
  });

  it('never increments OTP attempts beyond max_attempts under concurrent verification', async () => {
    const account = await register();
    const correctCode = otpSender.sent.at(-1)!.code;
    const wrongCode = correctCode === '000000' ? '111111' : '000000';
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => verify(account.phone, account.deviceId, wrongCode)),
    );
    for (const response of responses) expect([401, 429]).toContain(response.status);
    const otpRow = await pool.query<{ attempts: number; max_attempts: number }>(
      `SELECT attempts, max_attempts FROM identity.otp_codes
       WHERE user_id = (SELECT id FROM identity.users WHERE phone = $1)
       ORDER BY created_at DESC LIMIT 1`,
      [`+57${account.phone}`],
    );
    expect(otpRow.rows[0]!.attempts).toBe(otpRow.rows[0]!.max_attempts);
    expect(otpRow.rows[0]!.attempts).toBeLessThanOrEqual(5);
  });

  it('rotates exactly once when two refreshes race with the same token and revokes the family', async () => {
    const account = await register();
    const verified = await verify(account.phone, account.deviceId, otpSender.sent.at(-1)!.code);
    expect(verified.status).toBe(201);
    const refreshToken = verified.body.refreshToken as string;
    const send = () =>
      request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken, deviceId: account.deviceId });
    const responses = await Promise.all([send(), send()]);
    expect(
      responses.map((response) => response.status).sort((left, right) => left - right),
    ).toEqual([201, 401]);
    const familyId = await thisFamilyId(pool, refreshToken);
    const familyRows = await pool.query<{ revoked_reason: string | null }>(
      'SELECT revoked_reason FROM identity.sessions WHERE family_id = $1',
      [familyId],
    );
    expect(familyRows.rows.length).toBeGreaterThanOrEqual(2);
    expect(familyRows.rows.every((row) => row.revoked_reason === 'reuse_detected')).toBe(true);
  });
});

async function thisFamilyId(database: pg.Pool, refreshToken: string): Promise<string> {
  const crypto = await import('node:crypto');
  const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const result = await database.query<{ family_id: string }>(
    'SELECT family_id FROM identity.sessions WHERE refresh_hash = $1',
    [refreshHash],
  );
  return result.rows[0]!.family_id;
}
