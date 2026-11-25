import type pino from 'pino';
import {
  DemoCaptureOtpSender,
  DevelopmentOtpSender,
  InMemoryOtpSender,
  type IdentityChannelApplication,
} from '../modules/identity/index.js';
import type { MessagingPort } from '../modules/messaging/index.js';
import type { AppEnvironment } from '../shared/infra/env.js';
import { createOtpSender } from './otp-delivery.module.js';
import { TelegramOtpSender } from './telegram-otp-sender.adapter.js';

const pick = (environment: Partial<AppEnvironment>) =>
  createOtpSender(
    environment as AppEnvironment,
    {} as IdentityChannelApplication,
    {} as MessagingPort,
    {} as pino.Logger,
  );

describe('createOtpSender', () => {
  it('picks the sender for each environment', () => {
    expect(pick({ NODE_ENV: 'test', OTP_SENDER: 'telegram' })).toBeInstanceOf(InMemoryOtpSender);
    expect(pick({ NODE_ENV: 'development', OTP_SENDER: 'console' })).toBeInstanceOf(
      DevelopmentOtpSender,
    );
    expect(
      pick({ NODE_ENV: 'development', APP_PROFILE: 'demo', OTP_SENDER: 'demo_capture' }),
    ).toBeInstanceOf(DemoCaptureOtpSender);
    expect(
      pick({ NODE_ENV: 'production', OTP_SENDER: 'telegram', TELEGRAM_BOT_TOKEN: '1:token' }),
    ).toBeInstanceOf(TelegramOtpSender);
  });

  it('never builds the demo capture sender outside the demo profile, nor in production', () => {
    for (const environment of [
      { NODE_ENV: 'development', APP_PROFILE: 'development', OTP_SENDER: 'demo_capture' },
      { NODE_ENV: 'production', APP_PROFILE: 'production', OTP_SENDER: 'demo_capture' },
      { NODE_ENV: 'production', APP_PROFILE: 'demo', OTP_SENDER: 'demo_capture' },
      { NODE_ENV: 'production', OTP_SENDER: 'telegram' },
    ] as Partial<AppEnvironment>[])
      expect(() => pick(environment)).toThrow();
  });
});
