import type pino from 'pino';
import type { LLMResult } from '../../ports/assistant-ports.js';

/**
 * The HTTP part every model provider shares: one POST with a JSON body, one deadline for the
 * call and its retries, retries only for 429 and 5xx (at most twice, growing waits, honouring
 * Retry-After), never for other 4xx. Bodies are never logged: a provider error may echo the
 * prompt, so it is discarded unread. Each adapter only builds the request and reads its answer.
 */
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 4_000;

export interface LLMHttpOptions {
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger?: pino.Logger;
}

export type LLMHttpOutcome =
  | { readonly kind: 'ok'; readonly payload: unknown }
  | { readonly kind: 'error'; readonly result: LLMResult };

const retryable = (status: number): boolean => status === 429 || status >= 500;

const backoff = (attempt: number, retryAfter: string | null): number => {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  const wait = Number.isFinite(seconds) ? seconds * 1000 : BASE_BACKOFF_MS * 2 ** attempt;
  return Math.min(Math.max(wait, 0), MAX_BACKOFF_MS);
};

export const llmFailure = (reason: 'timeout' | 'unavailable' | 'rejected'): LLMHttpOutcome => ({
  kind: 'error',
  result: { kind: 'error', reason, inputTokens: 0, outputTokens: 0 },
});

export class LLMHttpClient {
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: LLMHttpOptions) {
    this.fetch = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async post(url: string, headers: Record<string, string>, body: string): Promise<LLMHttpOutcome> {
    const signal = AbortSignal.timeout(this.options.timeoutMs);
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetch(url, { method: 'POST', headers, body, signal });
      } catch {
        const timedOut = signal.aborted;
        this.log(timedOut ? 'timeout' : 'network_error', null, attempt);
        if (timedOut) return llmFailure('timeout');
        if (attempt >= MAX_RETRIES) return llmFailure('unavailable');
        await this.wait(backoff(attempt, null), signal);
        if (signal.aborted) return llmFailure('timeout');
        continue;
      }
      if (response.ok) return { kind: 'ok', payload: await response.json() };
      await response.body?.cancel().catch(() => undefined);
      this.log('http_error', response.status, attempt);
      if (!retryable(response.status)) return llmFailure('rejected');
      if (attempt >= MAX_RETRIES) return llmFailure('unavailable');
      await this.wait(backoff(attempt, response.headers.get('retry-after')), signal);
      if (signal.aborted) return llmFailure('timeout');
    }
  }

  private async wait(ms: number, signal: AbortSignal): Promise<void> {
    if (!signal.aborted) await this.sleep(ms);
  }

  private log(event: string, status: number | null, attempt: number): void {
    this.options.logger?.warn({ event: `llm_${event}`, status, attempt }, 'LLM call failed.');
  }
}
