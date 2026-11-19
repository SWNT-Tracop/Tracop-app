import { success, type Result } from '../../../../shared/kernel/result.js';
import type { ChannelUserRef, MessagingError, OutboundButton } from '../../domain/messaging.js';
import type { MessagingPort } from '../../ports/messaging-ports.js';

export interface SentMessage {
  to: ChannelUserRef;
  text: string;
  buttons?: readonly OutboundButton[];
}

export class InMemoryMessagingAdapter implements MessagingPort {
  readonly sent: SentMessage[] = [];

  async sendText(to: ChannelUserRef, text: string): Promise<Result<void, MessagingError>> {
    this.sent.push({ to, text });
    return success(undefined);
  }

  async sendButtons(
    to: ChannelUserRef,
    text: string,
    buttons: readonly OutboundButton[],
  ): Promise<Result<void, MessagingError>> {
    this.sent.push({ to, text, buttons });
    return success(undefined);
  }
}
