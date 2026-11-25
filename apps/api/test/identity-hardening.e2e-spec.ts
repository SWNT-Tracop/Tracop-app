import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../src/bootstrap/app.module.js';
import { InMemoryOtpSender } from '../src/modules/identity/adapters/out/otp-senders.js';
import {
  IDENTITY_MAINTENANCE,
  type IdentityMaintenanceApi,
} from '../src/modules/identity/index.js';
import { OTP_SENDER } from '../src/modules/identity/ports/tokens.js';
import { APP_CLOCK, DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { createId } from '../src/shared/kernel/ids.js';
import { createStaffAccount } from './helpers/staff-account.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';

/** The application clock, moved by hand (grace window and registration expiry). */
class ManualClock {
  private current = new Date();
  reset(): void {
    this.current = new Date();
  }
  now(): Date {
    return new Date(this.current);
  }
  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

describePostgres(
  'identity hardening: refresh grace, unverified expiry, staff unlink (Nest + PostgreSQL)',
  () => {
    let app: INestApplication;
    let pool: pg.Pool;
    let otpSender: InMemoryOtpSender;
    let clock: ManualClock;
    let phoneSequence = 1;

    const http = () => request(app.getHttpServer());
    const nextPhone = () => `312${String(phoneSequence++).padStart(7, '0')}`;

    const register = async (phone = nextPhone(), role: 'buyer' | 'producer' = 'buyer') => {
      const deviceId = createId();
      await http()
        .post('/auth/register')
        .send({
          phone,
          role,
          fullName: 'Persona sintética',
          deviceId,
          platform: 'web',
          consent: { accepted: true, version: 'v0-draft' },
        })
        .expect(201);
      return { phone, deviceId };
    };

    const verified = async () => {
      const { phone, deviceId } = await register();
      clock.advanceSeconds(1);
      const session = await http()
        .post('/auth/otp/verify')
        .send({ phone, deviceId, platform: 'web', code: otpSender.sent.at(-1)?.code })
        .expect(201);
      return {
        phone,
        deviceId,
        userId: session.body.user.id as string,
        token: session.body.accessToken as string,
        refreshToken: session.body.refreshToken as string,
      };
    };

    const refresh = (refreshToken: string, deviceId: string) =>
      http().post('/auth/refresh').send({ refreshToken, deviceId });

    const familyOf = async (userId: string) =>
      (
        await pool.query<{ revoked_reason: string | null; rotated: boolean }>(
          `SELECT revoked_reason, rotated_at IS NOT NULL AS rotated FROM identity.sessions WHERE user_id = $1 ORDER BY created_at, id`,
          [userId],
        )
      ).rows;

    beforeAll(async () => {
      otpSender = new InMemoryOtpSender();
      clock = new ManualClock();
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(OTP_SENDER)
        .useValue(otpSender)
        .overrideProvider(APP_CLOCK)
        .useValue(clock)
        .compile();
      app = moduleRef.createNestApplication();
      await app.listen(0, '127.0.0.1');
      pool = app.get(DATABASE_POOL) as pg.Pool;
    });

    afterAll(async () => app?.close());

    beforeEach(async () => {
      await resetPostgresFixtures(pool);
      otpSender.sent.length = 0;
      // Access tokens are checked against real time, so each test starts from it.
      clock.reset();
    });

    it('answers a refresh retried within the grace window and keeps the family alive', async () => {
      const user = await verified();
      const lost = await refresh(user.refreshToken, user.deviceId).expect(201);
      clock.advanceSeconds(10);
      const retried = await refresh(user.refreshToken, user.deviceId).expect(201);
      expect(retried.body.refreshToken).not.toBe(lost.body.refreshToken);
      await refresh(lost.body.refreshToken, user.deviceId).expect(401);
      await refresh(retried.body.refreshToken, user.deviceId).expect(201);
      const reasons = (await familyOf(user.userId)).map(({ revoked_reason }) => revoked_reason);
      expect(reasons).toContain('grace_replaced');
      expect(reasons).not.toContain('reuse_detected');
    });

    it('serializes two simultaneous grace retries: one live session remains', async () => {
      const user = await verified();
      await refresh(user.refreshToken, user.deviceId).expect(201);
      clock.advanceSeconds(3);
      const [first, second] = await Promise.all([
        refresh(user.refreshToken, user.deviceId),
        refresh(user.refreshToken, user.deviceId),
      ]);
      expect([first.status, second.status]).toEqual([201, 201]);
      const live = (await familyOf(user.userId)).filter(
        ({ revoked_reason, rotated }) => !revoked_reason && !rotated,
      );
      expect(live).toHaveLength(1);
    });

    it('revokes the family when the retry comes after the window or the successor was used', async () => {
      const late = await verified();
      await refresh(late.refreshToken, late.deviceId).expect(201);
      clock.advanceSeconds(31); // REFRESH_GRACE_SECONDS = 30
      await refresh(late.refreshToken, late.deviceId).expect(401);
      expect(
        (await familyOf(late.userId)).every(
          ({ revoked_reason }) => revoked_reason === 'reuse_detected',
        ),
      ).toBe(true);

      const used = await verified();
      const next = await refresh(used.refreshToken, used.deviceId).expect(201);
      await refresh(next.body.refreshToken, used.deviceId).expect(201);
      clock.advanceSeconds(1);
      await refresh(used.refreshToken, used.deviceId).expect(401);
      expect(
        (await familyOf(used.userId)).every(
          ({ revoked_reason }) => revoked_reason === 'reuse_detected',
        ),
      ).toBe(true);

      const other = await verified();
      await refresh(other.refreshToken, other.deviceId).expect(201);
      await refresh(other.refreshToken, createId()).expect(401);
    });

    it('expires registrations never verified, frees the phone and keeps no clear phone or name', async () => {
      const { phone } = await register();
      const kept = await verified();
      clock.advanceSeconds(23 * 3600);
      const maintenance = app.get<IdentityMaintenanceApi>(IDENTITY_MAINTENANCE);
      expect(await maintenance.expireUnverifiedRegistrations()).toBe(0);
      clock.advanceSeconds(3600 + 1); // UNVERIFIED_RETENTION_HOURS = 24
      expect(await maintenance.expireUnverifiedRegistrations()).toBe(1);
      expect(await maintenance.expireUnverifiedRegistrations()).toBe(0);

      const rows = await pool.query<{ status: string; phone: string; full_name: string }>(
        `SELECT status, phone, full_name FROM identity.users ORDER BY created_at`,
      );
      const expired = rows.rows.find(({ status }) => status === 'expired')!;
      expect(expired.phone).toMatch(/^expired:[0-9a-f]{64}$/);
      expect(expired.full_name).toBe('');
      expect(rows.rows.some(({ phone: stored }) => stored.includes(phone))).toBe(false);
      expect(rows.rows.find(({ status }) => status === 'active')).toBeDefined();
      expect(kept.userId).toEqual(expect.any(String));

      // The number can be registered again and verified.
      // The OTP limits per phone count on the database clock, not the manual one: clear them as
      // the 24 h that passed would have.
      await pool.query('TRUNCATE identity.rate_limit_counters');
      const sentBefore = otpSender.sent.length;
      const again = await register(phone);
      expect(otpSender.sent.length).toBe(sentBefore + 1);
      const answer = await http()
        .post('/auth/otp/verify')
        .send({
          phone,
          deviceId: again.deviceId,
          platform: 'web',
          code: otpSender.sent.at(-1)?.code,
        });
      expect([answer.status, answer.body.code]).toEqual([201, undefined]);
    });

    it('lets staff unlink a messaging channel, audited without the phone', async () => {
      const user = await verified();
      const operator = await createStaffAccount(app, pool, 'operator', `+57${nextPhone()}`);
      await pool.query(
        `INSERT INTO identity.channel_links (id, user_id, channel, channel_user_id, verified_at, created_at)
       VALUES ($1, $2, 'telegram', '900123', now(), now())`,
        [createId(), user.userId],
      );
      const path = `/staff/users/${user.userId}/channels/telegram/unlink`;
      await http()
        .post(path)
        .set({ Authorization: `Bearer ${user.token}` })
        .expect(403);
      await http()
        .post(`/staff/users/${user.userId}/channels/sms/unlink`)
        .set({ Authorization: `Bearer ${operator.token}` })
        .expect(400);
      await http()
        .post(path)
        .set({ Authorization: `Bearer ${operator.token}` })
        .expect(204);
      await http()
        .post(path)
        .set({ Authorization: `Bearer ${operator.token}` })
        .expect(404);
      await http()
        .post(`/staff/users/${createId()}/channels/telegram/unlink`)
        .set({ Authorization: `Bearer ${operator.token}` })
        .expect(404);
      expect(
        (
          await pool.query(
            `SELECT count(*)::int AS n FROM identity.channel_links WHERE user_id = $1`,
            [user.userId],
          )
        ).rows[0].n,
      ).toBe(0);
      const audit = await pool.query(
        `SELECT action, actor_id, entity_id, before, after FROM backoffice.audit_log WHERE action = 'channel.unlink'`,
      );
      expect(audit.rows).toEqual([
        {
          action: 'channel.unlink',
          actor_id: operator.userId,
          entity_id: user.userId,
          before: { channel: 'telegram', verified: true },
          after: null,
        },
      ]);
      expect(JSON.stringify(audit.rows).includes(user.phone)).toBe(false);
    });
  },
);
