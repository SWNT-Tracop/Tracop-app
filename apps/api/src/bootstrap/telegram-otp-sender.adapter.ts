import type pino from 'pino';
import type {
  IdentityChannelApplication,
  OtpSenderPort,
  PhoneNumber,
} from '../modules/identity/index.js';
import { messagingMessages, type MessagingPort } from '../modules/messaging/index.js';

export class TelegramOtpSender implements OtpSenderPort {
  constructor(
    private readonly identity: IdentityChannelApplication,
    private readonly messaging: MessagingPort,
    private readonly logger: pino.Logger,
  ) {}

  async send(phone: PhoneNumber, code: string): Promise<void> {
    const link = await this.identity.findActiveChannelLinkByPhone(phone.value);
    if (!link) {
      this.logger.info(
        { event: 'otp_delivery_skipped', reason: 'no_active_channel' },
        'No active channel link for OTP delivery.',
      );
      return;
    }

    const result = await this.messaging.sendText(
      { channel: link.channel, channelUserId: link.channelUserId },
      messagingMessages.otp(code),
    );
    if (!result.ok) {
      this.logger.warn(
        {
          event: 'otp_delivery_failed',
          failure: result.error.kind,
          channel: link.channel,
        },
        'OTP delivery failed.',
      );
    }
  }
}
