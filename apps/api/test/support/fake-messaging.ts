import { success, type Result } from '../../src/shared/kernel/result.js';
import type {
  ChannelUserRef,
  MessagingError,
  OutboundButton,
} from '../../src/modules/messaging/domain/messaging.js';
import type { MessagingPort } from '../../src/modules/messaging/ports/messaging-ports.js';

export interface FakeSentMessage {
  to: ChannelUserRef;
  text: string;
  buttons?: readonly OutboundButton[];
}

export class FakeMessagingAdapter implements MessagingPort {
  readonly sent: FakeSentMessage[] = [];
  failure: MessagingError | undefined;

  async sendText(to: ChannelUserRef, text: string): Promise<Result<void, MessagingError>> {
    return this.record({ to, text });
  }

  async sendButtons(
    to: ChannelUserRef,
    text: string,
    buttons: readonly OutboundButton[],
  ): Promise<Result<void, MessagingError>> {
    return this.record({ to, text, buttons });
  }

  private record(message: FakeSentMessage): Result<void, MessagingError> {
    this.sent.push(message);
    if (this.failure) return { ok: false, error: this.failure };
    return success(undefined);
  }
}
