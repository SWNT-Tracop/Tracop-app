import { Injectable, Inject } from '@nestjs/common';
import type { AppEnvironment } from '../../../../shared/infra/env.js';
import { APP_ENVIRONMENT } from '../../../../shared/infra/tokens.js';
import type { OtpSenderPort } from '../../ports/identity-ports.js';
import type { PhoneNumber } from '../../domain/phone-number.js';

@Injectable()
export class DevelopmentOtpSender implements OtpSenderPort {
  constructor(@Inject(APP_ENVIRONMENT) private readonly environment: AppEnvironment) {
    if (environment.NODE_ENV !== 'development' || environment.OTP_SENDER !== 'console') {
      throw new Error('The development OTP sender can only be used in development.');
    }
  }

  async send(phone: PhoneNumber, code: string): Promise<void> {
    const lastFour = phone.value.slice(-4);
    process.stdout.write(`[development OTP] phone=***${lastFour} code=${code}\n`);
  }
}

export class InMemoryOtpSender implements OtpSenderPort {
  readonly sent: Array<{ phone: string; code: string }> = [];
  async send(phone: PhoneNumber, code: string): Promise<void> {
    this.sent.push({ phone: phone.value, code });
  }
}
