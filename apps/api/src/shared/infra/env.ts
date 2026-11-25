import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

const booleanFromString = z.enum(['true', 'false']).transform((value) => value === 'true');
const optionalText = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const MIN_PRODUCTION_SECRET_LENGTH = 32;
/** Markers of the repository's CI, test and example values, or of a value nobody generated. */
const PLACEHOLDER_SECRET = /not-for-real|change-?me|example|placeholder|dummy|replace|secret-here/i;
const MIN_DISTINCT_SECRET_CHARACTERS = 10;
const isPlaceholderSecret = (secret: string): boolean =>
  PLACEHOLDER_SECRET.test(secret) || new Set(secret).size < MIN_DISTINCT_SECRET_CHARACTERS;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // How the deployment is used. demo: synthetic data only (seed allowed, OTP codes on the console,
  // no Swagger) and never with NODE_ENV=production; production requires NODE_ENV=production.
  APP_PROFILE: z.enum(['development', 'demo', 'production']).default('development'),
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
  CORS_ALLOWED_ORIGINS: z.string().default(''),
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
  // PROVISIONAL: a refresh retried this soon after its rotation (lost response on a weak
  // network) gets a fresh pair instead of revoking the family; 0 disables the grace.
  REFRESH_GRACE_SECONDS: z.coerce.number().int().min(0).max(120).default(30),
  // PROVISIONAL: registrations never verified are expired after these hours.
  UNVERIFIED_RETENTION_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  JOB_EXPIRE_UNVERIFIED_CRON: z.string().trim().min(9).default('23 * * * *'),
  OTP_SENDER: z.enum(['console', 'telegram', 'demo_capture']).default('console'),
  /** Demo profile only (OTP_SENDER=demo_capture): file the smoke script reads the codes from. */
  OTP_DEMO_CAPTURE_FILE: z.string().trim().min(1).default('/run/tracop-otp/codes.jsonl'),
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
  // PROVISIONAL: pending proposals per provider; validate with real producers.
  CATALOG_PRODUCT_PROPOSAL_PENDING_LIMIT: z.coerce.number().int().positive().max(50).default(5),
  CATALOG_PRODUCT_PROPOSAL_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  CATALOG_PRODUCT_PROPOSAL_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
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
  SYNC_PUSH_MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(256 * 1024)
    .default(256 * 1024),
  SYNC_PUSH_RATE_LIMIT: z.coerce.number().int().positive().default(30),
  SYNC_PULL_RATE_LIMIT: z.coerce.number().int().positive().default(120),
  SYNC_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  ORDER_QUOTE_TTL_HOURS: z.coerce.number().int().positive().default(24),
  ORDER_RESERVATION_TTL_HOURS: z.coerce.number().int().positive().default(24),
  ORDER_SUBTOTAL_ROUNDING: z.enum(['half_up', 'floor', 'ceil']).default('half_up'),
  ORDER_COMMISSION_RATE_BPS: z
    .string()
    .regex(/^(0|[1-9]\d{0,4})$/)
    .default('0')
    .transform(BigInt),
  ORDER_FREIGHT_COP: z
    .string()
    .regex(/^(0|[1-9]\d{0,18})$/)
    .default('0')
    .transform(BigInt),
  ORDER_RATE_LIMIT: z.coerce.number().int().positive().default(60),
  ORDER_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  ORDER_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  ORDER_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // PROVISIONAL payment values (AGENTS §23): validate with the team before the pilot.
  PAYMENT_REJECTION_GRACE_HOURS: z.coerce.number().int().positive().max(168).default(4),
  PAYMENT_CLAIM_WINDOW_HOURS: z.coerce.number().int().positive().max(720).default(48),
  PAYMENT_PROOF_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024)
    .default(5 * 1024 * 1024),
  PAYMENT_PROOF_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  PAYMENT_PROOF_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // PROVISIONAL retention values; validate with the team and Ley 1581 obligations.
  OTP_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  SESSION_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  PROCESSED_UPDATES_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  RATE_LIMIT_RETENTION_SECONDS: z.coerce.number().int().positive().default(86_400),
  // PROVISIONAL trust values (AGENTS §23); editable by admins as run-time parameters.
  TRUST_RATING_WINDOW_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  TRUST_MIN_RATINGS_VISIBLE: z.coerce.number().int().min(1).max(50).default(3),
  TRUST_COMMENT_MAX_LENGTH: z.coerce.number().int().min(0).max(500).default(500),
  TRUST_VERIFICATION_COOLDOWN_DAYS: z.coerce.number().int().min(0).max(365).default(7),
  TRUST_RATING_RATE_LIMIT: z.coerce.number().int().positive().default(20),
  TRUST_VERIFICATION_RATE_LIMIT: z.coerce.number().int().positive().default(5),
  TRUST_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  // PROVISIONAL: how long a downloaded location pack may be kept by the app.
  LOGISTICS_LOCATION_MAX_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  LOGISTICS_LOCATION_RATE_LIMIT: z.coerce.number().int().positive().default(30),
  LOGISTICS_LOCATION_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  JOB_EXPIRE_LOTS_CRON: z.string().trim().min(9).default('*/5 * * * *'),
  JOB_EXPIRE_ORDERS_CRON: z.string().trim().min(9).default('*/5 * * * *'),
  JOB_PURGE_PHOTOS_CRON: z.string().trim().min(9).default('17 * * * *'),
  JOB_RETENTION_CRON: z.string().trim().min(9).default('40 4 * * *'),
  JOB_OUTBOX_DISPATCH_CRON: z.string().trim().min(9).default('* * * * *'),
  JOB_ISSUE_SETTLEMENTS_CRON: z.string().trim().min(9).default('*/15 * * * *'),
  JOB_SEND_NOTIFICATIONS_CRON: z.string().trim().min(9).default('* * * * *'),
  NOTIFICATIONS_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  NOTIFICATIONS_RETRY_BASE_SECONDS: z.coerce.number().int().positive().max(3600).default(30),
  NOTIFICATIONS_RETRY_MAX_SECONDS: z.coerce.number().int().positive().max(86_400).default(3600),
  NOTIFICATIONS_LEASE_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
  OUTBOX_LEASE_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  OUTBOX_RETRY_BASE_SECONDS: z.coerce.number().int().positive().max(3600).default(5),
  OUTBOX_RETRY_MAX_SECONDS: z.coerce.number().int().positive().max(86_400).default(300),
  // Recommendations and price suggestions. All values PROVISIONAL.
  RECOMMENDATIONS_REFERENCE_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  RECOMMENDATIONS_OBSERVATION_WINDOW_DAYS: z.coerce.number().int().min(1).max(730).default(90),
  RECOMMENDATIONS_MIN_SAMPLE: z.coerce.number().int().min(3).max(100).default(3),
  RECOMMENDATIONS_MIN_OWN_OBSERVATIONS: z.coerce.number().int().min(3).max(100).default(3),
  RECOMMENDATIONS_MIN_OWN_PROVIDERS: z.coerce.number().int().min(1).max(20).default(2),
  RECOMMENDATIONS_WEIGHT_REORDER: z.coerce.number().int().min(0).max(100).default(30),
  RECOMMENDATIONS_WEIGHT_NEARBY: z.coerce.number().int().min(0).max(100).default(20),
  RECOMMENDATIONS_WEIGHT_GOOD_PRICE: z.coerce.number().int().min(0).max(100).default(25),
  RECOMMENDATIONS_WEIGHT_VERIFIED_PROVIDER: z.coerce.number().int().min(0).max(100).default(15),
  RECOMMENDATIONS_WEIGHT_FRESH: z.coerce.number().int().min(0).max(100).default(10),
  RECOMMENDATIONS_NEARBY_KM: z.coerce.number().int().min(1).max(300).default(50),
  RECOMMENDATIONS_FRESH_HOURS: z.coerce.number().int().min(1).max(720).default(48),
  RECOMMENDATIONS_CANDIDATE_LIMIT: z.coerce.number().int().min(10).max(500).default(200),
  RECOMMENDATIONS_DEFAULT_RADIUS_KM: z.coerce.number().int().min(1).max(300).default(100),
  RECOMMENDATIONS_ALERTS_PER_USER: z.coerce.number().int().min(1).max(100).default(10),
  RECOMMENDATIONS_RATE_LIMIT: z.coerce.number().int().positive().default(60),
  RECOMMENDATIONS_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // AI assistant. Off by default; with AI_ENABLED=true the provider, model, key and consent
  // version are required (no default model). Limits and retention are PROVISIONAL.
  AI_ENABLED: booleanFromString.default(false),
  LLM_PROVIDER: optionalText(z.enum(['anthropic'])),
  LLM_MODEL: optionalText(z.string().min(1).max(100)),
  LLM_API_KEY: optionalText(z.string().min(1)),
  LLM_BASE_URL: optionalText(z.string().url()),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(4096).default(400),
  AI_CONSENT_VERSION: optionalText(z.string().min(1).max(64)),
  AI_DAILY_REQUESTS_PER_USER: z.coerce.number().int().min(1).max(1000).default(30),
  AI_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(120).default(6),
  AI_MONTHLY_TOKEN_CAP: z.coerce.number().int().min(1).max(1_000_000_000).default(2_000_000),
  AI_DRAFT_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  AI_FINISHED_DRAFT_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  AI_USAGE_RETENTION_DAYS: z.coerce.number().int().min(1).max(730).default(90),
  AI_INBOX_LEASE_SECONDS: z.coerce.number().int().min(10).max(600).default(60),
  AI_INBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  JOB_WORKER_HEARTBEAT_CRON: z.string().trim().min(9).default('* * * * *'),
  // A worker whose newest heartbeat is older than this makes GET /ready answer 503.
  READY_WORKER_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(3600).default(180),
  // Bearer token for GET /metrics; without it the endpoint does not exist (404).
  METRICS_TOKEN: optionalText(z.string().min(32)),
  JOB_AI_INBOX_CRON: z.string().trim().min(9).default('* * * * *'),
  JOB_AI_MAINTENANCE_CRON: z.string().trim().min(9).default('*/10 * * * *'),
  S3_ENDPOINT: optionalText(z.string().url()),
  S3_PUBLIC_ENDPOINT: optionalText(z.string().url()),
  S3_BUCKET: optionalText(z.string().min(3).max(63)),
  S3_REGION: optionalText(z.string().min(1)),
  S3_API_ACCESS_KEY: optionalText(z.string().min(1)),
  S3_API_SECRET_KEY: optionalText(z.string().min(1)),
  S3_POLICY_ACCESS_KEY: optionalText(z.string().min(1)),
  S3_POLICY_SECRET_KEY: optionalText(z.string().min(1)),
  // MinIO needs path-style addressing; AWS S3 uses virtual-hosted style. Set `false` for AWS.
  S3_FORCE_PATH_STYLE: booleanFromString.default(true),
});

