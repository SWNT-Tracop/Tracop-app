import { z } from 'zod';

const uuidV7Schema = z
  .string()
  .uuid()
  .refine((id) => id[14] === '7', 'El id debe ser UUID v7.');

export const syncOperationSchema = z
  .object({
    opId: uuidV7Schema,
    entity: z.string().trim().min(1).max(64),
    entityId: z.string().uuid(),
    type: z.enum(['create', 'update', 'transition', 'delete']),
    payload: z.record(z.string(), z.unknown()),
    baseVersion: z.number().int().positive().optional(),
  })
  .strict();

export const syncPushSchema = z
  .object({ operations: z.array(syncOperationSchema).min(1).max(50) })
  .strict();

export const syncPullQuerySchema = z
  .object({
    cursor: z
      .string()
      .regex(/^(0|[1-9]\d{0,18})$/)
      .default('0'),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();

export const syncOperationStatusSchema = z.enum(['applied', 'rejected', 'conflict']);
export const syncOperationCodeSchema = z.enum([
  'invalid_payload',
  'unknown_entity',
  'not_found',
  'forbidden',
  'version_conflict',
  'invalid_transition',
  'unsupported_transition',
  'dependency_failed',
  'op_id_reused',
]);

export const syncOperationResultSchema = z
  .object({
    opId: uuidV7Schema,
    status: syncOperationStatusSchema,
    code: syncOperationCodeSchema.optional(),
    serverVersion: z.number().int().positive().optional(),
    serverSeq: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
  })
  .strict();

export const syncPushResponseSchema = z.object({
  results: z.array(syncOperationResultSchema),
});

export const syncChangeSchema = z.object({
  serverSeq: z.string().regex(/^[1-9]\d*$/),
  entity: z.string(),
  entityId: z.string().uuid(),
  op: z.string(),
  payload: z.record(z.string(), z.unknown()),
  occurredAt: z.string().datetime(),
});

export const syncPullResponseSchema = z.object({
  changes: z.array(syncChangeSchema),
  nextCursor: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  hasMore: z.boolean(),
});

export type SyncOperationContract = z.infer<typeof syncOperationSchema>;
