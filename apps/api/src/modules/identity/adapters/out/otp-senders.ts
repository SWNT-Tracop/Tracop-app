import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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

/**
 * Demo profile only: appends each code to a file inside the API container (a tmpfs in
 * docker-compose.demo.yml), so `pnpm demo:smoke` can read it with `docker compose exec` instead
 * of reading the logs. Nothing is logged. It cannot be built outside APP_PROFILE=demo, and the
 * demo profile never runs with NODE_ENV=production (env.ts).
 */
export class DemoCaptureOtpSender implements OtpSenderPort {
  constructor(private readonly environment: AppEnvironment) {
    if (
      environment.APP_PROFILE !== 'demo' ||
      environment.NODE_ENV === 'production' ||
      environment.OTP_SENDER !== 'demo_capture'
    )
      throw new Error('The demo OTP capture sender can only be used in the demo profile.');
  }

  async send(phone: PhoneNumber, code: string): Promise<void> {
    const file = this.environment.OTP_DEMO_CAPTURE_FILE;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, JSON.stringify({ phone: phone.value, code }) + '\n', { mode: 0o600 });
    chmodSync(file, 0o600);
  }
}
