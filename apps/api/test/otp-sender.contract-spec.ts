import {
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
});
