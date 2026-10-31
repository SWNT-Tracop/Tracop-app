import { z } from 'zod';

export const identityRoleSchema = z.enum([
  'producer',
  'supplier',
  'buyer',
  'carrier',
  'operator',
  'finance',
  'admin',
]);
export const devicePlatformSchema = z.enum(['ios', 'android', 'web', 'other']);

// Kept in sync with the domain rules (FULL_NAME_MIN/MAX_LENGTH); the API edge
// rejects before reaching the application so OpenAPI documents the bounds.
const controlCharacters = /[\p{Cc}\p{Cf}]/u;
const fullNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(160)
  .refine(
    (value) => !controlCharacters.test(value),
    'El nombre no puede contener caracteres de control.',
  );

export const registerUserSchema = z
  .object({
    phone: z.string().min(1).max(32),
    role: identityRoleSchema,
    fullName: fullNameSchema,
    locale: z.string().trim().min(2).max(20).optional(),
    deviceId: z.string().uuid(),
    platform: devicePlatformSchema,
    consent: z.object({ accepted: z.boolean(), version: z.string().min(1).max(80) }).strict(),
  })
  .strict();

export const requestOtpSchema = z.object({ phone: z.string().min(1).max(32) }).strict();

export const requestOtpResponseSchema = z
  .object({ message: z.string(), botLink: z.string().url() })
  .strict();

export type RequestOtpResponse = z.infer<typeof requestOtpResponseSchema>;

export const verifyOtpSchema = z
  .object({
    phone: z.string().min(1).max(32),
    code: z.string().regex(/^\d{4,10}$/),
    deviceId: z.string().uuid(),
    platform: devicePlatformSchema,
  })
  .strict();

export const refreshSessionSchema = z
  .object({
    refreshToken: z.string().min(32).max(256),
    deviceId: z.string().uuid(),
  })
  .strict();

export const updateMeSchema = z
  .object({
    fullName: fullNameSchema.optional(),
    locale: z.string().trim().min(2).max(20).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Incluye fullName o locale.');

export const upsertProviderProfileSchema = z
  .object({
    displayName: z.string().trim().min(2).max(100),
    municipality: z.string().trim().min(1).max(100),
    department: z.string().trim().min(1).max(100),
    lat: z.number().finite().min(-4.3).max(13.7),
    lng: z.number().finite().min(-81.8).max(-66.9),
    description: z.string().trim().max(1000),
  })
  .strict();
