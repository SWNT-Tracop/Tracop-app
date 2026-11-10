import { z } from 'zod';

const uuidV7Schema = z
  .string()
  .uuid()
  .refine((id) => id[14] === '7');
const unsignedIntegerString = z.string().regex(/^(0|[1-9]\d{0,18})$/);

export const createOrderSchema = z
  .object({
    id: uuidV7Schema,
    lines: z
      .array(z.object({ lotId: z.string().uuid(), quantityMilli: unsignedIntegerString }).strict())
      .min(1)
      .max(20),
    deliveryAddress: z.string().trim().min(1).max(500),
    deliveryWindow: z.string().datetime().nullable().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const lotIds = input.lines.map(({ lotId }) => lotId);
    if (new Set(lotIds).size !== lotIds.length)
      ctx.addIssue({
        code: 'custom',
        path: ['lines'],
        message: 'Cada lote puede aparecer una sola vez.',
      });
    if (input.lines.some(({ quantityMilli }) => BigInt(quantityMilli) <= 0n))
      ctx.addIssue({ code: 'custom', path: ['lines'], message: 'La cantidad debe ser positiva.' });
  });

export const orderCursorQuerySchema = z
  .object({
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const orderStatusSchema = z.enum([
  'draft',
  'requested',
  'quoted',
  'accepted',
  'payment_pending',
  'paid',
  'pickup_scheduled',
  'in_transit',
  'delivered',
  'closed',
  'disputed',
  'cancelled',
]);

export const orderResponseSchema = z
  .object({
    id: z.string().uuid(),
    status: orderStatusSchema,
    providerId: z.string().uuid().optional(),
    lines: z.array(
      z
        .object({
          lotId: z.string().uuid(),
          quantityMilli: unsignedIntegerString,
          unit: z.string(),
          unitPrice: unsignedIntegerString,
        })
        .strict(),
    ),
    subtotal: unsignedIntegerString,
    freight: unsignedIntegerString,
    commission: unsignedIntegerString,
    total: unsignedIntegerString,
    providerNet: unsignedIntegerString,
    deliveryAddress: z.string().optional(),
    deliveryWindow: z.string().datetime().nullable().optional(),
    acceptedAt: z.string().datetime().nullable(),
    cancelReason: z.string().nullable(),
    quoteValidUntil: z.string().datetime(),
  })
  .strict();

export const orderPageResponseSchema = z
  .object({
    items: z.array(orderResponseSchema),
    nextCursor: z.string().optional(),
  })
  .strict();
