import { describe, expect, it } from 'vitest';
import {
  registerUserSchema,
  updateMeSchema,
  upsertProviderProfileSchema,
} from '../src/schemas/identity.js';

describe('identity contracts', () => {
  it('requires accepted consent and a consent version when registering', () => {
    const valid = {
      phone: '3001234567',
      role: 'buyer',
      fullName: 'Comprador',
      deviceId: '018f47a2-8b45-7cc2-9a1e-123456789abc',
      platform: 'web',
      consent: { accepted: true, version: 'v0-draft' },
    };
    expect(registerUserSchema.safeParse(valid).success).toBe(true);
    expect(
      registerUserSchema.safeParse({ ...valid, consent: { accepted: false, version: 'v0-draft' } })
        .success,
    ).toBe(true);
  });

  it('does not allow protected identity fields in profile updates', () => {
    expect(updateMeSchema.safeParse({ fullName: 'Nombre Nuevo' }).success).toBe(true);
    expect(updateMeSchema.safeParse({ role: 'admin' }).success).toBe(false);
  });

  it('validates provider profile coordinates and rejects unknown fields', () => {
    const input = {
      displayName: 'Finca',
      municipality: 'Tunja',
      department: 'Boyacá',
      lat: 5.5,
      lng: -73.4,
      description: '',
    };
    expect(upsertProviderProfileSchema.safeParse(input).success).toBe(true);
    expect(upsertProviderProfileSchema.safeParse({ ...input, lat: 91 }).success).toBe(false);
    expect(upsertProviderProfileSchema.safeParse({ ...input, phone: '3001234567' }).success).toBe(
      false,
    );
  });
});
