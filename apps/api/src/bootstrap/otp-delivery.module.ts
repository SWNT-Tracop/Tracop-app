import { Global, Module } from '@nestjs/common';
import type pino from 'pino';
import { APP_ENVIRONMENT, APP_LOGGER } from '../shared/infra/tokens.js';
import type { AppEnvironment } from '../shared/infra/env.js';
import {
  DevelopmentOtpSender,
  IDENTITY_CHANNEL_APPLICATION,
  IdentityChannelModule,
  InMemoryOtpSender,
  OTP_SENDER,
  type IdentityChannelApplication,
  type OtpSenderPort,
} from '../modules/identity/index.js';
import { MESSAGING_PORT, MessagingModule, type MessagingPort } from '../modules/messaging/index.js';
import { TelegramOtpSender } from './telegram-otp-sender.adapter.js';

@Global()
@Module({
  imports: [IdentityChannelModule, MessagingModule],
  providers: [
    {
      provide: OTP_SENDER,
      inject: [APP_ENVIRONMENT, IDENTITY_CHANNEL_APPLICATION, MESSAGING_PORT, APP_LOGGER],
      useFactory: (
        environment: AppEnvironment,
        identity: IdentityChannelApplication,
        messaging: MessagingPort,
        logger: pino.Logger,
      ): OtpSenderPort => {
        if (environment.NODE_ENV === 'test') return new InMemoryOtpSender();
        if (environment.NODE_ENV === 'development' && environment.OTP_SENDER === 'console') {
          return new DevelopmentOtpSender(environment);
        }
        if (environment.OTP_SENDER === 'telegram' && environment.TELEGRAM_BOT_TOKEN) {
          return new TelegramOtpSender(identity, messaging, logger);
        }
        throw new Error('No OTP sender is configured for this environment.');
      },
    },
  ],
  exports: [OTP_SENDER],
})
export class OtpDeliveryModule {}
