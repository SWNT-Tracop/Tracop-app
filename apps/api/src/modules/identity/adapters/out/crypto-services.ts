import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import type { AppEnvironment } from '../../../../shared/infra/env.js';
import { APP_ENVIRONMENT } from '../../../../shared/infra/tokens.js';
import type { OtpPurpose } from '../../domain/otp.js';
import type { PhoneNumber } from '../../domain/phone-number.js';
import type { PasswordlessHasherPort, TokenServicePort } from '../../ports/identity-ports.js';
import { USER_ROLES, type UserProps } from '../../domain/user.js';
import type { AccessTokenClaims } from '../../ports/identity-ports.js';

const ACCESS_TOKEN_ALGORITHM = 'HS256';
const ALLOWED_ACCESS_TOKEN_ALGORITHMS = [ACCESS_TOKEN_ALGORITHM];

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
  private readonly secret: Uint8Array;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly clockToleranceSeconds: number;
  private readonly accessTokenTtlSeconds: number;

  constructor(@Inject(APP_ENVIRONMENT) private readonly environment: AppEnvironment) {
    this.secret = new TextEncoder().encode(environment.JWT_SECRET);
    this.issuer = environment.JWT_ISSUER;
    this.audience = environment.JWT_AUDIENCE;
    this.clockToleranceSeconds = environment.JWT_CLOCK_TOLERANCE_SECONDS;
    this.accessTokenTtlSeconds = environment.ACCESS_TOKEN_TTL_SECONDS;
  }

  async issueAccessToken(
    user: UserProps,
    sessionId: string,
    deviceId: string,
    now: Date,
  ): Promise<string> {
    const issuedAt = Math.floor(now.getTime() / 1000);
    return new SignJWT({ role: user.role, sid: sessionId, did: deviceId })
      .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, typ: 'JWT' })
      .setSubject(user.id)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setJti(randomBytes(16).toString('hex'))
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + this.accessTokenTtlSeconds)
      .sign(this.secret);
  }

  async verifyAccessToken(token: string, now: Date): Promise<AccessTokenClaims | null> {
    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.secret, {
        algorithms: ALLOWED_ACCESS_TOKEN_ALGORITHMS,
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: this.clockToleranceSeconds,
        currentDate: now,
        requiredClaims: ['sub', 'iat', 'exp', 'iss', 'aud', 'jti'],
      });
      if (protectedHeader.alg !== ACCESS_TOKEN_ALGORITHM) return null;
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.sid !== 'string' ||
        typeof payload.did !== 'string' ||
        typeof payload.jti !== 'string' ||
        typeof payload.exp !== 'number' ||
        typeof payload.role !== 'string' ||
        !USER_ROLES.includes(payload.role as UserProps['role'])
      )
        return null;
      return {
        sub: payload.sub,
        role: payload.role as UserProps['role'],
        sid: payload.sid,
        did: payload.did,
        jti: payload.jti,
        exp: payload.exp,
      };
    } catch {
      return null;
    }
  }

  createRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }
}
