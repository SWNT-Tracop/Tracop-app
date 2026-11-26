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
  /** Stops the spinner of a pressed button; best effort. */
  acknowledgeAction(callbackId: string): Promise<void>;
}

/**
 * Hands chat messages (free text, shared locations, button presses) to the conversation that
 * handles them, in the webhook's transaction. Adapted in bootstrap.
 */
export interface ConversationPort {
  accept(message: InboundMessage): Promise<void>;
}

export type LinkChannelOutcome =
  /** `code`: sign-in code issued for a newly linked chat, delivered in the reply. */
  | { status: 'linked'; code?: string }
  | { status: 'already_linked' }
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

export interface ProcessedUpdatesRetentionRepository {
  /** Deletes up to `limit` processed update ids received before the cutoff. */
  deleteReceivedBefore(cutoff: Date, limit: number): Promise<number>;
}

/** Public maintenance use case of messaging, run by the worker. */
export interface MessagingMaintenanceApi {
  purgeProcessedUpdates(): Promise<number>;
}
