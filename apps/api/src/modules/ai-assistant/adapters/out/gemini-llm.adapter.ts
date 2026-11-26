import type { LLMPort, LLMRequest, LLMResult } from '../../ports/assistant-ports.js';
import { LLMHttpClient, type LLMHttpOptions } from './llm-http.js';

/**
 * Google Gemini API (Google AI Studio keys) over native fetch, following the current reference
 * (https://ai.google.dev/api/generate-content, https://ai.google.dev/gemini-api/docs/structured-output):
 * - POST /v1beta/models/{model}:generateContent with the key in the `x-goog-api-key` header,
 *   never in the URL (a query-string key would end up in proxy and access logs);
 * - `systemInstruction` for the system prompt, one `user` turn in `contents`;
 * - structured output with `generationConfig.responseMimeType = application/json` and
 *   `responseJsonSchema`, the JSON in `candidates[0].content.parts[].text`;
 * - `usageMetadata`: thinking tokens (`thoughtsTokenCount`) are counted as output, so the
 *   monthly token budget sees everything the call cost.
 * No thinking settings are sent: the model's own default applies (a Flash-Lite model thinks the
 * least), and a thought-heavy answer cut by `maxOutputTokens` ends as `truncated`.
 */
export const GEMINI_API_VERSION = 'v1beta';

export interface GeminiLLMOptions extends LLMHttpOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
}

type GeminiResponse = {
  readonly candidates?: readonly {
    readonly content?: { readonly parts?: readonly { text?: string; thought?: boolean }[] };
    readonly finishReason?: string;
  }[];
  readonly promptFeedback?: { readonly blockReason?: string };
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
    readonly thoughtsTokenCount?: number;
  };
};

/** Finish reasons where the provider declined to answer: the assistant falls back, never retries. */
const REFUSALS = new Set([
  'SAFETY',
  'RECITATION',
  'LANGUAGE',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
]);

/**
 * Gemini's JSON Schema support documents `type` arrays and `anyOf`, but not an `enum` that holds
 * `null`: such an enum becomes `anyOf` of the non-null values and `null`. Everything else is kept.
 * The answer is still checked by the prompt's zod schema, whatever the provider accepted.
 */
export const toGeminiSchema = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  const entries = Object.entries(schema as Record<string, unknown>).map(
    ([key, value]) => [key, toGeminiSchema(value)] as const,
  );
  const node = Object.fromEntries(entries) as Record<string, unknown>;
  if (Array.isArray(node.enum) && node.enum.includes(null)) {
    const { enum: values, ...rest } = node;
    return {
      ...rest,
      anyOf: [{ enum: (values as unknown[]).filter((value) => value !== null) }, { type: 'null' }],
    };
  }
  return node;
};

export class GeminiLLMAdapter implements LLMPort {
  private readonly http: LLMHttpClient;
  private readonly url: string;

  constructor(private readonly options: GeminiLLMOptions) {
    this.http = new LLMHttpClient(options);
    const base = (options.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(
      /\/$/,
      '',
    );
    this.url = `${base}/${GEMINI_API_VERSION}/models/${encodeURIComponent(options.model)}:generateContent`;
  }

  async complete(request: LLMRequest): Promise<LLMResult> {
    const outcome = await this.http.post(
      this.url,
      { 'x-goog-api-key': this.options.apiKey, 'content-type': 'application/json' },
      JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: 'user', parts: [{ text: request.user }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: toGeminiSchema(request.jsonSchema),
          maxOutputTokens: request.maxOutputTokens,
        },
      }),
    );
    return outcome.kind === 'ok' ? this.parse(outcome.payload as GeminiResponse) : outcome.result;
  }

  private parse(payload: GeminiResponse): LLMResult {
    const usage = payload.usageMetadata;
    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
    if (payload.promptFeedback?.blockReason)
      return { kind: 'error', reason: 'refusal', inputTokens, outputTokens };
    const candidate = payload.candidates?.[0];
    const finish = candidate?.finishReason;
    if (finish === 'MAX_TOKENS')
      return { kind: 'error', reason: 'truncated', inputTokens, outputTokens };
    if (finish && REFUSALS.has(finish))
      return { kind: 'error', reason: 'refusal', inputTokens, outputTokens };
    const text = (candidate?.content?.parts ?? [])
      .filter((part) => typeof part.text === 'string' && !part.thought)
      .map((part) => part.text)
      .join('');
    if (finish !== 'STOP' || text === '')
      return { kind: 'error', reason: 'rejected', inputTokens, outputTokens };
    return { kind: 'ok', text, inputTokens, outputTokens };
  }
}
