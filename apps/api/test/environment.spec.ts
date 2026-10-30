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
  'TELEGRAM_MODE',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'TELEGRAM_BOT_USERNAME',
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
    expect(() => loadAppEnvironment('/tmp/tracop-no-env')).toThrow('OTP_SENDER=telegram');
  });

  it('requires Telegram credentials in production', () => {
    Object.assign(process.env, {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: 'j'.repeat(32),
      OTP_HMAC_SECRET: 'o'.repeat(32),
      RATE_LIMIT_HMAC_SECRET: 'r'.repeat(32),
      OTP_SENDER: 'telegram',
      TELEGRAM_MODE: 'webhook',
    });
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    expect(() => loadAppEnvironment('/tmp/tracop-no-env')).toThrow();
  });

  it('requires an explicit bot username in production', () => {
    Object.assign(process.env, {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: 'j'.repeat(32),
      OTP_HMAC_SECRET: 'o'.repeat(32),
      RATE_LIMIT_HMAC_SECRET: 'r'.repeat(32),
      OTP_SENDER: 'telegram',
      TELEGRAM_MODE: 'webhook',
      TELEGRAM_BOT_TOKEN: '123456:token',
      TELEGRAM_WEBHOOK_SECRET: 'secret',
    });
    delete process.env.TELEGRAM_BOT_USERNAME;
    expect(() => loadAppEnvironment('/tmp/tracop-no-env')).toThrow('TELEGRAM_BOT_USERNAME');
  });

  it('rejects polling outside development', () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: 'j'.repeat(32),
      OTP_HMAC_SECRET: 'o'.repeat(32),
      RATE_LIMIT_HMAC_SECRET: 'r'.repeat(32),
      OTP_SENDER: 'console',
      TELEGRAM_MODE: 'polling',
    });
    expect(() => loadAppEnvironment('/tmp/tracop-no-env')).toThrow('Polling');
  });

  it('treats empty optional Telegram values as unset in development', () => {
    Object.assign(process.env, {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: 'j'.repeat(32),
      OTP_HMAC_SECRET: 'o'.repeat(32),
      RATE_LIMIT_HMAC_SECRET: 'r'.repeat(32),
      OTP_SENDER: 'console',
      TELEGRAM_MODE: 'webhook',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_WEBHOOK_SECRET: '',
      TELEGRAM_BOT_USERNAME: '',
    });
    const config = loadAppEnvironment('/tmp/tracop-no-env');
    expect(config.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(config.TELEGRAM_BOT_USERNAME).toBe('tracop_demo_bot');
    expect(config.telegramBotLink).toBe('https://t.me/tracop_demo_bot?start=link');
  });

  it('derives the public bot link from the configured username', () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: 'j'.repeat(32),
      OTP_HMAC_SECRET: 'o'.repeat(32),
      RATE_LIMIT_HMAC_SECRET: 'r'.repeat(32),
      OTP_SENDER: 'console',
      TELEGRAM_MODE: 'webhook',
      TELEGRAM_BOT_USERNAME: 'tracop_test_bot',
    });
    expect(loadAppEnvironment('/tmp/tracop-no-env').telegramBotLink).toBe(
      'https://t.me/tracop_test_bot?start=link',
    );
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
