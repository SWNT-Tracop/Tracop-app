import { z } from 'zod';

const uuidV7Schema = z
  .string()
  .uuid()
  .refine((id) => id[14] === '7');

export const carrierProfileSchema = z
  .object({
    vehicleType: z.string().trim().min(2).max(40),
    capacityKg: z.number().int().min(1).max(100_000),
    plate: z
      .string()
      .trim()
      .min(3)
      .max(12)
      .regex(/^[A-Za-z0-9-]+$/),
  })
  .strict();

export const createTripSchema = z
  .object({
    id: uuidV7Schema,
    orderIds: z.array(z.string().uuid()).min(1).max(20),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (new Set(input.orderIds).size !== input.orderIds.length)
      ctx.addIssue({ code: 'custom', path: ['orderIds'], message: 'Pedidos duplicados.' });
  });

export const recommendTripsQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
  .strict();

export const logisticsOrderCandidateSchema = z
  .object({
    orderId: z.string().uuid(),
    status: z.literal('paid'),
    version: z.number().int().positive(),
    deliveryZone: z.string().min(1).max(200),
    deliveryWindow: z.string().datetime().nullable(),
    pickupZones: z.array(z.string().min(1).max(200)),
    lines: z.array(
      z
        .object({
          lotId: z.string().uuid(),
          quantityMilli: z.string().regex(/^\d+$/),
          unit: z.string().min(1).max(40),
        })
        .strict(),
    ),
  })
  .strict();

export const logisticsOrderCandidatesResponseSchema = z.array(logisticsOrderCandidateSchema);

export const tripTransitionSchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();

export const reassignTripSchema = tripTransitionSchema.extend({
  carrierId: z.string().uuid(),
});

export const cancelTripSchema = tripTransitionSchema.extend({
  reason: z.string().trim().min(1).max(200),
});

export const checkinKindSchema = z.enum(['pickup', 'delivery']);

export const createCheckinSchema = z
  .object({
    id: uuidV7Schema,
    stopId: z.string().uuid(),
    kind: checkinKindSchema,
    clientAt: z.string().datetime(),
    mediaRef: z.string().min(1).max(512).optional(),
    baseVersion: z.number().int().positive().optional(),
  })
  .strict();

export const checkinSyncPayloadSchema = z
  .object({
    stopId: z.string().uuid(),
    kind: checkinKindSchema,
    clientAt: z.string().datetime(),
    mediaRef: z.string().min(1).max(512).optional(),
  })
  .strict();

export const openIncidentSchema = z
  .object({
    id: uuidV7Schema,
    orderId: z.string().uuid(),
    tripId: z.string().uuid().optional(),
    type: z.string().trim().min(1).max(60),
    description: z.string().trim().min(1).max(1000),
  })
  .strict();

export const logisticsLimitQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
  .strict();

export const tripStatusSchema = z.enum([
  'planned',
  'assigned',
  'in_progress',
  'completed',
  'cancelled',
]);

export const recommendedStopSchema = z
  .object({
    orderId: z.string().uuid(),
    kind: checkinKindSchema,
    sequence: z.number().int().positive(),
    zone: z.string().min(1),
  })
  .strict();
