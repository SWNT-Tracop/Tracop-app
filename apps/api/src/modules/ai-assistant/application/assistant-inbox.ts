import type pino from 'pino';
import type { Clock } from '../../../shared/kernel/clock.js';
import { createId } from '../../../shared/kernel/ids.js';
import { MAX_USER_TEXT } from '../prompts/lot-draft.v1.js';
import type {
  DraftRepository,
  InboxPayload,
  InboxRepository,
  UsageRepository,
} from '../ports/assistant-ports.js';
import type { LotDraftAssistant } from './lot-draft-assistant.js';

/** What messaging hands over: only what the assistant needs, normalized. */
export interface AssistantInboundMessage {
  readonly channel: string;
  readonly channelUserId: string;
  readonly receivedAt: Date;
  readonly payload: InboxPayload;
}

/** Public use case for messaging: queue a chat message in the caller's transaction. */
export class AssistantInbox {
  constructor(
    private readonly inbox: InboxRepository,
    private readonly clock: Clock,
  ) {}

  async accept(message: AssistantInboundMessage): Promise<void> {
    const payload: InboxPayload =
      message.payload.type === 'text'
        ? { type: 'text', text: message.payload.text.slice(0, MAX_USER_TEXT) }
        : message.payload;
    await this.inbox.enqueue({
      id: createId(),
      channel: message.channel,
      channelUserId: message.channelUserId,
      payload,
      receivedAt: message.receivedAt,
      // The worker leases by the assistant's clock, not by the channel's timestamp: a message
      // stamped ahead of that clock would otherwise wait in the inbox until the clock caught up.
      availableAt: this.clock.now(),
    });
  }
}

export interface InboxProcessorSettings {
  readonly leaseSeconds: number;
  readonly maxAttempts: number;
  readonly batchSize: number;
}

/**
 * Drains the inbox for the worker: one message per chat at a time, in order. A handled message
 * is deleted (with its text); a failure is released for a later attempt and dropped after the
 * attempt limit. Nothing of the message is logged.
 */
export class InboxProcessor {
  constructor(
    private readonly inbox: InboxRepository,
    private readonly assistant: LotDraftAssistant,
    private readonly settings: InboxProcessorSettings,
    private readonly clock: Clock,
    private readonly logger: pino.Logger,
  ) {}

  async drain(): Promise<{ handled: number; failed: number; dropped: number }> {
    let handled = 0;
    let failed = 0;
    for (let index = 0; index < this.settings.batchSize; index += 1) {
      const item = await this.inbox.leaseNext(this.clock.now(), this.settings.leaseSeconds);
      if (!item) break;
      try {
        await this.assistant.handle(item);
        await this.inbox.complete(item.id, item.leaseToken);
        handled += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn(
          {
            event: 'assistant_message_failed',
            attempts: item.attempts,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          },
          'Assistant message failed.',
        );
        await this.inbox.release(item.id, item.leaseToken, this.clock.now());
      }
    }
    const dropped = await this.inbox.deleteExhausted(this.settings.maxAttempts);
    return { handled, failed, dropped };
  }
}

export interface AssistantRetentionSettings {
  readonly finishedDraftRetentionDays: number;
  readonly usageRetentionDays: number;
  readonly batchSize: number;
}

const DAY_MS = 86_400_000;

/** Expires drafts past their time, purges finished drafts and old usage rows. */
export class AssistantMaintenance {
  constructor(
    private readonly drafts: DraftRepository,
    private readonly usage: UsageRepository,
    private readonly settings: AssistantRetentionSettings,
    private readonly clock: Clock,
  ) {}

  async run(): Promise<{ expired: number; purgedDrafts: number; purgedUsage: number }> {
    const now = this.clock.now();
    const drain = async (step: () => Promise<number>) => {
      let total = 0;
      for (let round = 0; round < 100; round += 1) {
        const count = await step();
        total += count;
        if (count < this.settings.batchSize) break;
      }
      return total;
    };
    const expired = await drain(() => this.drafts.expireDue(now, this.settings.batchSize));
    const purgedDrafts = await drain(() =>
      this.drafts.purgeFinishedBefore(
        new Date(now.getTime() - this.settings.finishedDraftRetentionDays * DAY_MS),
        this.settings.batchSize,
      ),
    );
    const purgedUsage = await drain(() =>
      this.usage.purgeBefore(
        new Date(now.getTime() - this.settings.usageRetentionDays * DAY_MS),
        this.settings.batchSize,
      ),
    );
    return { expired, purgedDrafts, purgedUsage };
  }
}
