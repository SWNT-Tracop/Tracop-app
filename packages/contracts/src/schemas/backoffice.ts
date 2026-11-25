import { z } from 'zod';

const integerString = z.string().regex(/^-?(0|[1-9]\d{0,18})$/);

export const parameterKeySchema = z.enum([
  'order.commission_rate_bps',
  'order.freight_cop',
  'order.quote_ttl_hours',
  'order.reservation_ttl_hours',
  'payment.claim_window_hours',
  'payment.rejection_grace_hours',
  'catalog.product_proposal_pending_limit',
  'trust.rating_window_days',
  'trust.min_ratings_visible',
  'trust.comment_max_length',
  'trust.verification_cooldown_days',
]);

export const parameterResponseSchema = z
  .object({
    key: parameterKeySchema,
    unit: z.enum(['bps', 'cop', 'hours', 'days', 'count', 'characters']),
    value: integerString,
    defaultValue: integerString,
    min: integerString,
    max: integerString,
    provisional: z.boolean(),
    description: z.string(),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();

export const parameterListResponseSchema = z
  .object({ items: z.array(parameterResponseSchema) })
  .strict();

export const updateParameterSchema = z.object({ value: integerString }).strict();

export const auditQuerySchema = z
  .object({
    entity: z.string().min(1).max(64).optional(),
    entityId: z.string().min(1).max(128).optional(),
    actorId: z.string().uuid().optional(),
    action: z.string().min(1).max(64).optional(),
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const auditEntryResponseSchema = z
  .object({
    id: z.string().uuid(),
    actorId: z.string().uuid().nullable(),
    actorRole: z.string(),
    action: z.string(),
    entity: z.string(),
    entityId: z.string(),
    before: z.record(z.string(), z.unknown()).nullable(),
    after: z.record(z.string(), z.unknown()).nullable(),
    at: z.string().datetime(),
  })
  .strict();

export const auditPageResponseSchema = z
  .object({ items: z.array(auditEntryResponseSchema), nextCursor: z.string().optional() })
  .strict();

const counts = z.record(z.string(), z.number().int().nonnegative());
const amountCount = z
  .object({ count: z.number().int().nonnegative(), amountCop: integerString })
  .strict();

export const metricsResponseSchema = z
  .object({
    generatedAt: z.string().datetime(),
    ordersByStatus: counts,
    paidOrdersTotalCop: integerString,
    lotsByStatus: counts,
    payments: z
      .object({
        proofsAwaitingReview: z.number().int().nonnegative(),
        oldestProofUploadedAt: z.string().datetime().nullable(),
        openDisputes: z.number().int().nonnegative(),
        settlementsIssued: amountCount,
        settlementsPaid: amountCount,
      })
      .strict(),
    notificationDeliveries: counts,
    outbox: z
      .object({
        pending: z.number().int().nonnegative(),
        deadLettered: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
