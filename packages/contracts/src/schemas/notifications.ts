import { z } from 'zod';

export const deliveryChannelSchema = z.enum(['messaging', 'push', 'sms']);
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const notificationPreferencesSchema = z
  .object({
    channelOrder: z.array(deliveryChannelSchema).min(1).max(3),
    quietHours: z.object({ start: localTime, end: localTime }).strict().nullable(),
  })
  .strict()
  .refine(({ channelOrder }) => new Set(channelOrder).size === channelOrder.length, {
    message: 'Cada canal puede aparecer una sola vez.',
    path: ['channelOrder'],
  });

export const notificationKindSchema = z.enum([
  'order_received',
  'payment_verified_buyer',
  'payment_verified_provider',
  'payment_rejected',
  'pickup_scheduled',
  'in_transit',
  'delivered',
  'settlement_issued',
  'settlement_paid',
  'incident_opened',
]);

export const inboxQuerySchema = z
  .object({
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const inboxEntryResponseSchema = z
  .object({
    id: z.string().uuid(),
    kind: notificationKindSchema,
    title: z.string(),
    body: z.string(),
    createdAt: z.string().datetime(),
    readAt: z.string().datetime().nullable(),
  })
  .strict();

export const inboxPageResponseSchema = z
  .object({ items: z.array(inboxEntryResponseSchema), nextCursor: z.string().optional() })
  .strict();

export type NotificationPreferencesInput = z.infer<typeof notificationPreferencesSchema>;
