import { describe, expect, it } from 'vitest';
import {
  inboxEntryResponseSchema,
  inboxQuerySchema,
  notificationPreferencesSchema,
} from '../src/schemas/notifications.js';

describe('notifications contracts', () => {
  it('accepts a channel order without repeats and optional quiet hours', () => {
    expect(
      notificationPreferencesSchema.safeParse({
        channelOrder: ['push', 'messaging'],
        quietHours: { start: '22:00', end: '06:00' },
      }).success,
    ).toBe(true);
    expect(
      notificationPreferencesSchema.safeParse({ channelOrder: ['messaging'], quietHours: null })
        .success,
    ).toBe(true);
  });

  it.each([
    { channelOrder: [], quietHours: null },
    { channelOrder: ['sms', 'sms'], quietHours: null },
    { channelOrder: ['email'], quietHours: null },
    { channelOrder: ['sms'], quietHours: { start: '24:00', end: '06:00' } },
    { channelOrder: ['sms'] },
  ])('refuses %j', (input) => {
    expect(notificationPreferencesSchema.safeParse(input).success).toBe(false);
  });

  it('describes inbox entries strictly and bounds the page size', () => {
    const entry = {
      id: '018f47a2-8b45-7cc2-9a1e-123456789abc',
      kind: 'delivered',
      title: 'Pedido entregado',
      body: 'Registramos la entrega del pedido #018F47A2.',
      createdAt: '2026-11-24T15:00:00.000Z',
      readAt: null,
    };
    expect(inboxEntryResponseSchema.safeParse(entry).success).toBe(true);
    expect(inboxEntryResponseSchema.safeParse({ ...entry, userId: entry.id }).success).toBe(false);
    expect(inboxQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(inboxQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});
