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
              callback_data:
                button.kind === 'action'
                  ? JSON.stringify({ action: button.action, payload: button.payload ?? {} })
                  : button.text,
            },
          ]),
        };
    return this.send(to, text, replyMarkup);
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
