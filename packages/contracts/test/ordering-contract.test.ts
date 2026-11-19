import { describe, expect, it } from 'vitest';
import {
  createOrderSchema,
  orderCursorQuerySchema,
  orderPageResponseSchema,
} from '../src/schemas/ordering.js';

const id = '018f47a2-8b45-7cc2-9a1e-123456789abc';
const input = {
  id,
  lines: [{ lotId: id, quantityMilli: '1000' }],
  deliveryAddress: 'Calle sintética 1',
  deliveryWindow: null,
};

describe('ordering contracts', () => {
  it('accepts strict valid order input and refuses duplicate lot lines', () => {
    expect(createOrderSchema.safeParse(input).success).toBe(true);
    expect(
      createOrderSchema.safeParse({ ...input, lines: [...input.lines, ...input.lines] }).success,
    ).toBe(false);
    expect(createOrderSchema.safeParse({ ...input, extra: true }).success).toBe(false);
  });

  it('requires positive milli quantity and UUID v7 order IDs', () => {
    expect(
      createOrderSchema.safeParse({ ...input, lines: [{ lotId: id, quantityMilli: '0' }] }).success,
    ).toBe(false);
    expect(
      createOrderSchema.safeParse({ ...input, id: '018f47a2-8b45-4cc2-9a1e-123456789abc' }).success,
    ).toBe(false);
  });

  it('validates pagination and string-valued COP responses structurally', () => {
    expect(orderCursorQuerySchema.parse({ limit: '10' })).toEqual({ limit: 10 });
    expect(orderCursorQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(orderPageResponseSchema.safeParse({ items: [], nextCursor: 'opaque' }).success).toBe(
      true,
    );
    expect(orderPageResponseSchema.safeParse({ items: [{ subtotal: 10 }] }).success).toBe(false);
  });
});
