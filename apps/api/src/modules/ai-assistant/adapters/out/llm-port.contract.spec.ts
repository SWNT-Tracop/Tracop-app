import { Writable } from 'node:stream';
import { createLogger } from '../../../../shared/infra/logger.js';
import type { LLMPort } from '../../ports/assistant-ports.js';
import { AnthropicLLMAdapter } from './anthropic-llm.adapter.js';
import { GeminiLLMAdapter } from './gemini-llm.adapter.js';
import type { LLMHttpOptions } from './llm-http.js';

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

const KEY = 'contract-test-key-marker-7d1e';
const request = {
  system: 'sistema',
  user: '<mensaje>\ntengo papa\n</mensaje>',
  jsonSchema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  maxOutputTokens: 200,
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** What each provider answers in its own shape; the behaviour checked below is the same. */
type Provider = {
  readonly name: string;
  readonly make: (options: LLMHttpOptions & { apiKey: string; model: string }) => LLMPort;
  readonly ok: (text: string, input: number, output: number) => Response;
  readonly truncated: () => Response;
  readonly refused: () => Response;
  readonly error: (status: number, headers?: Record<string, string>) => Response;
};

const PROVIDERS: Provider[] = [
  {
    name: 'Anthropic',
    make: (options) => new AnthropicLLMAdapter(options),
    ok: (text, input, output) =>
      json({
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: { input_tokens: input, output_tokens: output },
      }),
    truncated: () => json({ content: [{ type: 'text', text: '{' }], stop_reason: 'max_tokens' }),
    refused: () => json({ content: [], stop_reason: 'refusal' }),
    error: (status, headers) =>
      json({ type: 'error', error: { message: 'echo tengo papa' } }, status, headers),
  },
  {
    name: 'Gemini',
    make: (options) => new GeminiLLMAdapter(options),
    ok: (text, input, output) =>
      json({
        candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: input, candidatesTokenCount: output },
      }),
    truncated: () =>
      json({ candidates: [{ content: { parts: [{ text: '{' }] }, finishReason: 'MAX_TOKENS' }] }),
    refused: () => json({ candidates: [{ finishReason: 'SAFETY' }] }),
    error: (status, headers) =>
      json({ error: { code: status, message: 'echo tengo papa' } }, status, headers),
  },
];

describe.each(PROVIDERS)('LLMPort contract: $name adapter', (provider) => {
  const adapter = (responses: (() => Response)[], logs?: { value: string }) => {
    const calls: { url: string; init: FetchInit }[] = [];
    const waits: number[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        if (logs) logs.value += chunk.toString();
        callback();
      },
    });
    const llm = provider.make({
      apiKey: KEY,
      model: 'model-from-env',
      timeoutMs: 5_000,
      fetch: (async (url: string, init: FetchInit) => {
        calls.push({ url, init });
        const next = responses.shift();
        if (!next) throw new Error('no more responses');
        return next();
      }) as unknown as typeof fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
      logger: createLogger('development', destination),
    });
    return { llm, calls, waits };
  };

  it('returns the text and token counts, with the key only in a header', async () => {
    const { llm, calls } = adapter([() => provider.ok('{"a":1}', 120, 30)]);
    expect(await llm.complete(request)).toEqual({
      kind: 'ok',
      text: '{"a":1}',
      inputTokens: 120,
      outputTokens: 30,
    });
    const [{ url, init }] = calls as [{ url: string; init: FetchInit }];
    expect(url.includes(KEY)).toBe(false);
    expect(String(init.body).includes(KEY)).toBe(false);
    expect(Object.values(init.headers as Record<string, string>).join(' ')).toContain(KEY);
  });

  it('retries 429 and 5xx at most twice with growing waits, honouring retry-after', async () => {
    const { llm, calls, waits } = adapter([
      () => provider.error(503),
      () => provider.error(429, { 'retry-after': '2' }),
      () => provider.ok('{}', 1, 1),
    ]);
    expect((await llm.complete(request)).kind).toBe('ok');
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([500, 2_000]);

    const exhausted = adapter([
      () => provider.error(500),
      () => provider.error(503),
      () => provider.error(500),
    ]);
    expect(await exhausted.llm.complete(request)).toMatchObject({
      kind: 'error',
      reason: 'unavailable',
    });
    expect(exhausted.calls).toHaveLength(3);
  });

  it.each([400, 401, 403, 404])('does not retry %s', async (code) => {
    const { llm, calls } = adapter([() => provider.error(code), () => provider.ok('{}', 1, 1)]);
    expect(await llm.complete(request)).toMatchObject({ kind: 'error', reason: 'rejected' });
    expect(calls).toHaveLength(1);
  });

  it('reports a cut answer as truncated and a declined one as a refusal', async () => {
    expect(await adapter([provider.truncated]).llm.complete(request)).toMatchObject({
      kind: 'error',
      reason: 'truncated',
    });
    expect(await adapter([provider.refused]).llm.complete(request)).toMatchObject({
      kind: 'error',
      reason: 'refusal',
    });
  });

  it('times out with one deadline for the call and its retries', async () => {
    const slow = provider.make({
      apiKey: KEY,
      model: 'm',
      timeoutMs: 1_000,
      fetch: ((_url: string, init: FetchInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        )) as unknown as typeof fetch,
    });
    expect(await slow.complete(request)).toMatchObject({ kind: 'error', reason: 'timeout' });
  });

  it('never logs the key, the prompt or the provider response body', async () => {
    const logs = { value: '' };
    const { llm } = adapter([() => provider.error(500), () => provider.error(400)], logs);
    await llm.complete(request);
    expect(logs.value).not.toBe('');
    for (const secret of [KEY, 'tengo papa', 'sistema'])
      expect(logs.value.includes(secret)).toBe(false);
  });
});
