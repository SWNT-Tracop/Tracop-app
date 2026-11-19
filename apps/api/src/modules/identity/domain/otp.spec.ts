import { Otp } from './otp.js';

const now = new Date('2026-01-01T00:00:00.000Z');
const makeOtp = (overrides: Partial<ConstructorParameters<typeof Otp>[0]> = {}) =>
  new Otp({
    id: 'otp-1',
    userId: 'user-1',
    purpose: 'registration',
    codeHash: 'hash',
    expiresAt: new Date(now.getTime() + 60_000),
    attempts: 0,
    maxAttempts: 5,
    consumedAt: null,
    createdAt: now,
    ...overrides,
  });

describe('Otp', () => {
  it('allows an unexpired, unconsumed code below the attempt limit', () => {
    expect(() => makeOtp().assertUsable(now)).not.toThrow();
  });

  it('expires at the exact expiry boundary', () => {
    const otp = makeOtp();
    expect(() => otp.assertUsable(otp.props.expiresAt)).toThrow('vencido');
  });

  it('records failed attempts and prevents further attempts at the maximum', () => {
    const otp = makeOtp({ attempts: 4 });
    expect(() => otp.recordFailedAttempt()).toThrow('agotaron');
    expect(otp.props.attempts).toBe(5);
    expect(() => otp.assertUsable(now)).toThrow('agotaron');
  });

  it('is single use', () => {
    const otp = makeOtp();
    otp.consume(now);
    expect(otp.props.consumedAt).toEqual(now);
    expect(() => otp.assertUsable(now)).toThrow('ya fue utilizado');
  });
});
