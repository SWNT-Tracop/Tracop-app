import { randomInt } from 'node:crypto';
import { failure, success, type Result } from '../../../shared/kernel/result.js';
import { DomainError, RateLimitExceeded } from '../../../shared/kernel/domain-error.js';
import type { Clock } from '../../../shared/kernel/clock.js';
import { createId } from '../../../shared/kernel/ids.js';
import { Otp, type OtpProps } from '../domain/otp.js';
import { PhoneNumber } from '../domain/phone-number.js';
import { Session, type SessionProps } from '../domain/session.js';
import { SELF_REGISTERABLE_ROLES, User, type UserProps, type UserRole } from '../domain/user.js';
import type {
  AccessTokenClaims,
  ConsentRepository,
  DeviceRepository,
  IdentityUnitOfWork,
  OtpRepository,
  OtpSenderPort,
  PasswordlessHasherPort,
  RateLimiterPort,
  SessionRepository,
  TokenServicePort,
  UserRepository,
} from '../ports/identity-ports.js';
import type { OutboxWriter } from '../../../shared/ports/outbox-writer.js';
import type { IdentitySettings } from '../ports/identity-ports.js';

export const GENERIC_OTP_RESPONSE = 'Si el número puede autenticarse, recibirás un código.';
export const GENERIC_REGISTER_RESPONSE = 'Si el registro puede continuar, recibirás un código.';

export interface RegisterUserCommand {
  phone: string;
  role: UserRole;
  fullName: string;
  locale?: string;
  deviceId: string;
  platform: 'ios' | 'android' | 'web' | 'other';
  consent: { accepted: boolean; version: string };
  ip: string;
}

export interface VerifyOtpCommand {
  phone: string;
  code: string;
  deviceId: string;
  platform: 'ios' | 'android' | 'web' | 'other';
  ip: string;
}

export interface AuthSessionResult {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresAt: string;
  user: PublicUser;
}

export interface PublicUser {
  id: string;
  role: UserRole;
  fullName: string;
  phone: string;
  status: UserProps['status'];
  locale: string;
}

export class IdentityApplicationService {
  constructor(
    private readonly environment: IdentitySettings,
    private readonly users: UserRepository,
    private readonly otps: OtpRepository,
    private readonly sessions: SessionRepository,
    private readonly devices: DeviceRepository,
    private readonly consents: ConsentRepository,
    private readonly rateLimiter: RateLimiterPort,
    private readonly sender: OtpSenderPort,
    private readonly tokens: TokenServicePort,
    private readonly hasher: PasswordlessHasherPort,
    private readonly clock: Clock,
    private readonly unitOfWork: IdentityUnitOfWork,
    private readonly outbox: OutboxWriter,
  ) {}

  async registerUser(
    command: RegisterUserCommand,
  ): Promise<Result<{ message: string }, DomainError>> {
    const phoneResult = PhoneNumber.parse(command.phone, this.environment.allowedCountryCodes);
    if (!phoneResult.ok) return phoneResult;
    if (!SELF_REGISTERABLE_ROLES.includes(command.role)) {
      return failure(
        new DomainError('Este rol debe ser creado por el equipo autorizado.', 'invalid_role'),
      );
    }
    if (!command.consent.accepted)
      return failure(new DomainError('Debes aceptar el aviso vigente.', 'consent_required'));
    if (command.consent.version !== this.environment.PRIVACY_POLICY_VERSION) {
      return failure(
        new DomainError(
          'La versión del aviso de privacidad ya no está vigente.',
          'consent_version_mismatch',
        ),
      );
    }
    const phone = phoneResult.value;
    const limitError = await this.consumeOtpRequestLimits(phone, command.ip);
    if (limitError) return success({ message: GENERIC_REGISTER_RESPONSE });

    const now = this.clock.now();
    const creation = await this.unitOfWork.run(async () => {
      const existing = await this.users.findByPhone(phone);
      if (existing) {
        await this.consents.create({
          id: createId(),
          userId: existing.id,
          policyType: 'privacy',
          version: command.consent.version,
          acceptedAt: now,
          channel: 'app',
        });
        return { user: existing, created: false };
      }
      const user = User.register(
        {
          id: createId(),
          phone,
          role: command.role,
          fullName: command.fullName,
          locale: command.locale ?? 'es-CO',
          createdAt: now,
        },
        now,
      );
      await this.users.create(user.props);
      await this.devices.upsert({
        id: command.deviceId,
        userId: user.props.id,
        platform: command.platform,
        lastSeenAt: now,
      });
      await this.consents.create({
        id: createId(),
        userId: user.props.id,
        policyType: 'privacy',
        version: command.consent.version,
        acceptedAt: now,
        channel: 'app',
      });
      const registered = user.registeredEvent();
      await this.outbox.append([
        { aggregate: user.props.id, type: registered.type, payload: { ...registered } },
      ]);
      return { user: user.props, created: true };
    });

    const purpose = creation.user.status === 'active' ? 'login' : 'registration';
    const otpResult = await this.requestOtpInternal(phone, purpose);
    if (!otpResult.ok && otpResult.error.code !== 'rate_limited') return otpResult;
    return success({ message: GENERIC_REGISTER_RESPONSE });
  }

