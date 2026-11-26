import type { LLMPort, LLMRequest, LLMResult } from '../../ports/assistant-ports.js';
import { LLMHttpClient, type LLMHttpOptions } from './llm-http.js';

/**
 * Anthropic Messages API over native fetch (no SDK), following the current documentation:
 * - POST /v1/messages with `Authorization: Bearer <key>` and `anthropic-version`
 *   (https://platform.claude.com/docs/en/api/overview, …/api/versioning);
 * - structured output with `output_config.format = { type: 'json_schema', schema }`, the JSON in
 *   the `text` block (https://platform.claude.com/docs/en/build-with-claude/structured-outputs);
 * - retry only 429 and 5xx with growing waits, never other 4xx
 *   (https://platform.claude.com/docs/en/api/errors), in LLMHttpClient.
 * No `temperature`: version 2026-10-21 removed it. Bodies are never logged; the key travels only
 * in the header.
 */
export const ANTHROPIC_API_VERSION = '2026-10-21';

export interface AnthropicLLMOptions extends LLMHttpOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
}

type AnthropicResponse = {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly stop_reason?: string;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
};

export class AnthropicLLMAdapter implements LLMPort {
  private readonly http: LLMHttpClient;
  private readonly url: string;

  constructor(private readonly options: AnthropicLLMOptions) {
    this.http = new LLMHttpClient(options);
    this.url = `${(options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
  }

  async complete(request: LLMRequest): Promise<LLMResult> {
    const outcome = await this.http.post(
      this.url,
      {
        Authorization: `Bearer ${this.options.apiKey}`,
        'anthropic-version': ANTHROPIC_API_VERSION,
        'content-type': 'application/json',
      },
      JSON.stringify({
        model: this.options.model,
        max_tokens: request.maxOutputTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
        output_config: { format: { type: 'json_schema', schema: request.jsonSchema } },
      }),
    );
    return outcome.kind === 'ok'
      ? this.parse(outcome.payload as AnthropicResponse)
      : outcome.result;
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
}
