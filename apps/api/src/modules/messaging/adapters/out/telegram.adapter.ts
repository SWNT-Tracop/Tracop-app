import { Bot, GrammyError, HttpError } from 'grammy';
import type { InlineKeyboardMarkup, ReplyKeyboardMarkup } from 'grammy/types';
import { failure, success, type Result } from '../../../../shared/kernel/result.js';
import type { ChannelUserRef, MessagingError, OutboundButton } from '../../domain/messaging.js';
import type { MessagingPort } from '../../ports/messaging-ports.js';

export interface TelegramAdapterOptions {
  token: string;
  apiRoot?: string;
}

export class TelegramAdapter implements MessagingPort {
  private readonly bot: Bot;

  constructor(options: TelegramAdapterOptions) {
    this.bot = new Bot(options.token, {
      client: { apiRoot: options.apiRoot ?? 'https://api.telegram.org' },
    });
  }

  async sendText(to: ChannelUserRef, text: string): Promise<Result<void, MessagingError>> {
    return this.send(to, text, undefined);
  }

  async sendButtons(
    to: ChannelUserRef,
    text: string,
    buttons: readonly OutboundButton[],
  ): Promise<Result<void, MessagingError>> {
    const wantsContact = buttons.some((button) => button.kind === 'request_contact');
    const replyMarkup: ReplyKeyboardMarkup | InlineKeyboardMarkup = wantsContact
      ? {
          keyboard: buttons.map((button) => [
            button.kind === 'request_contact'
              ? { text: button.text, request_contact: true }
              : { text: button.text },
          ]),
          resize_keyboard: true,
          one_time_keyboard: true,
        }
      : {
          inline_keyboard: buttons.map((button) => [
            {
              text: button.text,
              callback_data: callbackData(button),
            },
          ]),
        };
    return this.send(to, text, replyMarkup);
  }

  async acknowledgeAction(callbackId: string): Promise<void> {
    try {
      await this.bot.api.answerCallbackQuery(callbackId);
    } catch {
      // Best effort: the button only keeps spinning a little longer.
    }
  }

  private async send(
    to: ChannelUserRef,
    text: string,
    replyMarkup: ReplyKeyboardMarkup | InlineKeyboardMarkup | undefined,
  ): Promise<Result<void, MessagingError>> {
    if (to.channel !== 'telegram') return failure({ kind: 'invalid_recipient' });
    try {
      await this.bot.api.sendMessage(
        to.channelUserId,
        text,
        replyMarkup === undefined ? {} : { reply_markup: replyMarkup },
      );
      return success(undefined);
    } catch (error) {
      return failure(mapTelegramError(error));
    }
  }
}

const CALLBACK_DATA_MAX_BYTES = 64;

/** The action itself when it has no payload; Telegram refuses callback_data over 64 bytes. */
const callbackData = (button: OutboundButton): string => {
  const data =
    button.kind !== 'action'
      ? button.text
      : button.payload && Object.keys(button.payload).length > 0
        ? JSON.stringify({ action: button.action, payload: button.payload })
        : button.action;
  if (Buffer.byteLength(data, 'utf8') > CALLBACK_DATA_MAX_BYTES)
    throw new Error('callback_data exceeds 64 bytes.');
  return data;
};

const mapTelegramError = (error: unknown): MessagingError => {
  if (error instanceof GrammyError) {
    if (error.error_code === 403) return { kind: 'blocked_by_user' };
    if (error.error_code === 429) {
      return { kind: 'rate_limited', retryAfterSeconds: error.parameters.retry_after ?? 1 };
    }
    if (error.error_code === 400) return { kind: 'invalid_recipient' };
    return { kind: 'unavailable', retryable: error.error_code >= 500 };
  }
  if (error instanceof HttpError) return { kind: 'unavailable', retryable: true };
  return { kind: 'unavailable', retryable: true };
};
