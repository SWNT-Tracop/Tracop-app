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
  };
};
