import type { Clock } from '../../../shared/kernel/clock.js';
import { createId } from '../../../shared/kernel/ids.js';
import type {
  AiConsentChannel,
  AssistantUserView,
  IdentityAssistantApi,
  IdentityAssistantRepository,
} from '../ports/assistant-ports.js';
import type { ChannelLinkRepository, UserRepository } from '../ports/identity-ports.js';

interface UnitOfWork {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export class IdentityAssistantService implements IdentityAssistantApi {
  constructor(
    private readonly users: UserRepository,
    private readonly links: ChannelLinkRepository,
    private readonly repository: IdentityAssistantRepository,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async findUserByChannel(
    channel: AiConsentChannel,
    channelUserId: string,
  ): Promise<AssistantUserView | null> {
    const link = await this.links.findByChannelUser(channel, channelUserId);
    if (!link?.verifiedAt) return null;
    const user = await this.users.findById(link.userId);
    if (!user) return null;
    return { userId: user.id, role: user.role, active: user.status === 'active' };
  }

  providerLocation(userId: string) {
    return this.repository.providerLocation(userId);
  }

  async aiConsentStatus(
    userId: string,
    version: string,
  ): Promise<'accepted' | 'withdrawn' | 'none'> {
    const latest = await this.repository.latestAiConsent(userId, version);
    if (latest === 'accept') return 'accepted';
    return latest === 'withdraw' ? 'withdrawn' : 'none';
  }

  recordAiConsent(userId: string, version: string, channel: AiConsentChannel): Promise<void> {
    return this.decide(userId, version, channel, 'accept');
  }

  withdrawAiConsent(userId: string, version: string, channel: AiConsentChannel): Promise<void> {
    return this.decide(userId, version, channel, 'withdraw');
  }

  private decide(
    userId: string,
    version: string,
    channel: AiConsentChannel,
    decision: 'accept' | 'withdraw',
  ): Promise<void> {
    return this.uow.run(async () => {
      await this.repository.lockUser(userId);
      const latest = await this.repository.latestAiConsent(userId, version);
      if (decision === 'accept' ? latest === 'accept' : latest !== 'accept') return;
      await this.repository.appendAiConsent({
        id: createId(),
        userId,
        version,
        decision,
        channel,
        recordedAt: this.clock.now(),
      });
    });
  }
}
