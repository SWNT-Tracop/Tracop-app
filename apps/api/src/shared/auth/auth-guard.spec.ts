import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { AuthGuard, ownsResource } from './auth-guard.js';
import type { AuthPrincipal, AccessTokenVerifierPort } from './access-token-verifier.js';
import { PUBLIC_ROUTE, REQUIRED_ROLES } from './auth-metadata.js';

const principal: AuthPrincipal = {
  sub: 'user-1',
  role: 'producer',
  sid: 'session-1',
  did: 'device-1',
  jti: 'token-1',
  exp: 1_800_000_000,
};
const contextFor = (headers: Record<string, string> = {}): ExecutionContext => {
  const handler = () => undefined;
  const controller = class {};
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
};

describe('AuthGuard', () => {
  const getMetadata = jest.fn();
  const reflector = { getAllAndOverride: getMetadata };
  const verify = jest.fn();
  let guard: AuthGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new AuthGuard(reflector as never, { verify } as unknown as AccessTokenVerifierPort);
    getMetadata.mockImplementation((key: string) => (key === PUBLIC_ROUTE ? false : undefined));
  });

  it('allows public routes without reading authorization or verifying a token', async () => {
    getMetadata.mockReturnValueOnce(true);
    expect(await guard.canActivate(contextFor())).toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Basic token', 'Bearer'])(
    'rejects missing or malformed bearer header %s',
    async (header) => {
      await expect(
        guard.canActivate(contextFor(header ? { authorization: header } : {})),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    },
  );

  it('maps invalid credentials and invalid sessions to unauthorized errors', async () => {
    verify.mockResolvedValueOnce({ reason: 'invalid_token' });
    await expect(guard.canActivate(contextFor({ authorization: 'Bearer bad' }))).rejects.toThrow(
      'Credenciales inválidas.',
    );
    verify.mockResolvedValueOnce({ reason: 'invalid_session' });
    await expect(guard.canActivate(contextFor({ authorization: 'Bearer stale' }))).rejects.toThrow(
      'Sesión inválida.',
    );
  });

  it('enforces role metadata and attaches the verified principal', async () => {
    verify.mockResolvedValue({ principal });
    getMetadata.mockImplementation((key: string) =>
      key === REQUIRED_ROLES ? ['operator'] : false,
    );
    await expect(
      guard.canActivate(contextFor({ authorization: 'Bearer token' })),
    ).rejects.toBeInstanceOf(ForbiddenException);

    getMetadata.mockImplementation((key: string) =>
      key === REQUIRED_ROLES ? ['producer'] : false,
    );
    const request = { headers: { authorization: 'Bearer token' } };
    await expect(
      guard.canActivate({
        ...contextFor(),
        switchToHttp: () => ({ getRequest: () => request }),
      } as ExecutionContext),
    ).resolves.toBe(true);
    expect(request).toHaveProperty('identity', principal);
    expect(verify).toHaveBeenCalledWith('token');
  });

  it('checks resource ownership by principal id', () => {
    expect(ownsResource(principal, 'user-1')).toBe(true);
    expect(ownsResource(principal, 'user-2')).toBe(false);
  });
});
