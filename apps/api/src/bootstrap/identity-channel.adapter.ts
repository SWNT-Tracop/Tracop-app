import type {
  ChannelIdentityPort,
  ChannelUserRef,
  LinkChannelOutcome,
} from '../modules/messaging/index.js';
import type { IdentityChannelApplication } from '../modules/identity/index.js';

export class IdentityChannelAdapter implements ChannelIdentityPort {
  constructor(private readonly identity: IdentityChannelApplication) {}

  async linkChannel(ref: ChannelUserRef, phone: string): Promise<LinkChannelOutcome> {
    const result = await this.identity.linkChannel({
      channel: ref.channel,
      channelUserId: ref.channelUserId,
      phone,
    });
    if (result.ok) return { status: result.value.status };

    switch (result.error.code) {
      case 'user_not_found':
        return { status: 'user_not_found' };
      case 'invalid_phone':
        return { status: 'invalid_phone' };
      default:
        return { status: 'conflict' };
    }
  }

  async findActiveChannelByPhone(phone: string): Promise<ChannelUserRef | null> {
    const link = await this.identity.findActiveChannelLinkByPhone(phone);
    if (!link) return null;
    return { channel: link.channel, channelUserId: link.channelUserId };
  }
}
