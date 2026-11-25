import { describe, expect, it } from 'vitest';
import { telegramUpdateSchema } from '../src/schemas/messaging.js';

describe('messaging contracts', () => {
  it('accepts a private Telegram message and preserves unknown fields', () => {
    const parsed = telegramUpdateSchema.parse({
      update_id: 10,
      extra: 'ignored',
      message: {
        message_id: 1,
        date: 1_767_225_600,
        chat: { id: 900001, type: 'private', title: 'chat' },
        from: { id: 900001, is_bot: false },
        text: '/start',
      },
    });

    expect(parsed.update_id).toBe(10);
    expect(parsed.message?.text).toBe('/start');
  });

  it('accepts numeric string identifiers from Telegram', () => {
    expect(telegramUpdateSchema.parse({ update_id: '42' }).update_id).toBe('42');
  });

  it('rejects updates without an update id', () => {
    expect(() => telegramUpdateSchema.parse({ message: {} })).toThrow();
  });

  it('accepts button presses with at most 64 bytes of data', () => {
    const press = {
      update_id: 1,
      callback_query: {
        id: 'q1',
        from: { id: 900001 },
        message: { chat: { id: 900001, type: 'private' } },
        data: 'd:2s:3:confirm',
      },
    };
    expect(telegramUpdateSchema.safeParse(press).success).toBe(true);
    expect(
      telegramUpdateSchema.safeParse({
        ...press,
        callback_query: { ...press.callback_query, data: 'x'.repeat(65) },
      }).success,
    ).toBe(false);
    expect(telegramUpdateSchema.safeParse({ update_id: 2, callback_query: {} }).success).toBe(
      false,
    );
  });
});
