import { Writable } from 'node:stream';
import { TelegramOtpSender } from '../src/bootstrap/telegram-otp-sender.adapter.js';
import { messagingMessages } from '../src/modules/messaging/index.js';
import type {
  IdentityChannelLink,
  IdentityChannelApplication,
} from '../src/modules/identity/index.js';
import { PhoneNumber } from '../src/modules/identity/domain/phone-number.js';
import { createLogger } from '../src/shared/infra/logger.js';
import { FakeMessagingAdapter } from './support/fake-messaging.js';

class FakeIdentityChannel implements IdentityChannelApplication {
  link: IdentityChannelLink | null = null;

  async findActiveLinkByChannelUser(): Promise<IdentityChannelLink | null> {
    return null;
  }

  async findActiveChannelLinkByPhone(): Promise<IdentityChannelLink | null> {
    return this.link;
  }

  async linkChannel(): Promise<never> {
    throw new Error('not used');
  }
}

const phone = PhoneNumber.parse('3001234567');
if (!phone.ok) throw phone.error;

const captureLogger = () => {
  let output = '';
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  return { logger: createLogger('development', destination), read: () => output };
};

describe('Telegram OTP sender', () => {
  it('sends the OTP to the active channel link', async () => {
    const identity = new FakeIdentityChannel();
    identity.link = { userId: 'user-1', channel: 'telegram', channelUserId: '900001' };
    const messaging = new FakeMessagingAdapter();
    const { logger } = captureLogger();

    await new TelegramOtpSender(identity, messaging, logger).send(phone.value, '123456');

    expect(messaging.sent).toEqual([
      {
        to: { channel: 'telegram', channelUserId: '900001' },
        text: messagingMessages.otp('123456'),
      },
    ]);
  });

  it('skips delivery without an active link', async () => {
    const messaging = new FakeMessagingAdapter();
    const { logger, read } = captureLogger();

    await new TelegramOtpSender(new FakeIdentityChannel(), messaging, logger).send(
      phone.value,
      '123456',
    );

    expect(messaging.sent).toHaveLength(0);
    expect(read()).toContain('otp_delivery_skipped');
  });

  it('logs delivery failures without throwing', async () => {
    const identity = new FakeIdentityChannel();
    identity.link = { userId: 'user-1', channel: 'telegram', channelUserId: '900001' };
    const messaging = new FakeMessagingAdapter();
    messaging.failure = { kind: 'blocked_by_user' };
    const { logger, read } = captureLogger();

    await expect(
      new TelegramOtpSender(identity, messaging, logger).send(phone.value, '123456'),
    ).resolves.toBeUndefined();

    expect(read()).toContain('otp_delivery_failed');
    expect(read()).not.toContain('900001');
  });
});
