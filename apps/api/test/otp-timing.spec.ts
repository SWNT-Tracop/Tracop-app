import { IdentityApplicationService } from '../src/modules/identity/application/identity-application-service.js';
import { PhoneNumber } from '../src/modules/identity/domain/phone-number.js';
import { User } from '../src/modules/identity/domain/user.js';
import type { OtpSenderPort } from '../src/modules/identity/ports/identity-ports.js';
import {
  FixedClock,
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
} from './support/in-memory-identity.js';

class ControlledOtpSender implements OtpSenderPort {
  started = false;
  private releaseSend: (() => void) | undefined;
  private readonly finished: Promise<void>;

  constructor() {
    this.finished = new Promise<void>((resolve) => {
      this.releaseSend = resolve;
    });
  }

  async send(): Promise<void> {
    this.started = true;
    await this.finished;
  }

  release(): void {
    this.releaseSend?.();
  }
}

const timeout = (milliseconds: number): Promise<'timeout'> =>
  new Promise((resolve) => setTimeout(() => resolve('timeout'), milliseconds));

describe('OTP delivery dispatch', () => {
  it('answers the request without waiting for the channel send to finish', async () => {
    const clock = new FixedClock();
    const state = new MemoryState();
    const users = new MemoryUserRepository(state);
    const dispatcher = new MemoryBackgroundDispatcher();
    const sender = new ControlledOtpSender();
    const parsedPhone = PhoneNumber.parse('3001234567');
    if (!parsedPhone.ok) throw parsedPhone.error;
    const user = User.register(
      {
        id: 'user-1',
        phone: parsedPhone.value,
        role: 'buyer',
        fullName: 'Comprador',
        locale: 'es-CO',
        createdAt: clock.now(),
      },
      clock.now(),
    );
    await users.create(user.props);

    const service = new IdentityApplicationService(
      memorySettings,
      users,
      new MemoryOtpRepository(state),
      new MemorySessionRepository(state),
      new MemoryDeviceRepository(state),
      new MemoryConsentRepository(state),
      new MemoryRateLimiter(state, clock),
      sender,
      new MemoryTokens(),
      new MemoryHasher(),
      clock,
      new MemoryUnitOfWork(),
      new MemoryOutboxWriter(state),
      dispatcher,
    );

    const request = service.requestOtp('3001234567', '127.0.0.1');
    const completed = await Promise.race([request.then(() => 'completed' as const), timeout(100)]);

    expect(completed).toBe('completed');
    expect(sender.started).toBe(true);

    sender.release();
    await dispatcher.flush();
  });
});
