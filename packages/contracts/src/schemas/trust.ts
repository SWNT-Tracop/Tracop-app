import { z } from 'zod';

const uuidV7Schema = z
  .string()
  .uuid()
  .refine((id) => id[14] === '7');
const ratingText = z.string().regex(/^[1-5]\.\d$/);

export const submitRatingSchema = z
  .object({
    id: uuidV7Schema,
    orderId: z.string().uuid(),
    ratee: z.enum(['provider', 'carrier']),
    score: z.number().int().min(1).max(5),
    comment: z.string().max(500).nullable().optional(),
  })
  .strict();

export const ratingResponseSchema = z
  .object({
    id: z.string().uuid(),
    ratee: z.enum(['provider', 'carrier']),
    score: z.number().int().min(1).max(5),
    comment: z.string().nullable(),
  })
  .strict();

export const myReputationResponseSchema = z
  .object({
    rating: ratingText.nullable(),
    ratingsCount: z.number().int().nonnegative(),
    comments: z.array(z.string()),
    verification: z.enum(['unverified', 'pending', 'verified', 'rejected', 'revoked']).nullable(),
  })
  .strict();

/** What buyers see about a provider: never its id or name. */
export const providerTrustSchema = z
  .object({
    verified: z.boolean(),
    rating: ratingText.nullable(),
    ratingsCount: z.number().int().nonnegative(),
  })
  .strict();

export const verificationRequestSchema = z
  .object({ note: z.string().trim().max(300).nullable().optional() })
  .strict();

export const approveVerificationSchema = z
  .object({
    checks: z
      .object({
        contact_confirmed: z.boolean(),
        location_confirmed: z.boolean(),
        reference_checked: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const verificationReasonSchema = z
  .object({ reason: z.string().trim().min(1).max(300) })
  .strict();

export const verificationQuerySchema = z
  .object({
    status: z.enum(['pending', 'verified', 'rejected', 'revoked']).default('pending'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const verificationResponseSchema = z
  .object({
    providerId: z.string().uuid(),
    status: z.enum(['unverified', 'pending', 'verified', 'rejected', 'revoked']),
    note: z.string().nullable(),
    checks: z.record(z.string(), z.boolean()).nullable(),
    reason: z.string().nullable(),
    requestedAt: z.string().datetime().nullable(),
    reviewedAt: z.string().datetime().nullable(),
  })
  .strict();
