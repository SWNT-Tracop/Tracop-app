import { z } from 'zod';

const uuidV7Schema = z
  .string()
  .uuid()
  .refine((id) => id[14] === '7');
const unsignedIntegerString = z.string().regex(/^(0|[1-9]\d{0,18})$/);
const expectedVersion = z.number().int().positive();
const reason = z.string().trim().min(1).max(500);

export const paymentMethodSchema = z.enum(['transfer', 'nequi']);
export const paymentStatusSchema = z.enum([
  'pending',
  'proof_uploaded',
  'verified',
  'held',
  'settled',
  'rejected',
  'disputed',
  'refunded',
]);

export const initiatePaymentSchema = z
  .object({ id: uuidV7Schema, method: paymentMethodSchema })
  .strict();

export const paymentVersionSchema = z.object({ expectedVersion }).strict();

export const rejectPaymentSchema = z.object({ expectedVersion, reason }).strict();

export const disputePaymentSchema = z.object({ expectedVersion, reason }).strict();

export const resolveDisputeSchema = z
  .object({ expectedVersion, outcome: z.enum(['release', 'refund']), note: reason })
  .strict();

export const paymentReviewQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();

export const paymentResponseSchema = z
  .object({
    id: z.string().uuid(),
    orderId: z.string().uuid(),
    method: paymentMethodSchema,
    status: paymentStatusSchema,
    version: z.number().int().positive(),
    subtotal: unsignedIntegerString,
    freight: unsignedIntegerString,
    commission: unsignedIntegerString,
    total: unsignedIntegerString,
    providerNet: unsignedIntegerString,
    proofUploadedAt: z.string().datetime().nullable(),
    proofUrl: z.string().url().nullable(),
    reviewedAt: z.string().datetime().nullable(),
    rejectionReason: z.string().nullable(),
    heldAt: z.string().datetime().nullable(),
    disputeReason: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const paymentListResponseSchema = z
  .object({ items: z.array(paymentResponseSchema) })
  .strict();

export const proofUploadResponseSchema = z
  .object({
    uploadPolicy: z
      .object({
        url: z.string().url(),
        fields: z.record(z.string(), z.string()),
        expiresAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict();

export const settlementStatusSchema = z.enum(['issued', 'paid']);

export const settlementQuerySchema = z
  .object({
    status: settlementStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const markSettlementPaidSchema = z
  .object({ expectedVersion, reference: z.string().trim().max(100).nullable().optional() })
  .strict();

export const settlementResponseSchema = z
  .object({
    id: z.string().uuid(),
    paymentId: z.string().uuid(),
    orderId: z.string().uuid(),
    beneficiaryId: z.string().uuid(),
    beneficiaryKind: z.enum(['producer', 'carrier']),
    amount: unsignedIntegerString,
    status: settlementStatusSchema,
    issuedAt: z.string().datetime(),
    paidAt: z.string().datetime().nullable(),
    reference: z.string().nullable(),
    version: z.number().int().positive(),
  })
  .strict();

export const settlementListResponseSchema = z
  .object({ items: z.array(settlementResponseSchema) })
  .strict();

export const ledgerEntryResponseSchema = z
  .object({
    transactionId: z.string().uuid(),
    kind: z.enum([
      'payment_verified',
      'delivery_confirmed',
      'settlement_paid_producer',
      'settlement_paid_carrier',
      'refund',
    ]),
    account: z.string(),
    debit: unsignedIntegerString,
    credit: unsignedIntegerString,
    createdAt: z.string().datetime(),
  })
  .strict();

export const ledgerResponseSchema = z
  .object({ items: z.array(ledgerEntryResponseSchema) })
  .strict();

export type PaymentResponse = z.infer<typeof paymentResponseSchema>;
export type SettlementResponse = z.infer<typeof settlementResponseSchema>;
