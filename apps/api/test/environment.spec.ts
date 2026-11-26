import { randomBytes } from 'node:crypto';
import { loadAppEnvironment } from '../src/shared/infra/env.js';

/** Random, distinct secrets: production refuses trivial, reused or test values. */
const STRONG = {
  JWT_SECRET: randomBytes(32).toString('base64url'),
  OTP_HMAC_SECRET: randomBytes(32).toString('base64url'),
  RATE_LIMIT_HMAC_SECRET: randomBytes(32).toString('base64url'),
  TELEGRAM_WEBHOOK_SECRET: randomBytes(32).toString('base64url'),
} as const;

const environmentKeys = [
  'NODE_ENV',
  'OTP_IP_WINDOW_SECONDS',
  'RATE_LIMIT_RETENTION_SECONDS',
  'DATABASE_URL',
  'JWT_SECRET',
  'OTP_HMAC_SECRET',
  'RATE_LIMIT_HMAC_SECRET',
  'PRIVACY_POLICY_VERSION',
  'ALLOWED_COUNTRY_CODES',
  'CORS_ALLOWED_ORIGINS',
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
  'AI_ENABLED',
  'APP_PROFILE',
  'LLM_PROVIDER',
  'LLM_MODEL',
  'LLM_API_KEY',
  'AI_CONSENT_VERSION',
];
const previousValues = new Map<string, string | undefined>();
/** Approved legal versions: production refuses the v0-draft defaults. */
const productionLegal = {
  PRIVACY_POLICY_VERSION: 'privacy-v1',
  AI_CONSENT_VERSION: 'ai-v1',
} as const;
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
      JWT_SECRET: STRONG.JWT_SECRET,
      OTP_HMAC_SECRET: STRONG.OTP_HMAC_SECRET,
      RATE_LIMIT_HMAC_SECRET: STRONG.RATE_LIMIT_HMAC_SECRET,
      OTP_SENDER: 'console',
      ...productionS3,
    });
    expect(() => loadAppEnvironment('/tmp/tracop-no-env')).toThrow('OTP_SENDER=telegram');
  });

  it('requires Telegram credentials in production', () => {
    Object.assign(process.env, {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: STRONG.JWT_SECRET,
      OTP_HMAC_SECRET: STRONG.OTP_HMAC_SECRET,
      RATE_LIMIT_HMAC_SECRET: STRONG.RATE_LIMIT_HMAC_SECRET,
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
      JWT_SECRET: STRONG.JWT_SECRET,
      OTP_HMAC_SECRET: STRONG.OTP_HMAC_SECRET,
      RATE_LIMIT_HMAC_SECRET: STRONG.RATE_LIMIT_HMAC_SECRET,
      OTP_SENDER: 'telegram',
      TELEGRAM_MODE: 'webhook',
      TELEGRAM_BOT_TOKEN: '123456:token',
      TELEGRAM_WEBHOOK_SECRET: STRONG.TELEGRAM_WEBHOOK_SECRET,
      ...productionS3,
      ...productionLegal,
    });
    delete process.env.TELEGRAM_BOT_USERNAME;
    expect(() => loadAppEnvironment('/tmp/tracop-no-env')).toThrow('TELEGRAM_BOT_USERNAME');
  });

  it('rejects polling outside development', () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: STRONG.JWT_SECRET,
      OTP_HMAC_SECRET: STRONG.OTP_HMAC_SECRET,
      RATE_LIMIT_HMAC_SECRET: STRONG.RATE_LIMIT_HMAC_SECRET,
      OTP_SENDER: 'console',
      TELEGRAM_MODE: 'polling',
    });
    expect(() => loadAppEnvironment('/tmp/tracop-no-env')).toThrow('Polling');
  });

  it('treats empty optional Telegram values as unset in development', () => {
    Object.assign(process.env, {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: STRONG.JWT_SECRET,
      OTP_HMAC_SECRET: STRONG.OTP_HMAC_SECRET,
      RATE_LIMIT_HMAC_SECRET: STRONG.RATE_LIMIT_HMAC_SECRET,
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
      JWT_SECRET: STRONG.JWT_SECRET,
      OTP_HMAC_SECRET: STRONG.OTP_HMAC_SECRET,
      RATE_LIMIT_HMAC_SECRET: STRONG.RATE_LIMIT_HMAC_SECRET,
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
      JWT_SECRET: STRONG.JWT_SECRET,
      OTP_HMAC_SECRET: STRONG.OTP_HMAC_SECRET,
      RATE_LIMIT_HMAC_SECRET: STRONG.RATE_LIMIT_HMAC_SECRET,
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
      JWT_SECRET: STRONG.JWT_SECRET,
      OTP_HMAC_SECRET: STRONG.OTP_HMAC_SECRET,
      RATE_LIMIT_HMAC_SECRET: STRONG.RATE_LIMIT_HMAC_SECRET,
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
      JWT_SECRET: STRONG.JWT_SECRET,
      OTP_HMAC_SECRET: STRONG.OTP_HMAC_SECRET,
      RATE_LIMIT_HMAC_SECRET: STRONG.RATE_LIMIT_HMAC_SECRET,
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

  it('requires the rate-limit retention to cover the longest OTP window', () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: STRONG.JWT_SECRET,
      OTP_HMAC_SECRET: STRONG.OTP_HMAC_SECRET,
      RATE_LIMIT_HMAC_SECRET: STRONG.RATE_LIMIT_HMAC_SECRET,
      OTP_SENDER: 'console',
      OTP_IP_WINDOW_SECONDS: '900',
      RATE_LIMIT_RETENTION_SECONDS: '600',
    });
    expect(() => loadAppEnvironment('/tmp/tracop-no-env')).toThrow('RATE_LIMIT_RETENTION_SECONDS');
    process.env.RATE_LIMIT_RETENTION_SECONDS = '900';
    expect(loadAppEnvironment('/tmp/tracop-no-env').RATE_LIMIT_RETENTION_SECONDS).toBe(900);
  });

  it('keeps AI off by default and refuses to start with AI on but its settings missing', () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: STRONG.JWT_SECRET,
      OTP_HMAC_SECRET: STRONG.OTP_HMAC_SECRET,
      RATE_LIMIT_HMAC_SECRET: STRONG.RATE_LIMIT_HMAC_SECRET,
      OTP_SENDER: 'console',
    });
    for (const key of [
      'AI_ENABLED',
      'LLM_PROVIDER',
      'LLM_MODEL',
      'LLM_API_KEY',
      'AI_CONSENT_VERSION',
    ])
      delete process.env[key];
    const off = loadAppEnvironment('/tmp/tracop-no-env');
    expect([off.AI_ENABLED, off.LLM_MODEL]).toEqual([false, undefined]);

    process.env.AI_ENABLED = 'true';
    const required = {
      LLM_PROVIDER: 'anthropic',
      LLM_MODEL: 'some-model',
      LLM_API_KEY: 'k',
      AI_CONSENT_VERSION: 'ai-v1',
    };
    for (const missing of Object.keys(required)) {
      Object.assign(process.env, required);
      delete process.env[missing];
      expect(() => loadAppEnvironment('/tmp/tracop-no-env')).toThrow(missing);
    }
    Object.assign(process.env, required);
    expect(loadAppEnvironment('/tmp/tracop-no-env')).toMatchObject({
      AI_ENABLED: true,
      LLM_MODEL: 'some-model',
    });
  });

  it('keeps the demo profile away from production and production away from other NODE_ENV', () => {
    Object.assign(process.env, {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: STRONG.JWT_SECRET,
      OTP_HMAC_SECRET: STRONG.OTP_HMAC_SECRET,
      RATE_LIMIT_HMAC_SECRET: STRONG.RATE_LIMIT_HMAC_SECRET,
      OTP_SENDER: 'console',
    });
    delete process.env.APP_PROFILE;
    expect(loadAppEnvironment('/tmp/tracop-no-env').APP_PROFILE).toBe('development');
    process.env.APP_PROFILE = 'demo';
    expect(loadAppEnvironment('/tmp/tracop-no-env').APP_PROFILE).toBe('demo');
    process.env.APP_PROFILE = 'production';
    expect(() => loadAppEnvironment('/tmp/tracop-no-env')).toThrow(
      'APP_PROFILE=production requires NODE_ENV=production',
    );
    process.env.APP_PROFILE = 'demo';
    process.env.NODE_ENV = 'production';
    expect(() => loadAppEnvironment('/tmp/tracop-no-env')).toThrow(
      'The demo profile never runs with NODE_ENV=production',
    );
  });

  it('accepts an empty CORS allowlist', () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: STRONG.JWT_SECRET,
      OTP_HMAC_SECRET: STRONG.OTP_HMAC_SECRET,
      RATE_LIMIT_HMAC_SECRET: STRONG.RATE_LIMIT_HMAC_SECRET,
      OTP_SENDER: 'console',
      CORS_ALLOWED_ORIGINS: '',
    });
    expect(loadAppEnvironment('/tmp/tracop-no-env').allowedCorsOrigins).toEqual([]);
  });

  it('rejects wildcard and non-HTTPS CORS origins in production', () => {
    Object.assign(process.env, {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: STRONG.JWT_SECRET,
      OTP_HMAC_SECRET: STRONG.OTP_HMAC_SECRET,
      RATE_LIMIT_HMAC_SECRET: STRONG.RATE_LIMIT_HMAC_SECRET,
      OTP_SENDER: 'telegram',
      TELEGRAM_BOT_TOKEN: '123456:token',
      TELEGRAM_WEBHOOK_SECRET: STRONG.TELEGRAM_WEBHOOK_SECRET,
      TELEGRAM_BOT_USERNAME: 'tracop_test_bot',
      CORS_ALLOWED_ORIGINS: 'https://*.example.test',
      ...productionS3,
    });
    expect(() => loadAppEnvironment('/tmp/tracop-no-env')).toThrow('CORS_ALLOWED_ORIGINS');
  });

  it.each([
    ['http://app.example.test', 'Production requires HTTPS CORS origins.'],
    ['https://app.example.test/path', 'CORS_ALLOWED_ORIGINS solo admite orígenes, sin ruta.'],
    ['not a url', 'CORS_ALLOWED_ORIGINS contiene un origen inválido.'],
  ])('rejects the production CORS origin %s', (origin, message) => {
    Object.assign(process.env, {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: STRONG.JWT_SECRET,
      OTP_HMAC_SECRET: STRONG.OTP_HMAC_SECRET,
      RATE_LIMIT_HMAC_SECRET: STRONG.RATE_LIMIT_HMAC_SECRET,
      OTP_SENDER: 'telegram',
      TELEGRAM_BOT_TOKEN: '123456:token',
      TELEGRAM_WEBHOOK_SECRET: STRONG.TELEGRAM_WEBHOOK_SECRET,
      TELEGRAM_BOT_USERNAME: 'tracop_test_bot',
      CORS_ALLOWED_ORIGINS: origin,
      ...productionS3,
    });
    expect(() => loadAppEnvironment('/tmp/tracop-no-env')).toThrow(message);
  });

  it('accepts a list of HTTPS origins in production', () => {
    Object.assign(process.env, {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: STRONG.JWT_SECRET,
      OTP_HMAC_SECRET: STRONG.OTP_HMAC_SECRET,
      RATE_LIMIT_HMAC_SECRET: STRONG.RATE_LIMIT_HMAC_SECRET,
      OTP_SENDER: 'telegram',
      TELEGRAM_BOT_TOKEN: '123456:token',
      TELEGRAM_WEBHOOK_SECRET: STRONG.TELEGRAM_WEBHOOK_SECRET,
      TELEGRAM_BOT_USERNAME: 'tracop_test_bot',
      CORS_ALLOWED_ORIGINS: ' https://app.example.test , https://backoffice.example.test ',
      ...productionS3,
      ...productionLegal,
    });
    expect(loadAppEnvironment('/tmp/tracop-no-env').allowedCorsOrigins).toEqual([
      'https://app.example.test',
      'https://backoffice.example.test',
    ]);
  });

  it('refuses trivial, placeholder, short or reused secrets in production', () => {
    // Regression: production started with 'j'.repeat(32), with the CI values
    // (…-not-for-real-use-…) and with one secret used for JWT and OTP at once.
    const production = {
      NODE_ENV: 'production',
      APP_PROFILE: 'production',
      DATABASE_URL: 'postgres://tracop_app@localhost/test',
      MIGRATION_DATABASE_URL: 'postgres://tracop_owner@localhost/test',
      ...STRONG,
      OTP_SENDER: 'telegram',
      TELEGRAM_MODE: 'webhook',
      TELEGRAM_BOT_TOKEN: '123456:token',
      TELEGRAM_BOT_USERNAME: 'tracop_test_bot',
      ...productionS3,
      ...productionLegal,
    };
    Object.assign(process.env, production);
    expect(() => loadAppEnvironment('/tmp/tracop-no-env')).not.toThrow();
    for (const [key, value, message] of [
      ['JWT_SECRET', 'j'.repeat(32), /at least 32 characters, not a placeholder/],
      ['OTP_HMAC_SECRET', 'test-otp-hmac-secret-not-for-real-use-00000000', /not a placeholder/],
      ['RATE_LIMIT_HMAC_SECRET', 'replace-with-a-random-value-of-32-bytes', /not a placeholder/],
      ['TELEGRAM_WEBHOOK_SECRET', 'short_secret', /at least 32 characters/],
      ['OTP_HMAC_SECRET', STRONG.JWT_SECRET, /Must differ from JWT_SECRET/],
    ] as const) {
      Object.assign(process.env, production, { [key]: value });
      expect(() => loadAppEnvironment('/tmp/tracop-no-env')).toThrow(message);
    }
  });

  it('requires the complete S3 configuration in production', () => {
    Object.assign(process.env, {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: STRONG.JWT_SECRET,
      OTP_HMAC_SECRET: STRONG.OTP_HMAC_SECRET,
      RATE_LIMIT_HMAC_SECRET: STRONG.RATE_LIMIT_HMAC_SECRET,
      OTP_SENDER: 'telegram',
      TELEGRAM_MODE: 'webhook',
      TELEGRAM_BOT_TOKEN: '123456:token',
      TELEGRAM_WEBHOOK_SECRET: STRONG.TELEGRAM_WEBHOOK_SECRET,
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
        JWT_SECRET: STRONG.JWT_SECRET,
        OTP_HMAC_SECRET: STRONG.OTP_HMAC_SECRET,
        RATE_LIMIT_HMAC_SECRET: STRONG.RATE_LIMIT_HMAC_SECRET,
        OTP_SENDER: 'telegram',
        TELEGRAM_MODE: 'webhook',
        TELEGRAM_BOT_TOKEN: '123456:token',
        TELEGRAM_WEBHOOK_SECRET: STRONG.TELEGRAM_WEBHOOK_SECRET,
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
      JWT_SECRET: STRONG.JWT_SECRET,
      OTP_HMAC_SECRET: STRONG.OTP_HMAC_SECRET,
      RATE_LIMIT_HMAC_SECRET: STRONG.RATE_LIMIT_HMAC_SECRET,
      OTP_SENDER: 'telegram',
      TELEGRAM_MODE: 'webhook',
      TELEGRAM_BOT_TOKEN: '123456:token',
      TELEGRAM_WEBHOOK_SECRET: STRONG.TELEGRAM_WEBHOOK_SECRET,
      TELEGRAM_BOT_USERNAME: 'tracop_test_bot',
      S3_ENDPOINT: 'https://s3.example.test',
      S3_BUCKET: 'tracop-test',
      S3_REGION: 'us-east-1',
      S3_API_ACCESS_KEY: 'api-key',
      S3_API_SECRET_KEY: 'api-secret',
      S3_POLICY_ACCESS_KEY: 'policy-key',
      S3_POLICY_SECRET_KEY: 'policy-secret',
      ...productionLegal,
    });
    delete process.env.S3_PUBLIC_ENDPOINT;

    expect(loadAppEnvironment('/tmp/tracop-no-env').S3_PUBLIC_ENDPOINT).toBe(
      'https://s3.example.test',
    );
  });
});
