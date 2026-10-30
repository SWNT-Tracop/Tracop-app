import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';

const booleanFromString = z.enum(['true', 'false']).transform((value) => value === 'true');

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
  OTP_SENDER: z.enum(['console']).default('console'),
});

export type AppEnvironment = z.infer<typeof envSchema> & {
  allowedCountryCodes: readonly string[];
};

export const loadAppEnvironment = (cwd = process.cwd()): AppEnvironment => {
  const rootEnvPath = resolve(cwd, '../../.env');
  if (existsSync(rootEnvPath)) loadEnvFile(rootEnvPath);

  const parsed = envSchema.parse(process.env);
  if (parsed.NODE_ENV === 'production') {
    throw new Error(
      'Production startup requires an installed real OtpSenderPort; no production sender is configured.',
    );
  }

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

  return { ...parsed, allowedCountryCodes };
};
