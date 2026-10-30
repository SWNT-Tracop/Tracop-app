import { Writable } from 'node:stream';
import { createLogger } from '../src/shared/infra/logger.js';

describe('Pino sensitive-field redaction', () => {
  it('redacts phone numbers, OTPs, and tokens from structured records', async () => {
    let output = '';
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createLogger('development', destination);
    logger.info(
      {
        phone: '+573001234567',
        otp: '123456',
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
      },
      'identity event',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    destination.end();
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('+573001234567');
    expect(output).not.toContain('123456');
    expect(output).not.toContain('access-secret');
    expect(output).not.toContain('refresh-secret');
  });
});
