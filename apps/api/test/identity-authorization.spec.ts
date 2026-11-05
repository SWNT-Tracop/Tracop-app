import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AuthGuard,
  ownsResource,
  type AuthenticatedRequest,
  type AuthPrincipal,
  type AccessTokenVerifierPort,
  REQUIRED_ROLES,
  PUBLIC_ROUTE,
} from '../src/shared/auth/index.js';

describe('identity role guard and ownership helper', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const principal: AuthPrincipal = {
    sub: 'user-id',
    role: 'buyer',
    sid: 'session-id',
    did: 'device-id',
    jti: 'token-id',
    exp: Math.floor(now.getTime() / 1000) + 60,
  };

  const verifier: AccessTokenVerifierPort = {
    verify: async (token) =>
      token === 'valid' ? { principal } : { principal: null, reason: 'invalid_token' },
  };

  const makeContext = (request: AuthenticatedRequest): ExecutionContext =>
    ({
      getHandler: () => () => undefined,
      getClass: () => class TestController {},
      switchToHttp: () => ({ getRequest: () => request }) as never,
    }) as unknown as ExecutionContext;

  it('rejects an authenticated user whose role is not allowed by @Roles', async () => {
    const reflector = {
      getAllAndOverride: (key: string) =>
        key === PUBLIC_ROUTE ? false : key === REQUIRED_ROLES ? ['admin'] : undefined,
    } as unknown as Reflector;
    const guard = new AuthGuard(reflector, verifier);
    const context = makeContext({
      headers: { authorization: 'Bearer valid' },
    } as AuthenticatedRequest);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows an authenticated user with a matching role and checks resource ownership', async () => {
    const reflector = {
      getAllAndOverride: (key: string) => (key === REQUIRED_ROLES ? ['buyer'] : false),
    } as unknown as Reflector;
    const request = { headers: { authorization: 'Bearer valid' } } as AuthenticatedRequest;
    const guard = new AuthGuard(reflector, verifier);
    expect(await guard.canActivate(makeContext(request))).toBe(true);
    expect(request.identity?.sub).toBe(principal.sub);
    expect(ownsResource(request.identity!, principal.sub)).toBe(true);
    expect(ownsResource(request.identity!, 'another-user')).toBe(false);
  });
});
