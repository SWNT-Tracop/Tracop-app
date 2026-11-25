import { Writable } from 'node:stream';
import { createLogger } from '../../../../shared/infra/logger.js';
import { ANTHROPIC_API_VERSION, AnthropicLLMAdapter } from './anthropic-llm.adapter.js';

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

const KEY = 'sk-test-key-marker-91c2';
const request = {
  system: 'sistema',
  user: '<mensaje>\ntengo papa\n</mensaje>',
  jsonSchema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  maxOutputTokens: 200,
};

const ok = (text: string) =>
  new Response(
    JSON.stringify({
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 120, output_tokens: 30 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const status = (code: number, headers: Record<string, string> = {}) =>
  new Response(
    JSON.stringify({ type: 'error', error: { type: 'x', message: 'echo tengo papa' } }),
    {
      status: code,
      headers,
    },
  );

const adapter = (responses: (() => Response | Promise<Response>)[], logs?: { value: string }) => {
  const calls: { url: string; init: FetchInit }[] = [];
  const waits: number[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      if (logs) logs.value += chunk.toString();
      callback();
    },
  });
  const llm = new AnthropicLLMAdapter({
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

describe('AnthropicLLMAdapter', () => {
  it('sends the documented headers and structured-output body, with the key only in the header', async () => {
    const { llm, calls } = adapter([() => ok('{"a":1}')]);
    expect(await llm.complete(request)).toEqual({
      kind: 'ok',
      text: '{"a":1}',
      inputTokens: 120,
      outputTokens: 30,
    });
    const [{ url, init }] = calls as [{ url: string; init: FetchInit }];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      'anthropic-version': ANTHROPIC_API_VERSION,
      'content-type': 'application/json',
    });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'output_config',
      'system',
    ]);
    expect(body.model).toBe('model-from-env');
    expect(body.output_config).toEqual({
      format: { type: 'json_schema', schema: request.jsonSchema },
    });
    expect(String(init.body)).not.toContain(KEY);
  });

  it('retries 429 and 5xx at most twice with growing waits, honouring retry-after', async () => {
    const { llm, calls, waits } = adapter([
      () => status(529),
      () => status(429, { 'retry-after': '2' }),
      () => ok('{}'),
    ]);
    expect((await llm.complete(request)).kind).toBe('ok');
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([500, 2_000]);

    const exhausted = adapter([
      () => status(500),
      () => status(503),
      () => status(500),
      () => ok('{}'),
    ]);
    expect(await exhausted.llm.complete(request)).toMatchObject({
      kind: 'error',
      reason: 'unavailable',
    });
    expect(exhausted.calls).toHaveLength(3);
  });

  it.each([400, 401, 403, 404, 413])('does not retry %s', async (code) => {
    const { llm, calls } = adapter([() => status(code), () => ok('{}')]);
    expect(await llm.complete(request)).toMatchObject({ kind: 'error', reason: 'rejected' });
    expect(calls).toHaveLength(1);
  });

  it('maps refusal and max_tokens, and times out with the abort signal', async () => {
    const refusal = adapter([
      () =>
        new Response(
          JSON.stringify({
            content: [],
            stop_reason: 'refusal',
            usage: { input_tokens: 5, output_tokens: 1 },
          }),
        ),
    ]);
    expect(await refusal.llm.complete(request)).toEqual({
      kind: 'error',
      reason: 'refusal',
      inputTokens: 5,
      outputTokens: 1,
    });
    const truncated = adapter([
      () =>
        new Response(
          JSON.stringify({ content: [{ type: 'text', text: '{' }], stop_reason: 'max_tokens' }),
        ),
    ]);
    expect(await truncated.llm.complete(request)).toMatchObject({ reason: 'truncated' });

    const slow = new AnthropicLLMAdapter({
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
    const { llm } = adapter([() => status(500), () => status(400)], logs);
    await llm.complete(request);
    expect(logs.value).not.toBe('');
    for (const secret of [KEY, 'tengo papa', 'sistema'])
      expect(logs.value.includes(secret)).toBe(false);
  });
});
