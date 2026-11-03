import { IdentityApplicationService } from '../src/modules/identity/application/identity-application-service.js';
import type { UserRole } from '../src/modules/identity/domain/user.js';
import { PhoneNumber } from '../src/modules/identity/domain/phone-number.js';
import { DomainError } from '../src/shared/kernel/domain-error.js';
import { Result } from '../src/shared/kernel/result.js';
import {
  FixedClock,
  InMemoryOtpSender,
  MemoryBackgroundDispatcher,
  MemoryConsentRepository,
  MemoryDeviceRepository,
  MemoryHasher,
  MemoryOutboxWriter,
  MemoryOtpRepository,
  MemoryRateLimiter,
  MemorySessionRepository,
  MemoryState,
  MemoryTokens,
  MemoryUnitOfWork,
  MemoryUserRepository,
  memorySettings,
  unwrap,
} from './support/in-memory-identity.js';

const createHarness = (overrides: Partial<typeof memorySettings> = {}) => {
  const clock = new FixedClock();
  const state = new MemoryState();
  const sender = new InMemoryOtpSender();
  const users = new MemoryUserRepository(state);
  const sessions = new MemorySessionRepository(state);
  const hasher = new MemoryHasher();
  const service = new IdentityApplicationService(
    { ...memorySettings, ...overrides },
    users,
    new MemoryOtpRepository(state),
    sessions,
    new MemoryDeviceRepository(state),
    new MemoryConsentRepository(state),
    new MemoryRateLimiter(state, clock),
    sender,
    new MemoryTokens(),
    hasher,
    clock,
    new MemoryUnitOfWork(),
    new MemoryOutboxWriter(state),
    new MemoryBackgroundDispatcher(),
  );
  const registration = (phoneValue: string, options: Record<string, unknown> = {}) =>
    service.registerUser({
      phone: phoneValue,
      role: 'buyer',
      fullName: 'Comprador de prueba',
      deviceId: '10000000-0000-7000-8000-000000000001',
      platform: 'web',
      consent: { accepted: true, version: 'v0-draft' },
      ip: '127.0.0.1',
      ...options,
    } as Parameters<typeof service.registerUser>[0]);
  const verify = (
    phoneValue: string,
    code: string,
    deviceId = '10000000-0000-7000-8000-000000000001',
    ip = '127.0.0.1',
  ) => service.verifyOtp({ phone: phoneValue, code, deviceId, platform: 'web', ip });
  return { service, state, sender, clock, users, sessions, registration, verify };
};

