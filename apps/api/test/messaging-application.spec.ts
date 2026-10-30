import { MessagingApplicationService } from '../src/modules/messaging/application/messaging-application-service.js';
import { messagingMessages } from '../src/modules/messaging/i18n.js';
import type { InboundMessage } from '../src/modules/messaging/domain/messaging.js';
import type {
  ChannelIdentityPort,
  LinkChannelOutcome,
} from '../src/modules/messaging/ports/messaging-ports.js';
import { MemoryUnitOfWork } from './support/in-memory-identity.js';

class FakeIdentityPort implements ChannelIdentityPort {
  outcome: LinkChannelOutcome = { status: 'linked' };
  readonly linked: Array<{ channel: string; channelUserId: string; phone: string }> = [];
  throwOnLink = false;

  async linkChannel(
    ref: { channel: string; channelUserId: string },
    phone: string,
  ): Promise<LinkChannelOutcome> {
    this.linked.push({ ...ref, phone });
    if (this.throwOnLink) throw new Error('database temporarily unavailable');
    return this.outcome;
  }

  async findActiveChannelByPhone(): Promise<{ channel: 'telegram'; channelUserId: string } | null> {
    return null;
  }
}

class FakeProcessedUpdates {
  readonly claimed = new Set<string>();

  async claim(updateId: bigint): Promise<boolean> {
    const key = updateId.toString();
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }
}

const message = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: 'telegram',
  channelUserId: '900001',
  type: 'text',
  text: '/start',
  receivedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const setup = () => {
  const identity = new FakeIdentityPort();
  const processed = new FakeProcessedUpdates();
  const service = new MessagingApplicationService(identity, processed, new MemoryUnitOfWork());
  return { identity, processed, service };
};

describe('messaging application', () => {
  it('answers /start with a request-contact button', async () => {
    const { service } = setup();
    const result = await service.handleInboundMessage(message());

    expect(result.kind).toBe('processed');
    expect(result.replies).toEqual([
      {
        to: { channel: 'telegram', channelUserId: '900001' },
        text: messagingMessages.start,
        buttons: [{ text: messagingMessages.shareContact, kind: 'request_contact' }],
      },
    ]);
  });

  it('links a shared contact and confirms success', async () => {
    const { service, identity } = setup();
    const result = await service.handleInboundMessage(
      message({
        type: 'contact',
        contact: { userId: '900001', phoneNumber: '3001234567' },
      }),
    );

    expect(identity.linked).toEqual([
      { channel: 'telegram', channelUserId: '900001', phone: '3001234567' },
    ]);
    expect(result.replies[0]?.text).toBe(messagingMessages.linked);
  });

  it.each([
    ['already_linked', messagingMessages.alreadyLinked],
    ['user_not_found', messagingMessages.registerFirst],
    ['invalid_phone', messagingMessages.genericFailure],
    ['conflict', messagingMessages.genericFailure],
  ] as const)('maps link outcome %s to a safe reply', async (status, expected) => {
    const { service, identity } = setup();
    identity.outcome = { status };

    const result = await service.handleInboundMessage(
      message({
        type: 'contact',
        contact: { userId: '900001', phoneNumber: '3001234567' },
      }),
    );

    expect(result.replies[0]?.text).toBe(expected);
  });

  it('refuses a contact that does not belong to the sender', async () => {
    const { service, identity } = setup();
    const result = await service.handleInboundMessage(
      message({
        type: 'contact',
        contact: { userId: '123456', phoneNumber: '3001234567' },
      }),
    );

    expect(identity.linked).toHaveLength(0);
    expect(result.securityEvent).toBe('contact_user_mismatch');
    expect(result.replies[0]?.text).toBe(messagingMessages.contactSecurity);
  });

  it('rejects contacts without a Telegram user id', async () => {
    const { service, identity } = setup();
    const result = await service.handleInboundMessage(
      message({ type: 'contact', contact: { phoneNumber: '3001234567' } }),
    );

    expect(identity.linked).toHaveLength(0);
    expect(result.securityEvent).toBe('contact_user_mismatch');
  });

  it.each(['voice', 'photo', 'location'] as const)(
    'replies that %s is not available yet',
    async (type) => {
      const { service } = setup();
      const result = await service.handleInboundMessage(message({ type }));
      expect(result.replies[0]?.text).toBe(messagingMessages.unavailable);
    },
  );

  it('ignores other text messages', async () => {
    const { service } = setup();
    expect((await service.handleInboundMessage(message({ text: 'hola' }))).replies).toEqual([]);
    expect((await service.handleInboundMessage(message({ text: '' }))).replies).toEqual([]);
  });

  it('ignores updates without a normalizable message', async () => {
    const { service } = setup();
    expect(await service.handleUpdate(1n, null)).toEqual({ kind: 'ignored', replies: [] });
  });

  it('claims every update id once', async () => {
    const { service, identity } = setup();
    const update = message({
      type: 'contact',
      contact: { userId: '900001', phoneNumber: '3001234567' },
    });

    expect((await service.handleUpdate(10n, update)).kind).toBe('processed');
    expect(await service.handleUpdate(10n, update)).toEqual({ kind: 'duplicate', replies: [] });
    expect(identity.linked).toHaveLength(1);
  });

  it('propagates technical failures so the caller can retry', async () => {
    const { service, identity } = setup();
    identity.throwOnLink = true;

    await expect(
      service.handleUpdate(
        11n,
        message({
          type: 'contact',
          contact: { userId: '900001', phoneNumber: '3001234567' },
        }),
      ),
    ).rejects.toThrow('database temporarily unavailable');
  });
});
