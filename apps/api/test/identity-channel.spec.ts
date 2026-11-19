import { DomainError } from '../src/shared/kernel/domain-error.js';
import { User } from '../src/modules/identity/domain/user.js';
import { PhoneNumber } from '../src/modules/identity/domain/phone-number.js';
import {
  ChannelLink,
  type ChannelLinkProps,
  type IdentityChannel,
} from '../src/modules/identity/domain/channel-link.js';
import { IdentityChannelService } from '../src/modules/identity/application/identity-channel-service.js';
import type { ChannelLinkRepository } from '../src/modules/identity/ports/identity-ports.js';
import {
  FixedClock,
  MemoryOutboxWriter,
  MemoryState,
  MemoryUserRepository,
  memorySettings,
} from './support/in-memory-identity.js';

class MemoryChannelLinkRepository implements ChannelLinkRepository {
  readonly links: ChannelLinkProps[] = [];

  async findByChannelUser(
    channel: IdentityChannel,
    channelUserId: string,
  ): Promise<ChannelLinkProps | null> {
    return (
      this.links.find((link) => link.channel === channel && link.channelUserId === channelUserId) ??
      null
    );
  }

  async findVerifiedByPhone(phone: PhoneNumber): Promise<ChannelLinkProps | null> {
    return (
      this.links.find(
        (link) =>
          link.verifiedAt !== null && this.users.get(link.userId)?.phone.equals(phone) === true,
      ) ?? null
    );
  }

  async create(link: ChannelLinkProps): Promise<void> {
    this.links.push(link);
  }

  constructor(private readonly users: Map<string, { phone: PhoneNumber }>) {}
}

const setup = () => {
  const clock = new FixedClock();
  const state = new MemoryState();
  const users = new MemoryUserRepository(state);
  const links = new MemoryChannelLinkRepository(state.users);
  const outbox = new MemoryOutboxWriter(state);
  const service = new IdentityChannelService(memorySettings, users, links, clock, outbox);
  const addUser = (
    phoneValue: string,
    status: 'pending_verification' | 'active' | 'suspended' = 'active',
  ) => {
    const parsed = PhoneNumber.parse(phoneValue);
    if (!parsed.ok) throw parsed.error;
    const user = User.register(
      {
        id: `user-${phoneValue}`,
        phone: parsed.value,
        role: 'producer',
        fullName: 'Productor',
        locale: 'es-CO',
        createdAt: clock.now(),
      },
      clock.now(),
    ).props;
    user.status = status;
    state.users.set(user.id, user);
    return user;
  };
  return { clock, state, users, links, outbox, service, addUser };
};

describe('identity channel linking', () => {
  it('links a pending user and emits a ChannelLinked event without channel or phone data', async () => {
    const { addUser, service, state } = setup();
    const user = addUser('3001234567', 'pending_verification');

    const result = await service.linkChannel({
      channel: 'telegram',
      channelUserId: '900001',
      phone: '3001234567',
    });

    expect(result).toEqual({ ok: true, value: { status: 'linked', userId: user.id } });
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0]).toMatchObject({
      aggregate: user.id,
      type: 'ChannelLinked',
    });
    const payload = state.outbox[0]!.payload as Record<string, unknown>;
    expect(payload.userId).toBe(user.id);
    expect(payload.channel).toBe('telegram');
    expect(payload).not.toHaveProperty('channelUserId');
    expect(payload).not.toHaveProperty('phone');
  });

  it('is idempotent for the same user and channel', async () => {
    const { addUser, service, state } = setup();
    addUser('3001234567');

    await service.linkChannel({
      channel: 'telegram',
      channelUserId: '900001',
      phone: '3001234567',
    });
    const second = await service.linkChannel({
      channel: 'telegram',
      channelUserId: '900001',
      phone: '3001234567',
    });

    expect(second).toEqual({
      ok: true,
      value: { status: 'already_linked', userId: 'user-3001234567' },
    });
    expect(state.outbox).toHaveLength(1);
  });

  it('never reassigns a channel already linked to another user', async () => {
    const { addUser, service, links } = setup();
    addUser('3001234567');
    addUser('3007654321');
    await service.linkChannel({
      channel: 'telegram',
      channelUserId: '900001',
      phone: '3001234567',
    });

    const result = await service.linkChannel({
      channel: 'telegram',
      channelUserId: '900001',
      phone: '3007654321',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('channel_already_linked');
    expect(links.links).toHaveLength(1);
  });

  it('rejects unknown and suspended users with a generic not-found result', async () => {
    const { addUser, service } = setup();
    addUser('3001234567', 'suspended');

    const unknown = await service.linkChannel({
      channel: 'telegram',
      channelUserId: '900001',
      phone: '3009999999',
    });
    const suspended = await service.linkChannel({
      channel: 'telegram',
      channelUserId: '900002',
      phone: '3001234567',
    });

    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('user_not_found');
    expect(suspended.ok).toBe(false);
    if (!suspended.ok) expect(suspended.error.code).toBe('user_not_found');
  });

  it('rejects invalid phone numbers before touching the database', async () => {
    const { service, links } = setup();
    const result = await service.linkChannel({
      channel: 'telegram',
      channelUserId: '900001',
      phone: '123',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_phone');
    expect(links.links).toHaveLength(0);
  });

  it('finds only verified links by channel user and by phone', async () => {
    const { addUser, service, links } = setup();
    const user = addUser('3001234567');
    const now = new Date('2026-01-01T00:00:00.000Z');
    links.links.push({
      id: 'unverified',
      userId: user.id,
      channel: 'telegram',
      channelUserId: '700001',
      verifiedAt: null,
      createdAt: now,
    });
    links.links.push({
      id: 'verified',
      userId: user.id,
      channel: 'telegram',
      channelUserId: '700002',
      verifiedAt: now,
      createdAt: now,
    });

    expect(await service.findActiveLinkByChannelUser('telegram', '700001')).toBeNull();
    expect(await service.findActiveLinkByChannelUser('telegram', '700002')).toEqual({
      userId: user.id,
      channel: 'telegram',
      channelUserId: '700002',
    });
    expect(await service.findActiveChannelLinkByPhone('3001234567')).toEqual({
      userId: user.id,
      channel: 'telegram',
      channelUserId: '700002',
    });
    expect(await service.findActiveChannelLinkByPhone('123')).toBeNull();
  });
});

describe('ChannelLink domain', () => {
  it('rejects empty identifiers', () => {
    expect(() =>
      ChannelLink.create({
        userId: '',
        channel: 'telegram',
        channelUserId: '1',
        now: new Date(),
      }),
    ).toThrow(DomainError);
  });

  it('builds the ChannelLinked event without the channel user identifier', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const link = ChannelLink.create({
      userId: 'user-1',
      channel: 'telegram',
      channelUserId: '900001',
      now,
    });
    expect(link.channelLinkedEvent()).toEqual({
      type: 'ChannelLinked',
      userId: 'user-1',
      channel: 'telegram',
      occurredAt: now.toISOString(),
    });
  });
});
