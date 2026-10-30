import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IdentityAuthGuard,
  ownsResource,
  type AuthenticatedRequest,
} from '../src/modules/identity/adapters/in/identity-auth.guard.js';
import { REQUIRED_ROLES, PUBLIC_ROUTE } from '../src/modules/identity/adapters/in/auth-metadata.js';
import { PhoneNumber } from '../src/modules/identity/domain/phone-number.js';
import { MemoryTokens, FixedClock } from './support/in-memory-identity.js';
import type { SessionProps } from '../src/modules/identity/domain/session.js';
import type { UserProps } from '../src/modules/identity/domain/user.js';

describe('identity role guard and ownership helper', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const parsedPhone = PhoneNumber.parse('+573001234567');
  if (!parsedPhone.ok) throw parsedPhone.error;
  const user: UserProps = {
    id: 'user-id',
    phone: parsedPhone.value,
    role: 'buyer',
    fullName: 'Test',
    locale: 'es-CO',
    status: 'active',
    phoneVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const session: SessionProps = {
    id: 'session-id',
    userId: user.id,
    deviceId: 'device-id',
    familyId: 'family-id',
    refreshHash: 'hash',
    expiresAt: new Date(now.getTime() + 60_000),
    createdAt: now,
    rotatedAt: null,
    revokedAt: null,
    revokedReason: null,
    lastUsedAt: null,
  };

  const makeContext = (request: AuthenticatedRequest): ExecutionContext =>
    ({
      getHandler: () => () => undefined,
      getClass: () => class TestController {},
      switchToHttp: () => ({ getRequest: () => request }) as never,
    }) as unknown as ExecutionContext;

  it('rejects an authenticated user whose role is not allowed by @Roles', async () => {
    const tokens = new MemoryTokens();
    const accessToken = tokens.issueAccessToken(user, session.id, session.deviceId, now);
    const reflector = {
      getAllAndOverride: (key: string) =>
        key === PUBLIC_ROUTE ? false : key === REQUIRED_ROLES ? ['admin'] : undefined,
    } as unknown as Reflector;
    const guard = new IdentityAuthGuard(
      reflector,
      tokens,
      { findById: async () => session } as never,
      { findById: async () => user } as never,
      new FixedClock(now),
    );
    const context = makeContext({
      headers: { authorization: `Bearer ${accessToken}` },
    } as AuthenticatedRequest);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows an authenticated user with a matching role and checks resource ownership', async () => {
    const tokens = new MemoryTokens();
    const accessToken = tokens.issueAccessToken(user, session.id, session.deviceId, now);
    const reflector = {
      getAllAndOverride: (key: string) => (key === REQUIRED_ROLES ? ['buyer'] : false),
    } as unknown as Reflector;
    const request = { headers: { authorization: `Bearer ${accessToken}` } } as AuthenticatedRequest;
    const guard = new IdentityAuthGuard(
      reflector,
      tokens,
      { findById: async () => session } as never,
      { findById: async () => user } as never,
      new FixedClock(now),
    );
    expect(await guard.canActivate(makeContext(request))).toBe(true);
    expect(request.identity?.sub).toBe(user.id);
    expect(ownsResource(request.identity!, user.id)).toBe(true);
    expect(ownsResource(request.identity!, 'another-user')).toBe(false);
  });
});