describe('identity application use cases with in-memory ports', () => {
  it('registers, requests OTP, verifies the user, creates a device session, and supports GetMe/UpdateMe', async () => {
    const harness = createHarness();
    const phoneValue = '3001234567';
    expect(unwrap(await harness.registration(phoneValue)).message).toContain('recibirás un código');
    const result = unwrap(await harness.verify(phoneValue, harness.sender.sent.at(-1)!.code));
    expect(result.user.status).toBe('active');
    expect(
      unwrap(
        await harness.service.getMe({
          sub: result.user.id,
          role: 'buyer',
          sid: 'unused',
          did: 'unused',
          jti: 'jti',
          exp: 9_999_999_999,
        }),
      ).phone,
    ).toBe('+573001234567');
    expect(
      unwrap(
        await harness.service.updateMe(
          {
            sub: result.user.id,
            role: 'buyer',
            sid: 'unused',
            did: 'unused',
            jti: 'jti',
            exp: 9_999_999_999,
          },
          { fullName: 'Nombre actualizado', locale: 'en' },
        ),
      ).fullName,
    ).toBe('Nombre actualizado');
    expect(harness.state.outbox.map((event) => event.type)).toEqual([
      'UserRegistered',
      'UserVerified',
    ]);
  });

  it('rejects invalid phone, privileged self-registration, and missing or outdated consent', async () => {
    const harness = createHarness();
    expect((await harness.registration('not-a-phone')).ok).toBe(false);
    expect((await harness.registration('3001234567', { role: 'admin' })).ok).toBe(false);
    const missingConsent = await harness.registration('3001234567', {
      consent: { accepted: false, version: 'v0-draft' },
    });
    expect(missingConsent.ok).toBe(false);
    if (!missingConsent.ok) expect(missingConsent.error.code).toBe('consent_required');
    expect(
      (await harness.registration('3001234567', { consent: { accepted: true, version: 'old' } }))
        .ok,
    ).toBe(false);
    expect(harness.state.users.size).toBe(0);
  });

  it('returns the same generic registration response for new and existing users', async () => {
    const harness = createHarness();
    const first = unwrap(await harness.registration('3001234567'));
    harness.clock.advance(61);
    const existing = unwrap(await harness.registration('3001234567'));
    const unknown = unwrap(await harness.registration('3001234568'));
    expect(first).toEqual(existing);
    expect(existing).toEqual(unknown);
  });

  it('does not reveal unknown or suspended users through OTP requests and returns rate limit errors consistently', async () => {
    const harness = createHarness();
    const unknown = unwrap(await harness.service.requestOtp('3009999999', '10.0.0.1'));
    expect(unknown.message).toBe('Si el número puede autenticarse, recibirás un código.');
    expect(unknown.botLink).toBe('https://t.me/tracop_test_bot?start=link');
    await harness.registration('3001234567');
    harness.clock.advance(61);
    expect(unwrap(await harness.service.requestOtp('3001234567', '10.0.0.2')).message).toBe(
      unknown.message,
    );
    expect((await harness.service.requestOtp('3001234567', '10.0.0.2')).ok).toBe(false);
    const user = [...harness.state.users.values()][0]!;
    user.status = 'suspended';
    harness.state.rateCounters.clear();
    harness.clock.advance(61);
    expect(unwrap(await harness.service.requestOtp('3001234567', '10.0.0.3')).message).toBe(
      unknown.message,
    );
  });

  it('rejects incorrect, expired, exhausted and unknown OTPs', async () => {
    const harness = createHarness();
    expect((await harness.verify('3009999999', '123456')).ok).toBe(false);
    await harness.registration('3001234567');
    const actualCode = harness.sender.sent.at(-1)!.code;
    expect(
      (await harness.verify('3001234567', actualCode === '000000' ? '111111' : '000000')).ok,
    ).toBe(false);
    const stored = [...harness.state.otps.values()][0]!;
    stored.expiresAt = new Date(harness.clock.now().getTime() - 1);
    expect((await harness.verify('3001234567', actualCode)).ok).toBe(false);
    stored.expiresAt = new Date(harness.clock.now().getTime() + 60_000);
    stored.attempts = stored.maxAttempts;
    expect((await harness.verify('3001234567', actualCode)).ok).toBe(false);
  });

  it('rotates refresh tokens and revokes the entire family when a rotated token is reused', async () => {
    const harness = createHarness();
    await harness.registration('3001234567');
    const auth = unwrap(await harness.verify('3001234567', harness.sender.sent.at(-1)!.code));
    const rotated = unwrap(
      await harness.service.refreshSession(
        auth.refreshToken,
        '10000000-0000-7000-8000-000000000001',
      ),
    );
    expect(rotated.refreshToken).not.toBe(auth.refreshToken);
    expect(
      (
        await harness.service.refreshSession(
          'not-a-valid-refresh-token',
          '10000000-0000-7000-8000-000000000001',
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await harness.service.refreshSession(
          auth.refreshToken,
          '10000000-0000-7000-8000-000000000001',
        )
      ).ok,
    ).toBe(false);
    expect(
      [...harness.state.sessions.values()].every(
        (session) => session.revokedReason === 'reuse_detected',
      ),
    ).toBe(true);
    expect(harness.state.outbox.at(-1)?.type).toBe('SessionRevoked');
  });

  it('supports login OTP for an active user, logout and profile not-found errors', async () => {
    const harness = createHarness();
    await harness.registration('3001234567');
    const initial = unwrap(await harness.verify('3001234567', harness.sender.sent.at(-1)!.code));
    harness.clock.advance(61);
    unwrap(await harness.service.requestOtp('3001234567', '10.0.0.1'));
    const loggedIn = unwrap(await harness.verify('3001234567', harness.sender.sent.at(-1)!.code));
    expect(loggedIn.user.status).toBe('active');
    const session = [...harness.state.sessions.values()].find(
      (item) => item.userId === initial.user.id,
    )!;
    unwrap(
      await harness.service.logout({
        sub: initial.user.id,
        role: 'buyer',
        sid: session.id,
        did: session.deviceId,
        jti: 'jti',
        exp: 9_999_999_999,
      }),
    );
    expect(
      (
        await harness.service.getMe({
          sub: 'missing',
          role: 'buyer',
          sid: 'x',
          did: 'x',
          jti: 'x',
          exp: 9_999_999_999,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await harness.service.updateMe(
          { sub: 'missing', role: 'buyer', sid: 'x', did: 'x', jti: 'x', exp: 9_999_999_999 },
          { locale: 'es-CO' },
        )
      ).ok,
    ).toBe(false);
  });

  it('rejects verification when the IP limit is exhausted', async () => {
    const harness = createHarness({ OTP_IP_VERIFY_LIMIT: 1 });
    await harness.registration('3001234567');
    const code = harness.sender.sent.at(-1)!.code;
    expect((await harness.verify('3001234567', code)).ok).toBe(true);
    harness.clock.advance(61);
    await harness.service.requestOtp('3001234567', '10.0.0.2');
    const nextCode = harness.sender.sent.at(-1)!.code;
    expect((await harness.verify('3001234567', nextCode)).ok).toBe(false);
  });

  it('enforces the per-phone rolling OTP window after the cooldown expires', async () => {
    const harness = createHarness();
    const phoneValue = '3004567890';
    expect(unwrap(await harness.service.requestOtp(phoneValue, '10.0.0.1')).message).toContain(
      'recibirás',
    );
    harness.clock.advance(61);
    expect((await harness.service.requestOtp(phoneValue, '10.0.0.1')).ok).toBe(true);
    harness.clock.advance(61);
    expect((await harness.service.requestOtp(phoneValue, '10.0.0.1')).ok).toBe(true);
    harness.clock.advance(61);
    expect((await harness.service.requestOtp(phoneValue, '10.0.0.1')).ok).toBe(false);
  });
});

describe('profile validation rules', () => {
  const makeActor = (role: UserRole = 'buyer') =>
    ({
      sub: 'user-1',
      role,
      sid: 'session-1',
      did: 'device-1',
      jti: 'jti-1',
      exp: 9_999_999_999,
    }) as AuthenticatedActor;

  const createService = (overrides: Partial<typeof memorySettings> = {}) => {
    const clock = new FixedClock();
    const state = new MemoryState();
    const sender = new InMemoryOtpSender();
    const users = new MemoryUserRepository(state);
    const hasher = new MemoryHasher();
    const service = new IdentityApplicationService(
      { ...memorySettings, ...overrides },
      users,
      new MemoryOtpRepository(state),
      new MemorySessionRepository(state),
      new MemoryDeviceRepository(state),
      new MemoryConsentRepository(state),
      new MemoryRateLimiter(state, clock),
      sender,
      new MemoryTokens(),
      hasher,
      clock,
      new MemoryUnitOfWork(),
      new MemoryOutboxWriter(state),
      new MemoryBackgroundDispatcher(),
    );
    return { service, users };
  };

  const register = (
    service: IdentityApplicationService,
    phoneValue: string,
  ): Promise<Result<{ message: string }, DomainError>> =>
    service.registerUser({
      phone: phoneValue,
      role: 'buyer',
      fullName: 'Comprador de prueba',
      deviceId: '10000000-0000-7000-8000-000000000001',
      platform: 'web',
      consent: { accepted: true, version: 'v0-draft' },
      ip: '127.0.0.1',
    } as Parameters<typeof service.registerUser>[0]);

  const userIdByPhone = async (
    users: MemoryUserRepository,
    phoneValue: string,
  ): Promise<string> => {
    const phone = PhoneNumber.parse(phoneValue);
    if (!phone.ok) throw phone.error;
    const user = await users.findByPhone(phone.value);
    return user!.id;
  };

  it('rejects updateMe with an unsupported locale', async () => {
    const { service, users } = createService();
    await register(service, '3001234567');
    const actor = makeActor();
    actor.sub = await userIdByPhone(users, '3001234567');

    const result = await service.updateMe(actor, { locale: 'fr' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unsupported_locale');
  });

  it('rejects updateMe with a full name containing a control character', async () => {
    const { service, users } = createService();
    await register(service, '3001234567');
    const actor = makeActor();
    actor.sub = await userIdByPhone(users, '3001234567');

    const result = await service.updateMe(actor, { fullName: 'T\u{007F}est' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_full_name');
  });

  it('rejects registration with an unsupported locale', async () => {
    const { service } = createService({ supportedLocales: ['en'] });
    const result = await register(service, '3001234567');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unsupported_locale');
  });
});

type AuthenticatedActor = {
  sub: string;
  role: UserRole;
  sid: string;
  did: string;
  jti: string;
  exp: number;
};
