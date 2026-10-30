import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AppEnvironment } from '../../../../shared/infra/env.js';
import { APP_ENVIRONMENT } from '../../../../shared/infra/tokens.js';
import type { OtpPurpose } from '../../domain/otp.js';
import type { PhoneNumber } from '../../domain/phone-number.js';
import type { PasswordlessHasherPort, TokenServicePort } from '../../ports/identity-ports.js';
import { USER_ROLES, type UserProps } from '../../domain/user.js';
import type { AccessTokenClaims } from '../../ports/identity-ports.js';

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

@Injectable()
export class HmacPasswordlessHasher implements PasswordlessHasherPort {
  constructor(@Inject(APP_ENVIRONMENT) private readonly environment: AppEnvironment) {}

  hashOtp(phone: PhoneNumber, purpose: OtpPurpose, code: string): string {
    return createHmac('sha256', this.environment.OTP_HMAC_SECRET)
      .update(`${phone.value}\0${purpose}\0${code}`)
      .digest('hex');
  }

  verifyOtp(phone: PhoneNumber, purpose: OtpPurpose, code: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.hashOtp(phone, purpose, code), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  hashRateLimitKey(key: string): string {
    return createHmac('sha256', this.environment.RATE_LIMIT_HMAC_SECRET).update(key).digest('hex');
  }
}

@Injectable()
export class HmacTokenService implements TokenServicePort {
  constructor(@Inject(APP_ENVIRONMENT) private readonly environment: AppEnvironment) {}

  issueAccessToken(user: UserProps, sessionId: string, deviceId: string, now: Date): string {
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const payload = encode({
      sub: user.id,
      role: user.role,
      sid: sessionId,
      did: deviceId,
      jti: randomBytes(16).toString('hex'),
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(now.getTime() / 1000) + this.environment.ACCESS_TOKEN_TTL_SECONDS,
    });
    const unsigned = `${header}.${payload}`;
    const signature = createHmac('sha256', this.environment.JWT_SECRET)
      .update(unsigned)
      .digest('base64url');
    return `${unsigned}.${signature}`;
  }

  verifyAccessToken(token: string, now: Date): AccessTokenClaims | null {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every(Boolean)) return null;
    const header = parts[0]!;
    const payload = parts[1]!;
    const signature = parts[2]!;
    const expected = createHmac('sha256', this.environment.JWT_SECRET)
      .update(`${header}.${payload}`)
      .digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, 'base64url');
    } catch {
      return null;
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
      const parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as {
        alg?: string;
      };
      const claims = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as AccessTokenClaims;
      if (
        parsedHeader.alg !== 'HS256' ||
        typeof claims.sub !== 'string' ||
        typeof claims.sid !== 'string' ||
        typeof claims.did !== 'string' ||
        typeof claims.jti !== 'string' ||
        !USER_ROLES.includes(claims.role) ||
        typeof claims.exp !== 'number' ||
        claims.exp <= Math.floor(now.getTime() / 1000)
      )
        return null;
      return claims;
    } catch {
      return null;
    }
  }

  createRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }
}
