import { Session } from './session.js';

const now = new Date('2026-01-01T00:00:00.000Z');
const makeSession = (overrides: Partial<ConstructorParameters<typeof Session>[0]> = {}) =>
  new Session({
    id: 'session-1',
    userId: 'user-1',
    deviceId: 'device-1',
    familyId: 'family-1',
    refreshHash: 'hash',
    expiresAt: new Date(now.getTime() + 60_000),
    createdAt: now,
    rotatedAt: null,
    revokedAt: null,
    revokedReason: null,
    lastUsedAt: null,
    ...overrides,
  });

describe('Session', () => {
  it('rotates an active session and marks it used', () => {
    const session = makeSession();
    session.rotate(now);
    expect(session.props.rotatedAt).toEqual(now);
    expect(session.props.lastUsedAt).toEqual(now);
  });

  it('rejects rotation for expired, rotated, or revoked sessions', () => {
    expect(() => makeSession({ expiresAt: now }).assertActive(now)).toThrow('vencido');
    expect(() => makeSession({ rotatedAt: now }).assertActive(now)).toThrow('no es válida');
    expect(() => makeSession({ revokedAt: now }).assertActive(now)).toThrow('no es válida');
  });

  it('records revocation reason and emits a family revocation event', () => {
    const session = makeSession();
    session.revoke(now, 'reuse_detected');
    expect(session.props.revokedReason).toBe('reuse_detected');
    expect(session.revokedEvent('reuse_detected', now).type).toBe('SessionRevoked');
  });
});
