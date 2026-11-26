import type { DomainError } from '../../../shared/kernel/domain-error.js';
import { success, type Result } from '../../../shared/kernel/result.js';
import type { IdentityChannelApplication, LinkChannelResult } from '../ports/identity-ports.js';
import type { LinkChannelCommand } from './identity-channel-service.js';

export interface LinkCodeIssuer {
  issueCodeForNewChannelLink(phone: string): Promise<string | null>;
}

export type ChannelOnboardingResult = LinkChannelResult & { readonly code?: string };

/**
 * Links a messaging chat and, when the chat is new, issues the sign-in code that registration
 * could not deliver yet, so the person gets it in that same chat without asking again.
 */
export class ChannelOnboardingService {
  constructor(
    private readonly channels: Pick<IdentityChannelApplication, 'linkChannel'>,
    private readonly codes: LinkCodeIssuer,
  ) {}

  async linkChannel(
    command: LinkChannelCommand,
  ): Promise<Result<ChannelOnboardingResult, DomainError>> {
    const linked = await this.channels.linkChannel(command);
    if (!linked.ok || linked.value.status !== 'linked') return linked;
    const code = await this.codes.issueCodeForNewChannelLink(command.phone);
    return success(code === null ? linked.value : { ...linked.value, code });
  }
}
