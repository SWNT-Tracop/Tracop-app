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
  'S3_ENDPOINT',
  'S3_PUBLIC_ENDPOINT',
  'S3_BUCKET',
  'S3_REGION',
  'S3_API_ACCESS_KEY',
  'S3_API_SECRET_KEY',
  'S3_POLICY_ACCESS_KEY',
  'S3_POLICY_SECRET_KEY',
];
const previousValues = new Map<string, string | undefined>();
const productionS3 = {
  S3_ENDPOINT: 'https://s3.example.test',
  S3_BUCKET: 'tracop-test',
  S3_REGION: 'us-east-1',
  S3_API_ACCESS_KEY: 'api-key',
  S3_API_SECRET_KEY: 'api-secret',
  S3_POLICY_ACCESS_KEY: 'policy-key',
  S3_POLICY_SECRET_KEY: 'policy-secret',
} as const;

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
      ...productionS3,
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
      ...productionS3,
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
      ...productionS3,
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

  it('defaults the public S3 endpoint to the internal endpoint and keeps credentials separate', () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: 'j'.repeat(32),
      OTP_HMAC_SECRET: 'o'.repeat(32),
      RATE_LIMIT_HMAC_SECRET: 'r'.repeat(32),
      OTP_SENDER: 'console',
      TELEGRAM_MODE: 'webhook',
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_BUCKET: 'tracop-test',
      S3_API_ACCESS_KEY: 'api-key',
      S3_API_SECRET_KEY: 'api-secret',
      S3_POLICY_ACCESS_KEY: 'policy-key',
      S3_POLICY_SECRET_KEY: 'policy-secret',
    });
    delete process.env.S3_PUBLIC_ENDPOINT;
    delete process.env.S3_REGION;
    const config = loadAppEnvironment('/tmp/tracop-no-env');
    expect(config.S3_PUBLIC_ENDPOINT).toBe('http://127.0.0.1:9000');
    expect(config.S3_REGION).toBe('us-east-1');
    expect(config.S3_API_ACCESS_KEY).toBe('api-key');
    expect(config.S3_POLICY_ACCESS_KEY).toBe('policy-key');
  });

  it('honours an explicitly configured public S3 endpoint', () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: 'j'.repeat(32),
      OTP_HMAC_SECRET: 'o'.repeat(32),
      RATE_LIMIT_HMAC_SECRET: 'r'.repeat(32),
      OTP_SENDER: 'console',
      TELEGRAM_MODE: 'webhook',
      S3_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'https://files.example.test',
      S3_BUCKET: 'tracop-test',
    });
    expect(loadAppEnvironment('/tmp/tracop-no-env').S3_PUBLIC_ENDPOINT).toBe(
      'https://files.example.test',
    );
  });

  it('requires the complete S3 configuration in production', () => {
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
      TELEGRAM_BOT_USERNAME: 'tracop_test_bot',
      S3_ENDPOINT: '',
      S3_BUCKET: '',
      S3_REGION: '',
      S3_API_ACCESS_KEY: '',
      S3_API_SECRET_KEY: '',
      S3_POLICY_ACCESS_KEY: '',
      S3_POLICY_SECRET_KEY: '',
    });
    expect(() => loadAppEnvironment('/tmp/tracop-no-env')).toThrow(/S3_ENDPOINT/);
  });

  it.each(['S3_ENDPOINT', 'S3_PUBLIC_ENDPOINT'] as const)(
    'rejects a non-HTTPS %s in production',
    (endpointKey) => {
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
        TELEGRAM_BOT_USERNAME: 'tracop_test_bot',
        S3_ENDPOINT: 'https://s3.example.test',
        S3_PUBLIC_ENDPOINT: 'https://files.example.test',
        S3_BUCKET: 'tracop-test',
        S3_REGION: 'us-east-1',
        S3_API_ACCESS_KEY: 'api-key',
        S3_API_SECRET_KEY: 'api-secret',
        S3_POLICY_ACCESS_KEY: 'policy-key',
        S3_POLICY_SECRET_KEY: 'policy-secret',
        [endpointKey]: 'http://storage.example.test',
      });

      expect(() => loadAppEnvironment('/tmp/tracop-no-env')).toThrow();
    },
  );

  it('requires HTTPS for the effective public S3 endpoint in production', () => {
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
      TELEGRAM_BOT_USERNAME: 'tracop_test_bot',
      S3_ENDPOINT: 'https://s3.example.test',
      S3_BUCKET: 'tracop-test',
      S3_REGION: 'us-east-1',
      S3_API_ACCESS_KEY: 'api-key',
      S3_API_SECRET_KEY: 'api-secret',
      S3_POLICY_ACCESS_KEY: 'policy-key',
      S3_POLICY_SECRET_KEY: 'policy-secret',
    });
    delete process.env.S3_PUBLIC_ENDPOINT;

    expect(loadAppEnvironment('/tmp/tracop-no-env').S3_PUBLIC_ENDPOINT).toBe(
      'https://s3.example.test',
    );
  });
});