const parsedEnvironmentSchema = envSchema.superRefine((value, ctx) => {
  const longestDatabaseRateWindow = Math.max(
    value.OTP_PHONE_WINDOW_SECONDS,
    value.OTP_PHONE_COOLDOWN_SECONDS,
    value.OTP_IP_WINDOW_SECONDS,
  );
  if (value.RATE_LIMIT_RETENTION_SECONDS < longestDatabaseRateWindow) {
    ctx.addIssue({
      code: 'custom',
      path: ['RATE_LIMIT_RETENTION_SECONDS'],
      message: 'RATE_LIMIT_RETENTION_SECONDS must cover the longest OTP rate-limit window.',
    });
  }
  if (value.AI_ENABLED) {
    for (const key of ['LLM_PROVIDER', 'LLM_MODEL', 'LLM_API_KEY', 'AI_CONSENT_VERSION'] as const) {
      if (!value[key])
        ctx.addIssue({ code: 'custom', path: [key], message: 'Required when AI_ENABLED=true.' });
    }
  }
  if (value.APP_PROFILE === 'production' && value.NODE_ENV !== 'production')
    ctx.addIssue({
      code: 'custom',
      path: ['APP_PROFILE'],
      message: 'APP_PROFILE=production requires NODE_ENV=production.',
    });
  if (value.APP_PROFILE === 'demo' && value.NODE_ENV === 'production')
    ctx.addIssue({
      code: 'custom',
      path: ['APP_PROFILE'],
      message: 'The demo profile never runs with NODE_ENV=production.',
    });
  const requiresTelegram = value.NODE_ENV === 'production' || value.OTP_SENDER === 'telegram';

  if (requiresTelegram && !value.TELEGRAM_BOT_TOKEN) {
    ctx.addIssue({ code: 'custom', path: ['TELEGRAM_BOT_TOKEN'], message: 'Required.' });
  }
  if (value.OTP_SENDER === 'demo_capture' && value.APP_PROFILE !== 'demo') {
    ctx.addIssue({
      code: 'custom',
      path: ['OTP_SENDER'],
      message: 'OTP_SENDER=demo_capture is only available with APP_PROFILE=demo.',
    });
  }
  if (value.OTP_SENDER !== 'telegram' && value.NODE_ENV === 'production') {
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
  if (value.NODE_ENV === 'production') {
    // CI, test and example values are public: production refuses them, trivial values and a
    // secret reused for two purposes.
    const secrets = {
      JWT_SECRET: value.JWT_SECRET,
      OTP_HMAC_SECRET: value.OTP_HMAC_SECRET,
      RATE_LIMIT_HMAC_SECRET: value.RATE_LIMIT_HMAC_SECRET,
      TELEGRAM_WEBHOOK_SECRET: value.TELEGRAM_WEBHOOK_SECRET,
      METRICS_TOKEN: value.METRICS_TOKEN,
    };
    const seen = new Map<string, string>();
    for (const [key, secret] of Object.entries(secrets)) {
      if (!secret) continue;
      if (secret.length < MIN_PRODUCTION_SECRET_LENGTH || isPlaceholderSecret(secret))
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `Production requires a random secret of at least ${MIN_PRODUCTION_SECRET_LENGTH} characters, not a placeholder or test value.`,
        });
      const other = seen.get(secret);
      if (other)
        ctx.addIssue({ code: 'custom', path: [key], message: `Must differ from ${other}.` });
      else seen.set(secret, key);
    }
  }
  const corsOrigins = value.CORS_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of corsOrigins) {
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ALLOWED_ORIGINS'],
        message: 'CORS_ALLOWED_ORIGINS contiene un origen inválido.',
      });
      continue;
    }
    if (origin !== parsedOrigin.origin) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ALLOWED_ORIGINS'],
        message: 'CORS_ALLOWED_ORIGINS solo admite orígenes, sin ruta.',
      });
    }
    if (origin.includes('*')) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ALLOWED_ORIGINS'],
        message: 'CORS_ALLOWED_ORIGINS no admite comodines.',
      });
    }
    if (value.NODE_ENV === 'production' && parsedOrigin.protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ALLOWED_ORIGINS'],
        message: 'Production requires HTTPS CORS origins.',
      });
    }
    if (
      value.NODE_ENV === 'development' &&
      parsedOrigin.hostname !== 'localhost' &&
      parsedOrigin.hostname !== '127.0.0.1'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ALLOWED_ORIGINS'],
        message: 'Development CORS origins must use localhost or 127.0.0.1.',
      });
    }
  }
});

