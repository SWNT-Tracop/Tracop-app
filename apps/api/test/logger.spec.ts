import { Writable } from 'node:stream';
import { createLogger } from '../src/shared/infra/logger.js';
import { findJsonScalarPaths, parseJsonLines } from './helpers/json-values.js';

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
    const records = parseJsonLines(output);
    expect(findJsonScalarPaths(records, '+573001234567')).toEqual([]);
    expect(findJsonScalarPaths(records, '123456')).toEqual([]);
    expect(output).not.toContain('access-secret');
    expect(output).not.toContain('refresh-secret');
  });
});
