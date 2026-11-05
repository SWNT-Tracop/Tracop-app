import type { Clock } from '../../../shared/kernel/clock.js';
import { DomainError } from '../../../shared/kernel/domain-error.js';
import { failure, success, type Result } from '../../../shared/kernel/result.js';
import type { OutboxWriter } from '../../../shared/ports/outbox-writer.js';
import { ChannelLink, type IdentityChannel } from '../domain/channel-link.js';
import { PhoneNumber } from '../domain/phone-number.js';
import type {
  ChannelLinkRepository,
  IdentityChannelApplication,
  IdentityChannelLink,
  IdentitySettings,
  LinkChannelResult,
  UserRepository,
} from '../ports/identity-ports.js';

export interface LinkChannelCommand {
  channel: IdentityChannel;
  channelUserId: string;
  phone: string;
}

export class IdentityChannelService implements IdentityChannelApplication {
  constructor(
    private readonly environment: IdentitySettings,
    private readonly users: UserRepository,
    private readonly links: ChannelLinkRepository,
    private readonly clock: Clock,
    private readonly outbox: OutboxWriter,
  ) {}

  async findActiveLinkByChannelUser(
    channel: IdentityChannel,
    channelUserId: string,
  ): Promise<IdentityChannelLink | null> {
    const link = await this.links.findByChannelUser(channel, channelUserId);
    if (!link?.verifiedAt) return null;
    return { userId: link.userId, channel: link.channel, channelUserId: link.channelUserId };
  }

  async findActiveChannelLinkByPhone(phoneInput: string): Promise<IdentityChannelLink | null> {
    const phone = PhoneNumber.parse(phoneInput, this.environment.allowedCountryCodes);
    if (!phone.ok) return null;
    const link = await this.links.findVerifiedByPhone(phone.value);
    if (!link?.verifiedAt) return null;
    return { userId: link.userId, channel: link.channel, channelUserId: link.channelUserId };
  }

  async linkChannel(command: LinkChannelCommand): Promise<Result<LinkChannelResult, DomainError>> {
    const phone = PhoneNumber.parse(command.phone, this.environment.allowedCountryCodes);
    if (!phone.ok) return failure(phone.error);

    const user = await this.users.findByPhone(phone.value);
    if (!user || user.status === 'suspended') {
      return failure(
        new DomainError(
          'Primero debes registrarte en TRACOP para vincular este canal.',
          'user_not_found',
        ),
      );
    }

    const existing = await this.links.findByChannelUser(command.channel, command.channelUserId);
    if (existing) {
      if (existing.userId === user.id) {
        return success({ status: 'already_linked', userId: user.id });
      }
      return failure(
        new DomainError('Este canal ya está vinculado a otra cuenta.', 'channel_already_linked'),
      );
    }

    const now = this.clock.now();
    const link = ChannelLink.create({
      userId: user.id,
      channel: command.channel,
      channelUserId: command.channelUserId,
      now,
    });
    await this.links.create(link.props);
    const event = link.channelLinkedEvent();
    await this.outbox.append([{ aggregate: user.id, type: event.type, payload: { ...event } }]);
    return success({ status: 'linked', userId: user.id });
  }
}
