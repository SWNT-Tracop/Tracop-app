import { messagingMessages } from '../i18n.js';
import type { InboundMessage, OutboundMessage } from '../domain/messaging.js';
import type {
  ChannelIdentityPort,
  MessagingApplication,
  MessagingUnitOfWork,
  ProcessedUpdatesRepository,
  UpdateProcessingResult,
} from '../ports/messaging-ports.js';

export class MessagingApplicationService implements MessagingApplication {
  constructor(
    private readonly identity: ChannelIdentityPort,
    private readonly processedUpdates: ProcessedUpdatesRepository,
    private readonly unitOfWork: MessagingUnitOfWork,
  ) {}

  async handleUpdate(
    updateId: bigint,
    message: InboundMessage | null,
  ): Promise<UpdateProcessingResult> {
    if (!message) return { kind: 'ignored', replies: [] };

    return this.unitOfWork.run(async () => {
      const claimed = await this.processedUpdates.claim(updateId);
      if (!claimed) return { kind: 'duplicate', replies: [] };
      return this.handleInboundMessage(message);
    });
  }

  async handleInboundMessage(message: InboundMessage): Promise<UpdateProcessingResult> {
    if (message.type === 'contact') return this.handleSharedContact(message);
    if (message.type === 'text' && isStartCommand(message.text)) {
      return {
        kind: 'processed',
        replies: [
          {
            to: { channel: message.channel, channelUserId: message.channelUserId },
            text: messagingMessages.start,
            buttons: [{ text: messagingMessages.shareContact, kind: 'request_contact' }],
          },
        ],
      };
    }
    if (message.type === 'voice' || message.type === 'photo' || message.type === 'location') {
      return {
        kind: 'processed',
        replies: [this.reply(message, messagingMessages.unavailable)],
      };
    }
    return { kind: 'processed', replies: [] };
  }

  private async handleSharedContact(message: InboundMessage): Promise<UpdateProcessingResult> {
    if (!message.contact || message.contact.userId !== message.channelUserId) {
      return {
        kind: 'processed',
        replies: [this.reply(message, messagingMessages.contactSecurity)],
        securityEvent: 'contact_user_mismatch',
      };
    }

    const outcome = await this.identity.linkChannel(
      { channel: message.channel, channelUserId: message.channelUserId },
      message.contact.phoneNumber,
    );

    switch (outcome.status) {
      case 'linked':
        return { kind: 'processed', replies: [this.reply(message, messagingMessages.linked)] };
      case 'already_linked':
        return {
          kind: 'processed',
          replies: [this.reply(message, messagingMessages.alreadyLinked)],
        };
      case 'user_not_found':
        return {
          kind: 'processed',
          replies: [this.reply(message, messagingMessages.registerFirst)],
        };
      case 'invalid_phone':
      case 'conflict':
        return {
          kind: 'processed',
          replies: [this.reply(message, messagingMessages.genericFailure)],
        };
    }
  }

  private reply(message: InboundMessage, text: string): OutboundMessage {
    return {
      to: { channel: message.channel, channelUserId: message.channelUserId },
      text,
    };
  }
}

const isStartCommand = (text: string | undefined): boolean => {
  if (!text) return false;
  return text.trim().split(/\s+/)[0] === '/start';
};