export type AppEnvironment = z.infer<typeof envSchema> & {
  TELEGRAM_BOT_USERNAME: string;
  S3_REGION: string;
  S3_PUBLIC_ENDPOINT: string | undefined;
  allowedCountryCodes: readonly string[];
  supportedLocales: readonly string[];
  allowedCorsOrigins: readonly string[];
  telegramBotLink: string;
};

export const loadAppEnvironment = (cwd = process.cwd()): AppEnvironment => {
  const rootEnvPath = resolve(cwd, '../../.env');
  const fileEnvironment = existsSync(rootEnvPath)
    ? parseEnv(readFileSync(rootEnvPath, 'utf8'))
    : {};
  const parsed = parsedEnvironmentSchema.parse({ ...fileEnvironment, ...process.env });
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
  const allowedCorsOrigins = parsed.CORS_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    ...parsed,
    TELEGRAM_BOT_USERNAME: telegramBotUsername,
    allowedCountryCodes,
    supportedLocales,
    allowedCorsOrigins,
    telegramBotLink: `https://t.me/${telegramBotUsername}?start=link`,
    S3_PUBLIC_ENDPOINT: parsed.S3_PUBLIC_ENDPOINT ?? parsed.S3_ENDPOINT,
    S3_REGION: parsed.S3_REGION ?? 'us-east-1',
  };
};
