import { z } from 'zod';

export const productUnitSchema = z.enum([
  'kg',
  'g',
  'lb',
  'und',
  'docena',
  'arroba',
  'quintal',
  'caja',
  'mano',
  'bulto',
]);
export const productAttributesSchema = z
  .record(
    z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/),
    z.union([z.string().max(120), z.number().finite(), z.boolean()]),
  )
  .superRefine((value, context) => {
    if (Object.keys(value).length > 20)
      context.addIssue({ code: 'custom', message: 'Máximo 20 atributos.' });
    if (JSON.stringify(value).length > 2048)
      context.addIssue({ code: 'custom', message: 'Atributos superan 2 KB.' });
  });

export const createCategorySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    parentId: z.string().uuid().nullable(),
  })
  .strict();
export const createProductSchema = z
  .object({
    id: z.string().uuid(),
    categoryId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    unit: productUnitSchema,
    attributes: productAttributesSchema,
  })
  .strict();

export const createLotSchema = z
  .object({
    id: z
      .string()
      .uuid()
      .refine((id) => id[14] === '7', 'El id debe ser UUID v7.'),
    productId: z.string().uuid(),
    quantityMilli: z.string().regex(/^[1-9]\d{0,11}$/),
    unit: productUnitSchema,
    unitPrice: z.number().int().positive().safe(),
    qualityGrade: z.string().max(100).nullable(),
    availableFrom: z.string().datetime({ offset: true }),
    availableUntil: z.string().datetime({ offset: true }),
    locationLat: z.number().finite().min(-90).max(90),
    locationLng: z.number().finite().min(-180).max(180),
  })
  .strict();

export const lotCursorPayloadSchema = z
  .object({
    version: z.literal(1),
    sort: z.enum(['price', 'distance', 'availability', 'recent']),
    key: z.string().min(1).max(100),
    id: z.string().uuid(),
  })
  .strict();

export const searchLotsQuerySchema = z
  .object({
    cursor: z.string().max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    categoryId: z.string().uuid().optional(),
    productId: z.string().uuid().optional(),
    q: z.string().trim().max(120).optional(),
    minPrice: z.coerce.number().int().nonnegative().optional(),
    maxPrice: z.coerce.number().int().positive().optional(),
    availableFrom: z.string().datetime({ offset: true }).optional(),
    availableUntil: z.string().datetime({ offset: true }).optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radiusKm: z.coerce.number().positive().max(500).optional(),
    sort: z.enum(['price', 'distance', 'availability', 'recent']).default('recent'),
  })
  .strict()
  .superRefine((value, context) => {
    const locationFields = [value.lat, value.lng, value.radiusKm];
    if (
      locationFields.some((field) => field !== undefined) &&
      locationFields.some((field) => field === undefined)
    ) {
      context.addIssue({ code: 'custom', message: 'lat, lng y radiusKm deben enviarse juntos.' });
    }
    if (value.sort === 'distance' && value.lat === undefined) {
      context.addIssue({ code: 'custom', message: 'El orden por distancia requiere ubicación.' });
    }
    if (
      value.minPrice !== undefined &&
      value.maxPrice !== undefined &&
      value.minPrice > value.maxPrice
    ) {
      context.addIssue({ code: 'custom', message: 'El rango de precio es inválido.' });
    }
    if (value.availableFrom && value.availableUntil && value.availableFrom > value.availableUntil) {
      context.addIssue({ code: 'custom', message: 'El rango de disponibilidad es inválido.' });
    }
  });
