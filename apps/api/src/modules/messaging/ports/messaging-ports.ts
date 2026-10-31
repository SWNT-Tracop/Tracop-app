import type { Result } from '../../../shared/kernel/result.js';
import type {
  ChannelUserRef,
  InboundMessage,
  MessagingError,
  OutboundButton,
  OutboundMessage,
} from '../domain/messaging.js';

export interface MessagingPort {
  sendText(to: ChannelUserRef, text: string): Promise<Result<void, MessagingError>>;
  sendButtons(
    to: ChannelUserRef,
    text: string,
    buttons: readonly OutboundButton[],
  ): Promise<Result<void, MessagingError>>;
}

export type LinkChannelOutcome =
  | { status: 'linked' | 'already_linked' }
  | { status: 'user_not_found' | 'invalid_phone' | 'conflict' };

export interface ChannelIdentityPort {
  linkChannel(ref: ChannelUserRef, phone: string): Promise<LinkChannelOutcome>;
  findActiveChannelByPhone(phone: string): Promise<ChannelUserRef | null>;
}

export interface ProcessedUpdatesRepository {
  claim(updateId: bigint): Promise<boolean>;
}

export interface MessagingUnitOfWork {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export interface UpdateProcessingResult {
  kind: 'processed' | 'duplicate' | 'ignored' | 'dropped';
  replies: readonly OutboundMessage[];
  securityEvent?: 'contact_user_mismatch';
}

export interface MessagingApplication {
  handleUpdate(updateId: bigint, message: InboundMessage | null): Promise<UpdateProcessingResult>;
  handleInboundMessage(message: InboundMessage): Promise<UpdateProcessingResult>;
}
