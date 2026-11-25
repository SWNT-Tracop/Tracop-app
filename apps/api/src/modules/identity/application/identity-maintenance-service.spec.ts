import { IdentityMaintenanceService } from './identity-maintenance-service.js';
import type { IdentityRetentionRepository } from '../ports/identity-ports.js';

const now = new Date('2026-11-20T12:00:00.000Z');
const settings = {
  otpRetentionDays: 7,
  sessionRetentionDays: 30,
  rateLimitRetentionSeconds: 3600,
  unverifiedRetentionHours: 24,
  pseudonymSecret: 'p'.repeat(32),
};

const repository = (batches: { otp?: number[]; sessions?: number[]; rate?: number[] } = {}) => {
  const take = (list: number[] | undefined) => async () => list?.shift() ?? 0;
  const otp = take(batches.otp);
  const sessions = take(batches.sessions);
  const rate = take(batches.rate);
  return {
    deleteOtpCodesExpiredBefore: jest.fn<Promise<number>, [Date, number]>(() => otp()),
    deleteSessionsEndedBefore: jest.fn<Promise<number>, [Date, number]>(() => sessions()),
    deleteRateLimitWindowsBefore: jest.fn<Promise<number>, [Date, number]>(() => rate()),
    expireUnverifiedBefore: jest.fn<
      Promise<number>,
      [Date, number, (userId: string, phone: string) => string, Date]
    >(async () => 0),
  } satisfies IdentityRetentionRepository;
};

describe('IdentityMaintenanceService', () => {
  it('derives every cutoff from the injected clock and the retention settings', async () => {
    const retention = repository();
    const service = new IdentityMaintenanceService(retention, { now: () => now }, settings);
    await service.purgeExpiredOtpCodes();
    await service.purgeEndedSessions();
    await service.purgeRateLimitWindows();
    expect(retention.deleteOtpCodesExpiredBefore).toHaveBeenCalledWith(
      new Date('2026-11-13T12:00:00.000Z'),
      1000,
    );
    expect(retention.deleteSessionsEndedBefore).toHaveBeenCalledWith(
      new Date('2026-10-21T12:00:00.000Z'),
      1000,
    );
    expect(retention.deleteRateLimitWindowsBefore).toHaveBeenCalledWith(
      new Date('2026-11-20T11:00:00.000Z'),
      1000,
    );
  });

  it('keeps deleting full batches until a partial one and reports the totals', async () => {
    const retention = repository({ otp: [1000, 1000, 3], sessions: [10], rate: [0] });
    const service = new IdentityMaintenanceService(retention, { now: () => now }, settings);
    expect({
      otpCodes: await service.purgeExpiredOtpCodes(),
      sessions: await service.purgeEndedSessions(),
      rateLimitWindows: await service.purgeRateLimitWindows(),
    }).toEqual({ otpCodes: 2003, sessions: 10, rateLimitWindows: 0 });
    expect(retention.deleteOtpCodesExpiredBefore).toHaveBeenCalledTimes(3);
  });

  it('stops after a bounded number of batches', async () => {
    const retention = repository({ otp: Array.from({ length: 500 }, () => 1000) });
    const service = new IdentityMaintenanceService(retention, { now: () => now }, settings);
    expect(await service.purgeExpiredOtpCodes()).toBe(100_000);
    expect(retention.deleteOtpCodesExpiredBefore).toHaveBeenCalledTimes(100);
  });

  it('expires registrations unverified for longer than the retention, with a keyed pseudonym', async () => {
    const retention = repository();
    const service = new IdentityMaintenanceService(retention, { now: () => now }, settings);
    await service.expireUnverifiedRegistrations();
    const [cutoff, limit, pseudonym, at] = retention.expireUnverifiedBefore.mock.calls[0]!;
    expect([cutoff, limit, at]).toEqual([new Date('2026-11-19T12:00:00.000Z'), 1000, now]);
    const first = pseudonym('u1', '+573001112233');
    expect(first).toMatch(/^expired:[0-9a-f]{64}$/);
    expect(first.includes('3001112233')).toBe(false);
    // Unique per registration even for the same phone, so two expired rows never collide.
    expect(pseudonym('u2', '+573001112233')).not.toBe(first);
    expect(pseudonym('u1', '+573001112233')).toBe(first);
  });
});
