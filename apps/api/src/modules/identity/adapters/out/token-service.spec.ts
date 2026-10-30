import { SignJWT } from 'jose';
import type { AppEnvironment } from '../../../../shared/infra/env.js';
import type { UserProps } from '../../domain/user.js';
import { HmacTokenService } from './crypto-services.js';

const baseEnvironment = {
  JWT_SECRET: 'unit-test-jwt-secret-with-at-least-32-bytes',
  JWT_ISSUER: 'tracop',
  JWT_AUDIENCE: 'tracop-api',
  JWT_CLOCK_TOLERANCE_SECONDS: 5,
  ACCESS_TOKEN_TTL_SECONDS: 900,
} as unknown as AppEnvironment;

const user: UserProps = {
  id: 'user-1',
  role: 'buyer',
  fullName: 'Test User',
  locale: 'es-CO',
  status: 'active',
  phone: { value: '+573001234567' } as UserProps['phone'],
  phoneVerifiedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const now = new Date('2026-01-01T00:00:00.000Z');
const later = (seconds: number): Date => new Date(now.getTime() + seconds * 1000);

const makeService = (overrides: Partial<AppEnvironment> = {}): HmacTokenService =>
  new HmacTokenService({ ...baseEnvironment, ...overrides } as AppEnvironment);

const decodeSegment = (segment: string): unknown =>
  JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));

describe('HmacTokenService (jose, HS256 only)', () => {
  it('issues a token with exp, iat, iss, aud and jti that verifies successfully', async () => {
    const service = makeService();
    const token = await service.issueAccessToken(user, 'session-1', 'device-1', now);
    const [header, payload] = token.split('.');
    const decodedHeader = decodeSegment(header!) as { alg: string };
    const decodedPayload = decodeSegment(payload!) as Record<string, unknown>;
    expect(decodedHeader.alg).toBe('HS256');
    expect(decodedPayload).toMatchObject({
      sub: user.id,
      sid: 'session-1',
      did: 'device-1',
      role: 'buyer',
      iss: 'tracop',
      aud: 'tracop-api',
    });
    expect(typeof decodedPayload.jti).toBe('string');
    expect(typeof decodedPayload.iat).toBe('number');
    expect(typeof decodedPayload.exp).toBe('number');

    const claims = await service.verifyAccessToken(token, later(60));
    expect(claims).toEqual({
      sub: user.id,
      role: 'buyer',
      sid: 'session-1',
      did: 'device-1',
      jti: decodedPayload.jti,
      exp: decodedPayload.exp,
    });
  });

  it('rejects a token whose signature was manipulated', async () => {
    const service = makeService();
    const token = await service.issueAccessToken(user, 'session-1', 'device-1', now);
    const [header, payload, signature] = token.split('.');
    const tampered = `${header}.${payload}.${signature!.slice(0, -2)}AA`;
    await expect(service.verifyAccessToken(tampered, now)).resolves.toBeNull();
  });

  it('rejects an unsigned token with alg=none', async () => {
    const service = makeService();
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: user.id,
        role: 'buyer',
        sid: 'session-1',
        did: 'device-1',
        jti: 'jti-1',
        iat: Math.floor(now.getTime() / 1000),
        exp: Math.floor(later(900).getTime() / 1000),
        iss: 'tracop',
        aud: 'tracop-api',
      }),
    ).toString('base64url');
    await expect(service.verifyAccessToken(`${header}.${payload}.`, now)).resolves.toBeNull();
  });

  it('rejects a token signed with a different algorithm', async () => {
    const service = makeService();
    const secret = new TextEncoder().encode(baseEnvironment.JWT_SECRET);
    const token = await new SignJWT({ role: 'buyer', sid: 'session-1', did: 'device-1' })
      .setProtectedHeader({ alg: 'HS512', typ: 'JWT' })
      .setSubject(user.id)
      .setIssuer('tracop')
      .setAudience('tracop-api')
      .setJti('jti-1')
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(later(900).getTime() / 1000))
      .sign(secret);
    await expect(service.verifyAccessToken(token, now)).resolves.toBeNull();
  });

  it('rejects an expired token once the clock tolerance is exceeded', async () => {
    const service = makeService();
    const token = await service.issueAccessToken(user, 'session-1', 'device-1', now);
    await expect(service.verifyAccessToken(token, later(900 + 6))).resolves.toBeNull();
    await expect(service.verifyAccessToken(token, later(60))).resolves.not.toBeNull();
  });

  it('rejects a token issued for a different issuer', async () => {
    const foreign = makeService({ JWT_ISSUER: 'another-issuer' });
    const token = await foreign.issueAccessToken(user, 'session-1', 'device-1', now);
    await expect(makeService().verifyAccessToken(token, now)).resolves.toBeNull();
  });

  it('rejects a token issued for a different audience', async () => {
    const foreign = makeService({ JWT_AUDIENCE: 'another-audience' });
    const token = await foreign.issueAccessToken(user, 'session-1', 'device-1', now);
    await expect(makeService().verifyAccessToken(token, now)).resolves.toBeNull();
  });

  it('rejects a token that is missing required claims', async () => {
    const service = makeService();
    const secret = new TextEncoder().encode(baseEnvironment.JWT_SECRET);
    const token = await new SignJWT({ role: 'buyer', sid: 'session-1', did: 'device-1' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(user.id)
      .setIssuer('tracop')
      .setAudience('tracop-api')
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(later(900).getTime() / 1000))
      .sign(secret);
    await expect(service.verifyAccessToken(token, now)).resolves.toBeNull();
  });
});
