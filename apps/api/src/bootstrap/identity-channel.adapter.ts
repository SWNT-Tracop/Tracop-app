import type {
  ChannelIdentityPort,
  ChannelUserRef,
  LinkChannelOutcome,
} from '../modules/messaging/index.js';
import type {
  ChannelOnboardingService,
  IdentityChannelApplication,
} from '../modules/identity/index.js';

export class IdentityChannelAdapter implements ChannelIdentityPort {
  constructor(
    private readonly identity: IdentityChannelApplication,
    private readonly onboarding: Pick<ChannelOnboardingService, 'linkChannel'>,
  ) {}

  async linkChannel(ref: ChannelUserRef, phone: string): Promise<LinkChannelOutcome> {
    const result = await this.onboarding.linkChannel({
      channel: ref.channel,
      channelUserId: ref.channelUserId,
      phone,
    });
    if (result.ok) {
      const { status, code } = result.value;
      return status === 'linked' && code !== undefined ? { status, code } : { status };
    }

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