  async requestOtp(
    phoneInput: string,
    ip: string,
  ): Promise<Result<{ message: string }, DomainError>> {
    const phone = PhoneNumber.parse(phoneInput, this.environment.allowedCountryCodes);
    if (!phone.ok) return phone;
    const limitError = await this.consumeOtpRequestLimits(phone.value, ip);
    if (limitError) return failure(limitError);
    return this.requestOtpInternal(phone.value, undefined);
  }

  private async consumeOtpRequestLimits(
    phone: PhoneNumber,
    ip: string,
  ): Promise<RateLimitExceeded | null> {
    const phoneWindow = await this.rateLimiter.consume(
      `otp:phone:window:${phone.value}`,
      this.environment.OTP_PHONE_LIMIT,
      this.environment.OTP_PHONE_WINDOW_SECONDS,
    );
    const phoneCooldown = await this.rateLimiter.consume(
      `otp:phone:cooldown:${phone.value}`,
      this.environment.OTP_PHONE_COOLDOWN_LIMIT,
      this.environment.OTP_PHONE_COOLDOWN_SECONDS,
    );
    const ipLimit = await this.rateLimiter.consume(
      `otp:request:ip:${ip}`,
      this.environment.OTP_IP_REQUEST_LIMIT,
      this.environment.OTP_IP_WINDOW_SECONDS,
    );
    const denied = [phoneWindow, phoneCooldown, ipLimit].filter((result) => !result.allowed);
    return denied.length
      ? new RateLimitExceeded(Math.max(...denied.map((item) => item.retryAfter)))
      : null;
  }

  private async requestOtpInternal(
    phone: PhoneNumber,
    forcedPurpose: 'registration' | 'login' | undefined,
  ): Promise<Result<{ message: string }, DomainError>> {
    const user = await this.users.findByPhone(phone);
    if (!user || user.status === 'suspended') return success({ message: GENERIC_OTP_RESPONSE });
    const purpose = forcedPurpose ?? (user.status === 'active' ? 'login' : 'registration');
    const now = this.clock.now();
    const code = String(randomInt(0, 10 ** this.environment.OTP_LENGTH)).padStart(
      this.environment.OTP_LENGTH,
      '0',
    );
    const otp: OtpProps = {
      id: createId(),
      userId: user.id,
      purpose,
      codeHash: this.hasher.hashOtp(phone, purpose, code),
      expiresAt: new Date(now.getTime() + this.environment.OTP_TTL_SECONDS * 1000),
      attempts: 0,
      maxAttempts: this.environment.OTP_MAX_ATTEMPTS,
      consumedAt: null,
      createdAt: now,
    };
    await this.unitOfWork.run(() => this.otps.create(otp));
    await this.sender.send(phone, code);
    return success({ message: GENERIC_OTP_RESPONSE });
  }

