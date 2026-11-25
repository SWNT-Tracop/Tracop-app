import type pino from 'pino';
import type { LLMPort, LLMRequest, LLMResult } from '../../ports/assistant-ports.js';

/**
 * Anthropic Messages API over native fetch (no SDK), following the current documentation:
 * - POST /v1/messages with `Authorization: Bearer <key>` and `anthropic-version`
 *   (https://platform.claude.com/docs/en/api/overview, …/api/versioning);
 * - structured output with `output_config.format = { type: 'json_schema', schema }`, the JSON in
 *   the `text` block (https://platform.claude.com/docs/en/build-with-claude/structured-outputs);
 * - retry only 429 and 5xx with growing waits, never other 4xx
 *   (https://platform.claude.com/docs/en/api/errors).
 * No `temperature`: version 2026-10-21 removed it. Bodies are never logged; the key travels only
 * in the header.
 */
export const ANTHROPIC_API_VERSION = '2026-10-21';
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 4_000;

export interface AnthropicLLMOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger?: pino.Logger;
}

type AnthropicResponse = {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly stop_reason?: string;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
};

const retryable = (status: number): boolean => status === 429 || status >= 500;

const backoff = (attempt: number, retryAfter: string | null): number => {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  const wait = Number.isFinite(seconds) ? seconds * 1000 : BASE_BACKOFF_MS * 2 ** attempt;
  return Math.min(Math.max(wait, 0), MAX_BACKOFF_MS);
};

export class AnthropicLLMAdapter implements LLMPort {
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly url: string;

  constructor(private readonly options: AnthropicLLMOptions) {
    this.fetch = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.url = `${(options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
  }

  async complete(request: LLMRequest): Promise<LLMResult> {
    // One deadline for the call and its retries.
    const signal = AbortSignal.timeout(this.options.timeoutMs);
    const body = JSON.stringify({
      model: this.options.model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
      output_config: { format: { type: 'json_schema', schema: request.jsonSchema } },
    });
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetch(this.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            'anthropic-version': ANTHROPIC_API_VERSION,
            'content-type': 'application/json',
          },
          body,
          signal,
        });
      } catch (error) {
        const timedOut = signal.aborted;
        this.log(timedOut ? 'timeout' : 'network_error', null, attempt);
        if (timedOut) return this.failure('timeout');
        if (attempt >= MAX_RETRIES) return this.failure('unavailable');
        await this.wait(backoff(attempt, null), signal);
        if (signal.aborted) return this.failure('timeout');
        void error;
        continue;
      }
      if (response.ok) return this.parse((await response.json()) as AnthropicResponse);
      // The body may echo the request; it is discarded without reading it into logs.
      await response.body?.cancel().catch(() => undefined);
      this.log('http_error', response.status, attempt);
      if (!retryable(response.status)) return this.failure('rejected');
      if (attempt >= MAX_RETRIES) return this.failure('unavailable');
      await this.wait(backoff(attempt, response.headers.get('retry-after')), signal);
      if (signal.aborted) return this.failure('timeout');
    }
  }

  private parse(payload: AnthropicResponse): LLMResult {
    const inputTokens = payload.usage?.input_tokens ?? 0;
    const outputTokens = payload.usage?.output_tokens ?? 0;
    if (payload.stop_reason === 'refusal')
      return { kind: 'error', reason: 'refusal', inputTokens, outputTokens };
    if (payload.stop_reason === 'max_tokens')
      return { kind: 'error', reason: 'truncated', inputTokens, outputTokens };
    const text = payload.content?.find((block) => block.type === 'text')?.text;
    if (typeof text !== 'string')
      return { kind: 'error', reason: 'rejected', inputTokens, outputTokens };
    return { kind: 'ok', text, inputTokens, outputTokens };
  }

  private failure(reason: 'timeout' | 'unavailable' | 'rejected'): LLMResult {
    return { kind: 'error', reason, inputTokens: 0, outputTokens: 0 };
  }

  private async wait(ms: number, signal: AbortSignal): Promise<void> {
    if (!signal.aborted) await this.sleep(ms);
  }

  private log(event: string, status: number | null, attempt: number): void {
    this.options.logger?.warn({ event: `llm_${event}`, status, attempt }, 'LLM call failed.');
  }
}
