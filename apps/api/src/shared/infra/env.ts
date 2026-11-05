import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';

const booleanFromString = z.enum(['true', 'false']).transform((value) => value === 'true');
const optionalText = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().min(1).default('tracop'),
  JWT_AUDIENCE: z.string().min(1).default('tracop-api'),
  JWT_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().nonnegative().max(60).default(5),
  OTP_HMAC_SECRET: z.string().min(32),
  RATE_LIMIT_HMAC_SECRET: z.string().min(32),
  PRIVACY_POLICY_VERSION: z.string().min(1).default('v0-draft'),
  ALLOWED_COUNTRY_CODES: z.string().default('57'),
  SUPPORTED_LOCALES: z.string().default('es-CO,en'),
  TRUST_PROXY: z.union([booleanFromString, z.coerce.number().int().nonnegative()]).default(false),
  OTP_LENGTH: z.coerce.number().int().min(4).max(10).default(6),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_PHONE_LIMIT: z.coerce.number().int().positive().default(3),
  OTP_PHONE_WINDOW_SECONDS: z.coerce.number().int().positive().default(600),
  OTP_PHONE_COOLDOWN_LIMIT: z.coerce.number().int().positive().default(1),
  OTP_PHONE_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
  OTP_IP_REQUEST_LIMIT: z.coerce.number().int().positive().default(30),
  OTP_IP_VERIFY_LIMIT: z.coerce.number().int().positive().default(60),
  OTP_IP_WINDOW_SECONDS: z.coerce.number().int().positive().default(600),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  OTP_SENDER: z.enum(['console', 'telegram']).default('console'),
  TELEGRAM_MODE: z.enum(['webhook', 'polling']).default('webhook'),
  TELEGRAM_BOT_TOKEN: optionalText(z.string().min(1)),
  TELEGRAM_WEBHOOK_SECRET: optionalText(z.string().regex(/^[A-Za-z0-9_-]{1,256}$/)),
  TELEGRAM_BOT_USERNAME: optionalText(z.string().regex(/^[A-Za-z0-9_]{5,32}$/)),
  TELEGRAM_API_ROOT: z.string().url().default('https://api.telegram.org'),
  TELEGRAM_WEBHOOK_PROCESS_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  TELEGRAM_RATE_LIMIT_PER_SENDER: z.coerce.number().int().positive().default(20),
  TELEGRAM_RATE_LIMIT_GLOBAL: z.coerce.number().int().positive().default(300),
  TELEGRAM_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  CATALOG_LOT_MAX_HORIZON_DAYS: z.coerce.number().int().positive().max(365).default(90),
  CATALOG_SEARCH_RADIUS_MAX_KM: z.coerce.number().positive().max(1000).default(500),
  CATALOG_SEARCH_RATE_LIMIT: z.coerce.number().int().positive().default(60),
  CATALOG_SEARCH_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  CATALOG_PHOTO_MAX_COUNT: z.coerce.number().int().positive().max(5).default(5),
  CATALOG_PHOTO_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024)
    .default(5 * 1024 * 1024),
  CATALOG_PHOTO_MAX_INPUT_PIXELS: z.coerce.number().int().positive().default(25_000_000),
  CATALOG_PHOTO_MAX_INPUT_DIMENSION: z.coerce.number().int().positive().default(10_000),
  CATALOG_PHOTO_MAX_OUTPUT_DIMENSION: z.coerce.number().int().positive().default(2_048),
  CATALOG_PHOTO_PENDING_TTL_SECONDS: z.coerce.number().int().positive().default(1_800),
  CATALOG_PHOTO_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  CATALOG_PHOTO_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  CATALOG_PHOTO_PURGE_GRACE_SECONDS: z.coerce.number().int().nonnegative().default(3_600),
  CATALOG_PHOTO_WEBP_QUALITY: z.coerce.number().int().min(1).max(100).default(80),
  CATALOG_PHOTO_CONCURRENCY: z.coerce.number().int().positive().default(2),
  CATALOG_PHOTO_PROCESSING_LEASE_SECONDS: z.coerce.number().int().positive().default(300),
  CATALOG_PHOTO_UPLOAD_RATE_LIMIT: z.coerce.number().int().positive().default(30),
  CATALOG_PHOTO_UPLOAD_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  S3_ENDPOINT: optionalText(z.string().url()),
  S3_PUBLIC_ENDPOINT: optionalText(z.string().url()),
  S3_BUCKET: optionalText(z.string().min(3).max(63)),
  S3_REGION: optionalText(z.string().min(1)),
  S3_API_ACCESS_KEY: optionalText(z.string().min(1)),
  S3_API_SECRET_KEY: optionalText(z.string().min(1)),
  S3_POLICY_ACCESS_KEY: optionalText(z.string().min(1)),
  S3_POLICY_SECRET_KEY: optionalText(z.string().min(1)),
});

