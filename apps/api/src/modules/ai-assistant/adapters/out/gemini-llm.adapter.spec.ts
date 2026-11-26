import { EXTRACTION_JSON_SCHEMA, extractionSchema } from '../../prompts/lot-draft.v1.js';
import { AnthropicLLMAdapter } from './anthropic-llm.adapter.js';
import { GEMINI_API_VERSION, GeminiLLMAdapter, toGeminiSchema } from './gemini-llm.adapter.js';
import { createLLMAdapter } from './llm-adapter-factory.js';

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

const KEY = 'gemini-test-key-marker-4b2a';
const request = {
  system: 'sistema',
  user: '<mensaje>\ntengo papa\n</mensaje>',
  jsonSchema: EXTRACTION_JSON_SCHEMA,
  maxOutputTokens: 400,
};

const answer = (body: unknown) => () =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const adapter = (responses: (() => Response)[], model = 'gemini-flash-lite-test') => {
  const calls: { url: string; init: FetchInit }[] = [];
  const llm = new GeminiLLMAdapter({
    apiKey: KEY,
    model,
    timeoutMs: 5_000,
    fetch: (async (url: string, init: FetchInit) => {
      calls.push({ url, init });
      return responses.shift()!();
    }) as unknown as typeof fetch,
  });
  return { llm, calls };
};

const stop = (parts: { text: string; thought?: boolean }[], usage = {}) =>
  answer({ candidates: [{ content: { parts }, finishReason: 'STOP' }], usageMetadata: usage });

describe('GeminiLLMAdapter', () => {
  it('calls generateContent with the key in x-goog-api-key and the documented body', async () => {
    const { llm, calls } = adapter([stop([{ text: '{}' }])], 'gemini/x y');
    await llm.complete(request);
    const [{ url, init }] = calls as [{ url: string; init: FetchInit }];
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/gemini%2Fx%20y:generateContent`,
    );
    expect(init.headers).toEqual({ 'x-goog-api-key': KEY, 'content-type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({
      systemInstruction: { parts: [{ text: 'sistema' }] },
      contents: [{ role: 'user', parts: [{ text: request.user }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: toGeminiSchema(EXTRACTION_JSON_SCHEMA),
        maxOutputTokens: 400,
      },
    });
  });

  it('rewrites only an enum holding null, keeping every other keyword of the schema', () => {
    const schema = toGeminiSchema(EXTRACTION_JSON_SCHEMA) as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual((EXTRACTION_JSON_SCHEMA as { required: string[] }).required);
    expect(schema.properties.priceBasis).toEqual({
      anyOf: [{ enum: ['unit', 'total'] }, { type: 'null' }],
    });
    expect(schema.properties.product).toEqual({ type: ['string', 'null'] });
    const enumsWithNull: unknown[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      if (Array.isArray(record.enum) && record.enum.includes(null)) enumsWithNull.push(record);
      Object.values(record).forEach(walk);
    };
    walk(schema);
    expect(enumsWithNull).toEqual([]);
  });

  it('joins the answer parts, skips thoughts and counts thinking tokens as output', async () => {
    const extraction = {
      product: 'papa criolla',
      quantity: '2',
      unit: 'bultos',
      price: '80 mil',
      priceBasis: 'unit',
      quality: null,
      availableFrom: 'viernes',
      availableUntil: 'sábado',
    };
    const text = JSON.stringify(extraction);
    const { llm } = adapter([
      stop(
        [
          { text: 'pensando…', thought: true },
          { text: text.slice(0, 20) },
          { text: text.slice(20) },
        ],
        { promptTokenCount: 310, candidatesTokenCount: 60, thoughtsTokenCount: 25 },
      ),
    ]);
    const result = await llm.complete(request);
    expect(result).toEqual({ kind: 'ok', text, inputTokens: 310, outputTokens: 85 });
    expect(extractionSchema.parse(JSON.parse(result.kind === 'ok' ? result.text : ''))).toEqual(
      extraction,
    );
  });

  it.each([
    ['a blocked prompt', { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }, 'refusal'],
    ['PROHIBITED_CONTENT', { candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] }, 'refusal'],
    ['RECITATION', { candidates: [{ finishReason: 'RECITATION' }] }, 'refusal'],
    ['MAX_TOKENS', { candidates: [{ finishReason: 'MAX_TOKENS' }] }, 'truncated'],
    ['MALFORMED_RESPONSE', { candidates: [{ finishReason: 'MALFORMED_RESPONSE' }] }, 'rejected'],
    ['no candidates', { candidates: [] }, 'rejected'],
    [
      'STOP without text',
      { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] },
      'rejected',
    ],
  ])('maps %s to %s', async (_name, body, reason) => {
    const { llm } = adapter([answer(body)]);
    expect(await llm.complete(request)).toMatchObject({ kind: 'error', reason });
  });

  it('honours LLM_BASE_URL for a proxy, without a trailing slash', async () => {
    const calls: string[] = [];
    const llm = new GeminiLLMAdapter({
      apiKey: KEY,
      model: 'm',
      timeoutMs: 1_000,
      baseUrl: 'https://proxy.example.test/',
      fetch: (async (url: string) => {
        calls.push(url);
        return stop([{ text: '{}' }])();
      }) as unknown as typeof fetch,
    });
    await llm.complete(request);
    expect(calls).toEqual([
      `https://proxy.example.test/${GEMINI_API_VERSION}/models/m:generateContent`,
    ]);
  });
});

describe('createLLMAdapter', () => {
  it('builds the adapter of the configured provider', () => {
    const settings = { apiKey: KEY, model: 'm', timeoutMs: 1_000 };
    expect(createLLMAdapter({ ...settings, provider: 'google' })).toBeInstanceOf(GeminiLLMAdapter);
    expect(createLLMAdapter({ ...settings, provider: 'anthropic' })).toBeInstanceOf(
      AnthropicLLMAdapter,
    );
  });
});
