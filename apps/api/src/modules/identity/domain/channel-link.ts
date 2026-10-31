import { DomainError } from '../../../shared/kernel/domain-error.js';
import { createId } from '../../../shared/kernel/ids.js';

export type IdentityChannel = 'telegram' | 'whatsapp' | 'app';

export interface ChannelLinkProps {
  id: string;
  userId: string;
  channel: IdentityChannel;
  channelUserId: string;
  verifiedAt: Date | null;
  createdAt: Date;
}

export interface ChannelLinkedEvent {
  type: 'ChannelLinked';
  userId: string;
  channel: IdentityChannel;
  occurredAt: string;
}

export class ChannelLink {
  constructor(public readonly props: ChannelLinkProps) {}

  static create(input: {
    userId: string;
    channel: IdentityChannel;
    channelUserId: string;
    now: Date;
  }): ChannelLink {
    if (!input.userId.trim() || !input.channelUserId.trim()) {
      throw new DomainError('El vínculo de canal no es válido.', 'invalid_channel_link');
    }
    return new ChannelLink({
      id: createId(),
      userId: input.userId,
      channel: input.channel,
      channelUserId: input.channelUserId,
      verifiedAt: input.now,
      createdAt: input.now,
    });
  }

  channelLinkedEvent(): ChannelLinkedEvent {
    return {
      type: 'ChannelLinked',
      userId: this.props.userId,
      channel: this.props.channel,
      occurredAt: (this.props.verifiedAt ?? this.props.createdAt).toISOString(),
    };
  }
}
