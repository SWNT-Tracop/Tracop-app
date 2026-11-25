import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DemoCaptureOtpSender,
  DevelopmentOtpSender,
  InMemoryOtpSender,
} from '../src/modules/identity/adapters/out/otp-senders.js';
import { PhoneNumber } from '../src/modules/identity/domain/phone-number.js';
import type { AppEnvironment } from '../src/shared/infra/env.js';

const parsedPhone = PhoneNumber.parse('+573001234567');
if (!parsedPhone.ok) throw parsedPhone.error;

const runOtpSenderContract = async (send: (phone: PhoneNumber, code: string) => Promise<void>) => {
  await send(parsedPhone.value, '123456');
};

describe('OtpSenderPort contract', () => {
  it('stores the OTP through the in-memory adapter', async () => {
    const adapter = new InMemoryOtpSender();
    await runOtpSenderContract((phone, code) => adapter.send(phone, code));
    expect(adapter.sent).toEqual([{ phone: '+573001234567', code: '123456' }]);
  });

  it('writes the OTP only via the development adapter output', async () => {
    const adapter = new DevelopmentOtpSender({
      NODE_ENV: 'development',
      OTP_SENDER: 'console',
    } as AppEnvironment);
    const output = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runOtpSenderContract((phone, code) => adapter.send(phone, code));
      expect(output).toHaveBeenCalledWith('[development OTP] phone=***4567 code=123456\n');
    } finally {
      output.mockRestore();
    }
  });

  it('refuses to construct the console sender outside development', () => {
    expect(
      () =>
        new DevelopmentOtpSender({
          NODE_ENV: 'production',
          OTP_SENDER: 'console',
        } as AppEnvironment),
    ).toThrow();
  });

  it('captures demo codes in a private file, only in the demo profile', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tracop-otp-'));
    try {
      const file = join(directory, 'otp', 'codes.jsonl');
      const demo = {
        NODE_ENV: 'development',
        APP_PROFILE: 'demo',
        OTP_SENDER: 'demo_capture',
        OTP_DEMO_CAPTURE_FILE: file,
      } as AppEnvironment;
      const adapter = new DemoCaptureOtpSender(demo);
      const output = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await runOtpSenderContract((phone, code) => adapter.send(phone, code));
        await adapter.send(parsedPhone.value, '654321');
        expect(output).not.toHaveBeenCalled();
      } finally {
        output.mockRestore();
      }
      expect(
        readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual([
        { phone: '+573001234567', code: '123456' },
        { phone: '+573001234567', code: '654321' },
      ]);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      for (const environment of [
        { ...demo, APP_PROFILE: 'development' },
        { ...demo, APP_PROFILE: 'production' },
        { ...demo, NODE_ENV: 'production' },
        { ...demo, OTP_SENDER: 'console' },
      ])
        expect(() => new DemoCaptureOtpSender(environment as AppEnvironment)).toThrow(
          /only be used in the demo profile/,
        );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
