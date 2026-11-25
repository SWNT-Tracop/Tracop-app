import type { z } from 'zod';
import type { Clock } from '../../../shared/kernel/clock.js';
import { createId } from '../../../shared/kernel/ids.js';
import { bogotaDay } from '../domain/dates.js';
import type {
  AiConsentPort,
  LLMPort,
  LLMRequest,
  UsageOutcome,
  UsageRecord,
  UsageRepository,
} from '../ports/assistant-ports.js';

export interface AiGatewaySettings {
  readonly enabled: boolean;
  readonly consentVersion: string;
  readonly dailyRequestsPerUser: number;
  readonly requestsPerMinute: number;
  readonly monthlyTokenCap: number;
  readonly maxOutputTokens: number;
}

/** Why the model is not used; the bot then runs the guided form. */
export type AiUnavailable =
  'disabled' | 'no_consent' | 'rate_limited' | 'daily_limit' | 'budget_exhausted' | 'model_failed';

export type AiCall<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'unavailable'; readonly reason: AiUnavailable };

/** Per-user calls per minute, in memory (one process); the daily limit is in the database. */
export class MinuteRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly clock: Clock,
  ) {}

  take(key: string): boolean {
    const now = this.clock.now().getTime();
    const window = this.windows.get(key);
    if (!window || now - window.start >= 60_000) {
      this.windows.set(key, { start: now, count: 1 });
      if (this.windows.size > 10_000) this.evict(now);
      return true;
    }
    if (window.count >= this.limit) return false;
    window.count += 1;
    return true;
  }

  private evict(now: number): void {
    for (const [key, window] of this.windows)
      if (now - window.start >= 60_000) this.windows.delete(key);
  }
}

/** Rough upper bound of a request's input tokens (≈ 3 characters per token in Spanish). */
export const estimateInputTokens = (request: LLMRequest): number =>
  Math.ceil(
    (request.system.length + request.user.length + JSON.stringify(request.jsonSchema).length) / 3,
  );

const monthOf = (now: Date): string => `${bogotaDay(now).slice(0, 7)}-01`;

/**
 * The only way the assistant reaches the model. Checks, in order: the AI_ENABLED switch, the
 * user's current AI consent, the per-minute and per-day limits and an atomic reservation of the
 * monthly token budget. Validates the output with zod and retries once at most. Records usage
 * (tokens, latency, outcome), never the text.
 */
export class AiGateway {
  constructor(
    private readonly llm: LLMPort,
    private readonly consent: AiConsentPort,
    private readonly usage: UsageRepository,
    private readonly minuteLimiter: MinuteRateLimiter,
    private readonly settings: AiGatewaySettings,
    private readonly clock: Clock,
  ) {}

  async availability(userId: string): Promise<'ok' | 'disabled' | 'no_consent'> {
    if (!this.settings.enabled) return 'disabled';
    const status = await this.consent.status(userId, this.settings.consentVersion);
    return status === 'accepted' ? 'ok' : 'no_consent';
  }

  async generate<T>(
    userId: string,
    purpose: UsageRecord['purpose'],
    request: Omit<LLMRequest, 'maxOutputTokens'>,
    schema: z.ZodType<T>,
  ): Promise<AiCall<T>> {
    const available = await this.availability(userId);
    if (available !== 'ok') return { kind: 'unavailable', reason: available };
    if (!this.minuteLimiter.take(userId)) return { kind: 'unavailable', reason: 'rate_limited' };
    const day = bogotaDay(this.clock.now());
    if ((await this.usage.countForDay(userId, day)) >= this.settings.dailyRequestsPerUser)
      return { kind: 'unavailable', reason: 'daily_limit' };

    const full: LLMRequest = { ...request, maxOutputTokens: this.settings.maxOutputTokens };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await this.callOnce(userId, purpose, full, schema);
      if (outcome.kind === 'ok') return outcome;
      if (outcome.reason !== 'invalid_output') {
        return {
          kind: 'unavailable',
          reason: outcome.reason === 'budget_exhausted' ? 'budget_exhausted' : 'model_failed',
        };
      }
    }
    return { kind: 'unavailable', reason: 'model_failed' };
  }

  private async callOnce<T>(
    userId: string,
    purpose: UsageRecord['purpose'],
    request: LLMRequest,
    schema: z.ZodType<T>,
  ): Promise<{ kind: 'ok'; value: T } | { kind: 'failed'; reason: UsageOutcome }> {
    const month = monthOf(this.clock.now());
    const reserved = estimateInputTokens(request) + request.maxOutputTokens;
    if (!(await this.usage.reserve(month, reserved, this.settings.monthlyTokenCap))) {
      await this.record(userId, purpose, 0, 0, 0, 'budget_exhausted');
      return { kind: 'failed', reason: 'budget_exhausted' };
    }
    const startedAt = this.clock.now().getTime();
    let used = 0;
    try {
      const result = await this.llm.complete(request);
      used = result.inputTokens + result.outputTokens;
      const latencyMs = Math.max(0, this.clock.now().getTime() - startedAt);
      if (result.kind === 'error') {
        await this.record(
          userId,
          purpose,
          result.inputTokens,
          result.outputTokens,
          latencyMs,
          result.reason,
        );
        return { kind: 'failed', reason: result.reason };
      }
      const parsed = parseJson(result.text, schema);
      await this.record(
        userId,
        purpose,
        result.inputTokens,
        result.outputTokens,
        latencyMs,
        parsed === undefined ? 'invalid_output' : 'ok',
      );
      return parsed === undefined
        ? { kind: 'failed', reason: 'invalid_output' }
        : { kind: 'ok', value: parsed };
    } finally {
      await this.usage.settle(month, reserved, used);
    }
  }

  private record(
    userId: string,
    purpose: UsageRecord['purpose'],
    inputTokens: number,
    outputTokens: number,
    latencyMs: number,
    outcome: UsageOutcome,
  ): Promise<void> {
    return this.usage.record({
      id: createId(),
      userId,
      purpose,
      inputTokens,
      outputTokens,
      latencyMs,
      outcome,
      at: this.clock.now(),
    });
  }
}

const parseJson = <T>(text: string, schema: z.ZodType<T>): T | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};
