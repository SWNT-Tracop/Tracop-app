import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { loadAppEnvironment } from '../src/shared/infra/env.js';

const EXAMPLE = resolve(__dirname, '..', '..', '..', '.env.example');
/** A directory without a .env two levels up, so only process.env is read. */
const NO_ENV_FILE = join(mkdtempSync(join(tmpdir(), 'tracop-env-')), 'a', 'b');

/** A fresh random secret: strong and distinct, and never a literal in the repository. */
const secret = () => randomBytes(32).toString('base64url');

/** Synthetic values for everything production requires. */
const COMPLETE_PRODUCTION = {
  NODE_ENV: 'production',
  APP_PROFILE: 'production',
  DATABASE_URL: 'postgres://tracop@db.internal.test/tracop',
  MIGRATION_DATABASE_URL: 'postgres://tracop_owner@db.internal.test/tracop',
  PRIVACY_POLICY_VERSION: 'v1',
  JWT_SECRET: secret(),
  OTP_HMAC_SECRET: secret(),
  RATE_LIMIT_HMAC_SECRET: secret(),
  OTP_SENDER: 'telegram',
  TELEGRAM_MODE: 'webhook',
  TELEGRAM_BOT_TOKEN: `123456789:${secret()}`,
  TELEGRAM_WEBHOOK_SECRET: secret(),
  TELEGRAM_BOT_USERNAME: 'tracop_startup_bot',
  S3_ENDPOINT: 'https://s3.internal.test',
  S3_BUCKET: 'tracop',
  S3_REGION: 'us-east-1',
  S3_API_ACCESS_KEY: 'synthetic-api-access',
  S3_API_SECRET_KEY: secret(),
  S3_POLICY_ACCESS_KEY: 'synthetic-policy-access',
  S3_POLICY_SECRET_KEY: secret(),
};

describe('production startup (env.ts)', () => {
  const saved = { ...process.env };
  const only = (values: Record<string, string>) => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, values);
  };
  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it('refuses to start with .env.example as shipped, naming every missing secret', () => {
    const example = parseEnv(readFileSync(EXAMPLE, 'utf8')) as Record<string, string>;
    only({ ...example, NODE_ENV: 'production', APP_PROFILE: 'production' });
    let message = '';
    try {
      loadAppEnvironment(NO_ENV_FILE);
    } catch (error) {
      message = String(error);
    }
    for (const key of [
      'DATABASE_URL',
      'JWT_SECRET',
      'OTP_HMAC_SECRET',
      'RATE_LIMIT_HMAC_SECRET',
      'OTP_SENDER',
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_WEBHOOK_SECRET',
      'S3_ENDPOINT',
      'S3_API_SECRET_KEY',
      'S3_POLICY_SECRET_KEY',
    ])
      expect(message).toContain(`"${key}"`);
  });

  it('starts with a complete production configuration and refuses the console and demo OTP senders', () => {
    only(COMPLETE_PRODUCTION);
    expect(loadAppEnvironment(NO_ENV_FILE)).toMatchObject({ APP_PROFILE: 'production' });
    only({ ...COMPLETE_PRODUCTION, OTP_SENDER: 'console' });
    expect(() => loadAppEnvironment(NO_ENV_FILE)).toThrow(/OTP_SENDER=telegram/);
    // The demo capture sender exists only with APP_PROFILE=demo, which production cannot use.
    only({ ...COMPLETE_PRODUCTION, OTP_SENDER: 'demo_capture' });
    expect(() => loadAppEnvironment(NO_ENV_FILE)).toThrow(/OTP_SENDER=demo_capture is only/);
    only({ ...COMPLETE_PRODUCTION, APP_PROFILE: 'demo', OTP_SENDER: 'demo_capture' });
    expect(() => loadAppEnvironment(NO_ENV_FILE)).toThrow(/never runs with NODE_ENV=production/);
    only({ ...COMPLETE_PRODUCTION, NODE_ENV: 'development', OTP_SENDER: 'demo_capture' });
    expect(() => loadAppEnvironment(NO_ENV_FILE)).toThrow(/only available with APP_PROFILE=demo/);
    only({ ...COMPLETE_PRODUCTION, TELEGRAM_MODE: 'polling' });
    expect(() => loadAppEnvironment(NO_ENV_FILE)).toThrow(/TELEGRAM_MODE/);
    only({ ...COMPLETE_PRODUCTION, S3_ENDPOINT: 'http://s3.internal.test' });
    expect(() => loadAppEnvironment(NO_ENV_FILE)).toThrow(/https/);
  });

  it('refuses draft legal texts and a single database role in production', () => {
    only({ ...COMPLETE_PRODUCTION, PRIVACY_POLICY_VERSION: 'v0-draft' });
    expect(() => loadAppEnvironment(NO_ENV_FILE)).toThrow(/v0-draft/);
    only({ ...COMPLETE_PRODUCTION, AI_CONSENT_VERSION: 'v0-draft' });
    expect(() => loadAppEnvironment(NO_ENV_FILE)).toThrow(/v0-draft/);
    const { MIGRATION_DATABASE_URL: ownerUrl, ...withoutOwner } = COMPLETE_PRODUCTION;
    expect(ownerUrl).toContain('tracop_owner');
    only(withoutOwner);
    expect(() => loadAppEnvironment(NO_ENV_FILE)).toThrow(/MIGRATION_DATABASE_URL/);
  });

  it.each(['anthropic', 'google'])(
    'accepts %s with the production deployment requirements',
    (provider) => {
      only({
        ...COMPLETE_PRODUCTION,
        AI_ENABLED: 'true',
        LLM_PROVIDER: provider,
        LLM_MODEL: 'synthetic-model',
        LLM_API_KEY: secret(),
        AI_CONSENT_VERSION: 'ai-v1',
      });
      expect(loadAppEnvironment(NO_ENV_FILE)).toMatchObject({
        APP_PROFILE: 'production',
        AI_ENABLED: true,
        LLM_PROVIDER: provider,
        MIGRATION_DATABASE_URL: COMPLETE_PRODUCTION.MIGRATION_DATABASE_URL,
      });
      process.env.AI_CONSENT_VERSION = 'v0-draft';
      expect(() => loadAppEnvironment(NO_ENV_FILE)).toThrow(/v0-draft/);
    },
  );
});
