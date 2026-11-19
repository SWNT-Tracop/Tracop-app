import { telegramUpdateSchema } from '@tracop/contracts';
import { normalizeTelegramUpdate } from '../src/modules/messaging/application/normalize-telegram-update.js';

const now = new Date('2026-01-01T00:00:00.000Z');

const privateMessage = (overrides: Record<string, unknown> = {}) => ({
  update_id: 100,
  message: {
    message_id: 1,
    date: 1_767_225_600,
    chat: { id: 900001, type: 'private' },
    from: { id: 900001, is_bot: false },
    ...overrides,
  },
});

const normalize = (raw: unknown) => normalizeTelegramUpdate(telegramUpdateSchema.parse(raw), now);

describe('Telegram update normalization', () => {
  it('normalizes private text messages with the Telegram timestamp', () => {
    expect(normalize(privateMessage({ text: '/start' }))).toEqual({
      updateId: 100n,
      message: {
        channel: 'telegram',
        channelUserId: '900001',
        type: 'text',
        text: '/start',
        receivedAt: '2026-01-01T00:00:00.000Z',
      },
    });
  });

  it.each([
    [
      'group chat',
      { update_id: 1, message: { ...privateMessage().message, chat: { id: 1, type: 'group' } } },
    ],
    ['edited message', { ...privateMessage({ text: 'hola' }), edited_message: {} }],
    ['channel post', { ...privateMessage({ text: 'hola' }), channel_post: {} }],
    ['chat member update', { ...privateMessage({ text: 'hola' }), my_chat_member: {} }],
    ['callback query', { ...privateMessage({ text: 'hola' }), callback_query: {} }],
    [
      'message without sender',
      { update_id: 2, message: { ...privateMessage().message, from: undefined } },
    ],
    ['update without message', { update_id: 3 }],
  ])('ignores %s', (_name, raw) => {
    expect(normalize(raw).message).toBeNull();
  });

  it('normalizes shared contacts', () => {
    expect(
      normalize(privateMessage({ contact: { phone_number: '+573001234567', user_id: 900001 } })),
    ).toMatchObject({
      message: {
        type: 'contact',
        contact: { userId: '900001', phoneNumber: '+573001234567' },
      },
    });
    expect(
      normalize(privateMessage({ contact: { phone_number: '+573001234567' } })).message?.contact,
    ).toEqual({ phoneNumber: '+573001234567' });
  });

  it('normalizes voice, photo and location payloads', () => {
    expect(normalize(privateMessage({ voice: { file_id: 'voice-1' } })).message).toMatchObject({
      type: 'voice',
      mediaRef: 'voice-1',
    });
    expect(normalize(privateMessage({ voice: {} })).message).not.toHaveProperty('mediaRef');
    expect(
      normalize(privateMessage({ photo: [{ file_id: 'small' }, { file_id: 'large' }] })).message,
    ).toMatchObject({ type: 'photo', mediaRef: 'large' });
    expect(
      normalize(privateMessage({ location: { latitude: 4.6, longitude: -74.1 } })).message,
    ).toMatchObject({ type: 'location', location: { lat: 4.6, lng: -74.1 } });
  });

  it('ignores unsupported message content', () => {
    expect(normalize(privateMessage({ sticker: { file_id: 'x' } }))).toEqual({
      updateId: 100n,
      message: null,
    });
  });

  it('falls back to the injected clock when Telegram omits the date', () => {
    const raw = privateMessage({ text: 'hola' });
    delete (raw.message as { date?: number }).date;
    expect(normalize(raw).message?.receivedAt).toBe(now.toISOString());
  });

  it('accepts numeric strings for update ids', () => {
    expect(normalize({ update_id: '42', message: privateMessage().message }).updateId).toBe(42n);
  });
});
