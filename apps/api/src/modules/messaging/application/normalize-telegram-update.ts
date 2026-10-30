import type { TelegramUpdate } from '@tracop/contracts';
import type { InboundMessage } from '../domain/messaging.js';

export interface NormalizedTelegramUpdate {
  updateId: bigint;
  message: InboundMessage | null;
}

export const normalizeTelegramUpdate = (
  update: TelegramUpdate,
  now: Date,
): NormalizedTelegramUpdate => {
  const updateId = BigInt(update.update_id);
  const message = update.message;
  if (
    !message ||
    update.edited_message !== undefined ||
    update.channel_post !== undefined ||
    update.my_chat_member !== undefined ||
    update.callback_query !== undefined
  ) {
    return { updateId, message: null };
  }
  if (message.chat.type !== 'private' || !message.from) {
    return { updateId, message: null };
  }

  const channelUserId = String(message.from.id);
  const receivedAt = new Date(
    (message.date ?? Math.floor(now.getTime() / 1000)) * 1000,
  ).toISOString();
  const base = { channel: 'telegram' as const, channelUserId, receivedAt };

  if (message.contact) {
    return {
      updateId,
      message: {
        ...base,
        type: 'contact',
        contact:
          message.contact.user_id === undefined
            ? { phoneNumber: message.contact.phone_number }
            : {
                userId: String(message.contact.user_id),
                phoneNumber: message.contact.phone_number,
              },
      },
    };
  }
  if (message.text !== undefined) {
    return { updateId, message: { ...base, type: 'text', text: message.text } };
  }
  if (message.voice) {
    return {
      updateId,
      message: {
        ...base,
        type: 'voice',
        ...(message.voice.file_id ? { mediaRef: message.voice.file_id } : {}),
      },
    };
  }
  if (message.photo && message.photo.length > 0) {
    const fileId = message.photo.at(-1)?.file_id;
    return {
      updateId,
      message: {
        ...base,
        type: 'photo',
        ...(fileId ? { mediaRef: fileId } : {}),
      },
    };
  }
  if (message.location) {
    return {
      updateId,
      message: {
        ...base,
        type: 'location',
        location: { lat: message.location.latitude, lng: message.location.longitude },
      },
    };
  }
  return { updateId, message: null };
};
