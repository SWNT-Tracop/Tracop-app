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

export const registerUserSchema = z
  .object({
    phone: z.string().min(1).max(32),
    role: identityRoleSchema,
    fullName: z.string().trim().min(1).max(160),
    locale: z.string().trim().min(2).max(20).optional(),
    deviceId: z.string().uuid(),
    platform: devicePlatformSchema,
    consent: z.object({ accepted: z.boolean(), version: z.string().min(1).max(80) }).strict(),
  })
  .strict();

export const requestOtpSchema = z.object({ phone: z.string().min(1).max(32) }).strict();

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
    fullName: z.string().trim().min(1).max(160).optional(),
    locale: z.string().trim().min(2).max(20).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Incluye fullName o locale.');
