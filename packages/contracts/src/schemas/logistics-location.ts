import { z } from 'zod';

const point = z
  // Same bounds as catalog lots (COLOMBIA_BOUNDS).
  .object({ lat: z.number().min(-4.3).max(13.7), lng: z.number().min(-81.8).max(-66.9) })
  .strict();

/** Exact location of one stop; only the assigned carrier and the staff receive it. */
export const stopLocationResponseSchema = z
  .object({
    stopId: z.string().uuid(),
    kind: z.enum(['pickup', 'delivery']),
    orderId: z.string().uuid(),
    points: z.array(point).max(20).optional(),
    address: z.string().optional(),
  })
  .strict();

export const locationPackResponseSchema = z
  .object({
    tripId: z.string().uuid(),
    expiresAt: z.string().datetime(),
    stops: z.array(stopLocationResponseSchema),
  })
  .strict();
