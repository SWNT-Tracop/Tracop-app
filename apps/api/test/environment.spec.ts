import { loadAppEnvironment } from '../src/shared/infra/env.js';

const environmentKeys = [
  'NODE_ENV',
  'DATABASE_URL',
  'JWT_SECRET',
  'OTP_HMAC_SECRET',
  'RATE_LIMIT_HMAC_SECRET',
  'PRIVACY_POLICY_VERSION',
  'ALLOWED_COUNTRY_CODES',
  'TRUST_PROXY',
  'OTP_SENDER',
];
const previousValues = new Map<string, string | undefined>();

describe('runtime environment validation', () => {
  beforeEach(() => {
    previousValues.clear();
    for (const key of environmentKeys) previousValues.set(key, process.env[key]);
  });
  afterEach(() => {
    for (const [key, value] of previousValues) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('rejects missing secrets before the application can start', () => {
    delete process.env.JWT_SECRET;
    expect(() => loadAppEnvironment('/tmp/tracop-no-env')).toThrow();
  });

  it('requires a non-console sender in production', () => {
    Object.assign(process.env, {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: 'j'.repeat(32),
      OTP_HMAC_SECRET: 'o'.repeat(32),
      RATE_LIMIT_HMAC_SECRET: 'r'.repeat(32),
      OTP_SENDER: 'console',
    });
    expect(() => loadAppEnvironment('/tmp/tracop-no-env')).toThrow('real OtpSenderPort');
  });

  it('parses proxy trust and the configured country allowlist', () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: 'j'.repeat(32),
      OTP_HMAC_SECRET: 'o'.repeat(32),
      RATE_LIMIT_HMAC_SECRET: 'r'.repeat(32),
      OTP_SENDER: 'console',
      TRUST_PROXY: 'true',
      ALLOWED_COUNTRY_CODES: '57,1',
    });
    const config = loadAppEnvironment('/tmp/tracop-no-env');
    expect(config.TRUST_PROXY).toBe(true);
    expect(config.allowedCountryCodes).toEqual(['57', '1']);
  });
});