const parsedEnvironmentSchema = envSchema.superRefine((value, ctx) => {
  const requiresTelegram = value.NODE_ENV === 'production' || value.OTP_SENDER === 'telegram';

  if (requiresTelegram && !value.TELEGRAM_BOT_TOKEN) {
    ctx.addIssue({ code: 'custom', path: ['TELEGRAM_BOT_TOKEN'], message: 'Required.' });
  }
  if (value.OTP_SENDER === 'console' && value.NODE_ENV === 'production') {
    ctx.addIssue({
      code: 'custom',
      path: ['OTP_SENDER'],
      message: 'Production requires OTP_SENDER=telegram.',
    });
  }
  if (value.NODE_ENV === 'production' && value.TELEGRAM_MODE !== 'webhook') {
    ctx.addIssue({
      code: 'custom',
      path: ['TELEGRAM_MODE'],
      message: 'Production requires TELEGRAM_MODE=webhook.',
    });
  }
  if (value.NODE_ENV === 'production') {
    for (const key of [
      'S3_ENDPOINT',
      'S3_BUCKET',
      'S3_REGION',
      'S3_API_ACCESS_KEY',
      'S3_API_SECRET_KEY',
      'S3_POLICY_ACCESS_KEY',
      'S3_POLICY_SECRET_KEY',
    ] as const) {
      if (!value[key])
        ctx.addIssue({ code: 'custom', path: [key], message: 'Required in production.' });
    }
    for (const key of ['S3_ENDPOINT', 'S3_PUBLIC_ENDPOINT'] as const) {
      const endpoint = value[key] ?? (key === 'S3_PUBLIC_ENDPOINT' ? value.S3_ENDPOINT : undefined);
      if (endpoint && new URL(endpoint).protocol !== 'https:') {
        ctx.addIssue({ code: 'custom', path: [key], message: 'Production requires an https URL.' });
      }
    }
  }
  if (value.TELEGRAM_MODE === 'polling' && value.NODE_ENV !== 'development') {
    ctx.addIssue({
      code: 'custom',
      path: ['TELEGRAM_MODE'],
      message: 'Polling is only available in development.',
    });
  }
  if (value.NODE_ENV === 'production' && !value.TELEGRAM_WEBHOOK_SECRET) {
    ctx.addIssue({
      code: 'custom',
      path: ['TELEGRAM_WEBHOOK_SECRET'],
      message: 'Required in production.',
    });
  }
});

export type AppEnvironment = z.infer<typeof envSchema> & {
  TELEGRAM_BOT_USERNAME: string;
  S3_REGION: string;
  S3_PUBLIC_ENDPOINT: string | undefined;
  allowedCountryCodes: readonly string[];
  supportedLocales: readonly string[];
  telegramBotLink: string;
};

export const loadAppEnvironment = (cwd = process.cwd()): AppEnvironment => {
  const rootEnvPath = resolve(cwd, '../../.env');
  if (existsSync(rootEnvPath)) loadEnvFile(rootEnvPath);

  const parsed = parsedEnvironmentSchema.parse(process.env);
  if (parsed.NODE_ENV === 'production' && !parsed.TELEGRAM_BOT_USERNAME) {
    throw new Error('TELEGRAM_BOT_USERNAME is required in production.');
  }
  const telegramBotUsername = parsed.TELEGRAM_BOT_USERNAME ?? 'tracop_demo_bot';

  const allowedCountryCodes = parsed.ALLOWED_COUNTRY_CODES.split(',')
    .map((countryCode) => countryCode.trim())
    .filter(Boolean);
  if (
    allowedCountryCodes.length === 0 ||
    allowedCountryCodes.some((code) => !/^\d{1,3}$/.test(code))
  ) {
    throw new Error(
      'ALLOWED_COUNTRY_CODES must be a comma-separated list of numeric calling codes.',
    );
  }

  const supportedLocales = parsed.SUPPORTED_LOCALES.split(',')
    .map((locale) => locale.trim())
    .filter(Boolean);
  if (
    supportedLocales.length === 0 ||
    supportedLocales.some((locale) => !/^[a-z]{2}(-[A-Z]{2})?$/.test(locale))
  ) {
    throw new Error('SUPPORTED_LOCALES must be a comma-separated list of locales like es-CO.');
  }

  return {
    ...parsed,
    TELEGRAM_BOT_USERNAME: telegramBotUsername,
    allowedCountryCodes,
    supportedLocales,
    telegramBotLink: `https://t.me/${telegramBotUsername}?start=link`,
    S3_PUBLIC_ENDPOINT: parsed.S3_PUBLIC_ENDPOINT ?? parsed.S3_ENDPOINT,
    S3_REGION: parsed.S3_REGION ?? 'us-east-1',
  };
};