  async verifyOtp(command: VerifyOtpCommand): Promise<Result<AuthSessionResult, DomainError>> {
    const phoneResult = PhoneNumber.parse(command.phone, this.environment.allowedCountryCodes);
    if (!phoneResult.ok) return phoneResult;
    const phone = phoneResult.value;
    const ipLimit = await this.rateLimiter.consume(
      `otp:verify:ip:${command.ip ?? ''}`,
      this.environment.OTP_IP_VERIFY_LIMIT,
      this.environment.OTP_IP_WINDOW_SECONDS,
    );
    if (!ipLimit.allowed) return failure(new RateLimitExceeded(ipLimit.retryAfter));

    const now = this.clock.now();
    const refreshToken = this.tokens.createRefreshToken();
    const result = await this.unitOfWork.run(
      async (): Promise<Result<AuthSessionResult, DomainError>> => {
        const user = await this.users.findByPhone(phone);
        if (!user || user.status === 'suspended')
          return failure(new DomainError('El código no es válido.', 'invalid_otp'));
        const purpose = user.status === 'active' ? 'login' : 'registration';
        const props = await this.otps.findLatestForUpdate(user.id, purpose);
        if (!props) return failure(new DomainError('El código no es válido.', 'invalid_otp'));
        const otp = new Otp(props);
        try {
          otp.assertUsable(now);
        } catch (error) {
          if (error instanceof DomainError) return failure(error);
          throw error;
        }
        if (!this.hasher.verifyOtp(phone, purpose, command.code, otp.props.codeHash)) {
          let attemptLimitReached = false;
          try {
            otp.recordFailedAttempt();
          } catch (error) {
            if (error instanceof DomainError && error.code === 'otp_attempts_exceeded')
              attemptLimitReached = true;
            else throw error;
          }
          await this.otps.update(otp.props);
          if (attemptLimitReached) {
            return failure(
              new DomainError('Se agotaron los intentos permitidos.', 'otp_attempts_exceeded'),
            );
          }
          return failure(new DomainError('El código no es válido.', 'invalid_otp'));
        }
        otp.consume(now);
        await this.otps.update(otp.props);

        const domainUser = User.rehydrate(user);
        if (user.status === 'pending_verification') {
          const verified = domainUser.verifyPhone(now);
          await this.users.update(domainUser.props);
          await this.outbox.append([
            { aggregate: user.id, type: verified.type, payload: { ...verified } },
          ]);
        }
        await this.devices.upsert({
          id: command.deviceId,
          userId: user.id,
          platform: command.platform,
          lastSeenAt: now,
        });
        if (!(await this.devices.belongsToUser(command.deviceId, user.id))) {
          return failure(
            new DomainError('El dispositivo no pertenece al usuario.', 'access_denied'),
          );
        }
        const previousFamily = await this.sessions.findFamilyForDevice(user.id, command.deviceId);
        if (previousFamily) {
          const affected = await this.sessions.revokeFamily(previousFamily, now, 'new_login');
          for (const revoked of affected) {
            const event = new Session(revoked).revokedEvent('new_login', now);
            await this.outbox.append([
              { aggregate: revoked.userId, type: event.type, payload: { ...event } },
            ]);
          }
        }
        const familyId = createId();
        const session = this.newSession(user.id, command.deviceId, familyId, refreshToken, now);
        await this.sessions.create(session);
        return success(await this.authResult(domainUser.props, session, refreshToken, now));
      },
    );
    return result;
  }

