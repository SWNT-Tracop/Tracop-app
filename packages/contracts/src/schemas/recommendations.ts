import { z } from 'zod';
import { productUnitSchema } from './catalog.js';

const uuidV7 = z
  .string()
  .uuid()
  .refine((id) => id[14] === '7', 'El id debe ser UUID v7.');
/** COP as an integer string, as in ordering. */
const copString = z.string().regex(/^\d{1,15}$/);
const reasonSchema = z.enum(['reorder', 'nearby', 'good_price', 'verified_provider', 'fresh']);

export const priceSuggestionQuerySchema = z
  .object({ productId: z.string().uuid(), unit: productUnitSchema })
  .strict();

const sourceSchema = z
  .object({
    name: z.enum(['DANE-SIPSA', 'TRACOP']),
    count: z.number().int().min(1),
    observedAt: z.string().datetime(),
  })
  .strict();

/** A range (P25–P75) with its median and sources; never an individual price. */
export const priceSuggestionResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ok'),
      productId: z.string().uuid(),
      unit: productUnitSchema,
      low: copString,
      median: copString,
      high: copString,
      sources: z.array(sourceSchema).min(1),
      citation: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal('insufficient_data'),
      productId: z.string().uuid(),
      unit: productUnitSchema,
    })
    .strict(),
]);

const latitude = z.coerce.number().min(-90).max(90);
const longitude = z.coerce.number().min(-180).max(180);

export const recommendationsQuerySchema = z
  .object({
    lat: latitude.optional(),
    lng: longitude.optional(),
    radiusKm: z.coerce.number().int().min(1).max(300).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict()
  .refine((query) => (query.lat === undefined) === (query.lng === undefined), {
    message: 'lat y lng se envían juntos.',
  })
  .refine((query) => query.radiusKm === undefined || query.lat !== undefined, {
    message: 'radiusKm requiere lat y lng.',
  });

export const recommendedLotSchema = z
  .object({
    lotId: z.string().uuid(),
    productId: z.string().uuid(),
    unit: productUnitSchema,
    unitPrice: copString,
    distanceKm: z.number().int().min(1).nullable(),
    score: z.number().int().min(0),
    reasons: z.array(reasonSchema).min(1),
  })
  .strict();

export const recommendationsResponseSchema = z
  .object({ items: z.array(recommendedLotSchema), nextCursor: z.string().nullable() })
  .strict();

export const createAlertSchema = z
  .object({
    id: uuidV7,
    productId: z.string().uuid(),
    maxPrice: z.number().int().positive().safe(),
    radiusKm: z.number().int().min(1).max(300),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  })
  .strict();

/** The centre comes back rounded to 2 decimals: the server never keeps the exact point. */
export const alertResponseSchema = z
  .object({
    id: z.string().uuid(),
    productId: z.string().uuid(),
    maxPrice: copString,
    radiusKm: z.number().int(),
    centerLat: z.number(),
    centerLng: z.number(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const createMappingSchema = z
  .object({
    id: uuidV7,
    productId: z.string().uuid(),
    sourceProduct: z.string().trim().min(1).max(120),
    presentation: z.string().trim().min(1).max(120),
  })
  .strict();

export const mappingResponseSchema = z
  .object({
    id: z.string().uuid(),
    productId: z.string().uuid(),
    unit: productUnitSchema,
    source: z.literal('DANE-SIPSA'),
    sourceProduct: z.string(),
    presentation: z.string(),
    createdAt: z.string().datetime(),
  })
  .strict();
