import { describe, expect, it } from 'vitest';
import { exampleContractSchema } from '../src/schemas/example-contract.js';

describe('exampleContractSchema', () => {
  it('accepts UUID identifiers', () => {
    expect(exampleContractSchema.safeParse({ id: '018f47a2-8b45-7cc2-9a1e-123456789abc' }).success).toBe(true);
  });
});