  async refreshSession(
    refreshToken: string,
    deviceId: string,
  ): Promise<Result<AuthSessionResult, DomainError>> {
    const now = this.clock.now();
    const oldHash = this.hasher.hashRefreshToken(refreshToken);
    const newRefreshToken = this.tokens.createRefreshToken();
    return this.unitOfWork.run(async () => {
      const oldProps = await this.sessions.findByRefreshHashForUpdate(oldHash);
      if (!oldProps || oldProps.deviceId !== deviceId) {
        return failure(new DomainError('La sesión no es válida.', 'session_invalid'));
      }
      if (oldProps.rotatedAt) {
        const affected = await this.sessions.revokeFamily(oldProps.familyId, now, 'reuse_detected');
        for (const revoked of affected) {
          const event = new Session(revoked).revokedEvent('reuse_detected', now);
          await this.outbox.append([
            { aggregate: revoked.userId, type: event.type, payload: { ...event } },
          ]);
        }
        return failure(
          new DomainError('Se detectó reutilización de una sesión.', 'session_invalid'),
        );
      }
      const previous = new Session(oldProps);
      try {
        previous.assertActive(now);
      } catch (error) {
        if (error instanceof DomainError) return failure(error);
        throw error;
      }
      const user = await this.users.findById(oldProps.userId);
      if (!user || user.status !== 'active')
        return failure(new DomainError('La sesión no es válida.', 'session_invalid'));
      previous.rotate(now);
      await this.sessions.update(previous.props);
      const next = this.newSession(
        user.id,
        oldProps.deviceId,
        oldProps.familyId,
        newRefreshToken,
        now,
      );
      await this.sessions.create(next);
      return success(await this.authResult(user, next, newRefreshToken, now));
    });
  }

  async logout(claims: AccessTokenClaims): Promise<Result<{ message: string }, DomainError>> {
    const now = this.clock.now();
    return this.unitOfWork.run(async () => {
      const session = await this.sessions.revokeSession(claims.sid, now, 'logout');
      if (session) {
        const event = new Session(session).revokedEvent('logout', now);
        await this.outbox.append([
          { aggregate: session.userId, type: event.type, payload: { ...event } },
        ]);
      }
      return success({ message: 'Sesión cerrada.' });
    });
  }

  async getMe(claims: AccessTokenClaims): Promise<Result<PublicUser, DomainError>> {
    const user = await this.users.findById(claims.sub);
    return user
      ? success(this.publicUser(user))
      : failure(new DomainError('Usuario no encontrado.', 'user_not_found'));
  }

  async updateMe(
    claims: AccessTokenClaims,
    update: { fullName?: string; locale?: string },
  ): Promise<Result<PublicUser, DomainError>> {
    const now = this.clock.now();
    return this.unitOfWork.run(async () => {
      const props = await this.users.findById(claims.sub);
      if (!props) return failure(new DomainError('Usuario no encontrado.', 'user_not_found'));
      const user = User.rehydrate(props);
      user.updateProfile(
        {
          ...(update.fullName !== undefined ? { fullName: update.fullName } : {}),
          ...(update.locale !== undefined ? { locale: update.locale } : {}),
        },
        now,
      );
      await this.users.update(user.props);
      return success(this.publicUser(user.props));
    });
  }

  private newSession(
    userId: string,
    deviceId: string,
    familyId: string,
    refreshToken: string,
    now: Date,
  ): SessionProps {
    return {
      id: createId(),
      userId,
      deviceId,
      familyId,
      refreshHash: this.hasher.hashRefreshToken(refreshToken),
      expiresAt: new Date(now.getTime() + this.environment.REFRESH_TOKEN_TTL_SECONDS * 1000),
      createdAt: now,
      rotatedAt: null,
      revokedAt: null,
      revokedReason: null,
      lastUsedAt: null,
    };
  }

  private async authResult(
    user: UserProps,
    session: SessionProps,
    refreshToken: string,
    now: Date,
  ): Promise<AuthSessionResult> {
    return {
      accessToken: await this.tokens.issueAccessToken(user, session.id, session.deviceId, now),
      refreshToken,
      accessTokenExpiresIn: this.environment.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenExpiresAt: session.expiresAt.toISOString(),
      user: this.publicUser(user),
    };
  }

  private publicUser(user: UserProps): PublicUser {
    return {
      id: user.id,
      role: user.role,
      fullName: user.fullName,
      phone: user.phone.value,
      status: user.status,
      locale: user.locale,
    };
  }
}
