/**
 * Live evaluation of the lot draft extraction against the real model (`pnpm ai:eval-live`).
 * Run by a person, never in CI. Reads LLM_API_KEY and LLM_MODEL from the environment, stops at
 * a hard cap of calls and tokens, and prints ONLY per-field accuracy, critical errors (by case
 * number), tokens and an estimated cost: never message contents, model answers or the key.
 *
 *   AI_EVAL_MAX_CALLS (default 60), AI_EVAL_MAX_TOKENS (default 200000),
 *   AI_EVAL_INPUT_USD_PER_MTOK and AI_EVAL_OUTPUT_USD_PER_MTOK (for the cost estimate; take
 *   them from the provider's current pricing page for the chosen model).
 */
import { AnthropicLLMAdapter } from '../src/modules/ai-assistant/adapters/out/anthropic-llm.adapter.js';
import { applyExtraction } from '../src/modules/ai-assistant/domain/apply-answer.js';
import { parseDay } from '../src/modules/ai-assistant/domain/dates.js';
import { parseUnit } from '../src/modules/ai-assistant/domain/parsing.js';
import {
  LIVE_SET,
  LIVE_SET_NOW,
  type LiveExpected,
} from '../src/modules/ai-assistant/eval/live-set.js';
import {
  buildExtractionPrompt,
  extractionSchema,
  PROMPT_VERSION,
} from '../src/modules/ai-assistant/prompts/lot-draft.v1.js';

const FIELDS = [
  'product',
  'quantityMilli',
  'unit',
  'priceAmount',
  'priceBasis',
  'availableFromDay',
  'availableUntilDay',
] as const;
type Field = (typeof FIELDS)[number];
const CRITICAL: readonly Field[] = ['quantityMilli', 'unit', 'priceAmount'];
const TARGET_ACCURACY = 0.9; // PROVISIONAL

const fold = (value: string) =>
  value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

const numberFromEnv = (name: string, fallback: number | null): number | null => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${name} must be a non-negative number.`);
  return value;
};

const main = async (): Promise<void> => {
  if (process.env.CI === 'true') {
    console.error('ai:eval-live never runs in CI.');
    process.exit(2);
  }
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!apiKey || !model) {
    console.error('Set LLM_API_KEY and LLM_MODEL in the environment.');
    process.exit(2);
  }
  const maxCalls = numberFromEnv('AI_EVAL_MAX_CALLS', 60)!;
  const maxTokens = numberFromEnv('AI_EVAL_MAX_TOKENS', 200_000)!;
  const inputPrice = numberFromEnv('AI_EVAL_INPUT_USD_PER_MTOK', null);
  const outputPrice = numberFromEnv('AI_EVAL_OUTPUT_USD_PER_MTOK', null);
  const llm = new AnthropicLLMAdapter({
    apiKey,
    model,
    timeoutMs: numberFromEnv('LLM_TIMEOUT_MS', 15_000)!,
    ...(process.env.LLM_BASE_URL ? { baseUrl: process.env.LLM_BASE_URL } : {}),
  });

  const correct: Record<Field, number> = Object.fromEntries(FIELDS.map((f) => [f, 0])) as Record<
    Field,
    number
  >;
  const critical: string[] = [];
  const failures: number[] = [];
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let evaluated = 0;

  for (const [index, item] of LIVE_SET.entries()) {
    if (calls >= maxCalls || inputTokens + outputTokens >= maxTokens) break;
    const prompt = buildExtractionPrompt(item.text);
    let extraction: ReturnType<typeof extractionSchema.parse> | null = null;
    // One retry at most, as in the bot.
    for (let attempt = 0; attempt < 2 && !extraction; attempt += 1) {
      if (calls >= maxCalls || inputTokens + outputTokens >= maxTokens) break;
      calls += 1;
      const result = await llm.complete({ ...prompt, maxOutputTokens: 400 });
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      if (result.kind !== 'ok') break;
      try {
        const parsed = extractionSchema.safeParse(JSON.parse(result.text));
        if (parsed.success) extraction = parsed.data;
      } catch {
        // invalid JSON: retried once
      }
    }
    evaluated += 1;
    if (!extraction) {
      failures.push(index + 1);
      continue;
    }
    const { fields } = applyExtraction({}, extraction, LIVE_SET_NOW);
    const actual: Record<Field, string | null> = {
      product: fields.productQuery ? fold(fields.productQuery) : null,
      quantityMilli: fields.quantityMilli ?? null,
      unit:
        fields.unit ??
        (extraction.unit && parseUnit(extraction.unit).kind === 'unsupported'
          ? 'unsupported'
          : null),
      priceAmount: fields.priceAmount ?? null,
      priceBasis: fields.priceBasis ?? null,
      availableFromDay:
        fields.availableFromDay ??
        (extraction.availableFrom &&
        parseDay(extraction.availableFrom, LIVE_SET_NOW).kind === 'ambiguous'
          ? 'ambiguous'
          : null),
      availableUntilDay:
        fields.availableUntilDay ??
        (extraction.availableUntil &&
        parseDay(extraction.availableUntil, LIVE_SET_NOW).kind === 'ambiguous'
          ? 'ambiguous'
          : null),
    };
    const expected = item.expected as LiveExpected;
    for (const field of FIELDS) {
      const want =
        field === 'product' && expected.product ? fold(expected.product) : expected[field];
      if (actual[field] === want) correct[field] += 1;
      else if (CRITICAL.includes(field) && actual[field] !== null)
        critical.push(`#${index + 1} ${field}`);
    }
  }

  const total = FIELDS.reduce((sum, field) => sum + correct[field], 0);
  const accuracy = evaluated ? total / (evaluated * FIELDS.length) : 0;
  const cost =
    inputPrice !== null && outputPrice !== null
      ? (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000
      : null;
  const lines = [
    `prompt ${PROMPT_VERSION} · cases ${evaluated}/${LIVE_SET.length} · calls ${calls}`,
    ...FIELDS.map(
      (field) =>
        `  ${field.padEnd(18)} ${((correct[field] / Math.max(evaluated, 1)) * 100).toFixed(1)} %`,
    ),
    `overall field accuracy ${(accuracy * 100).toFixed(1)} % (target ≥ ${TARGET_ACCURACY * 100} %, PROVISIONAL)`,
    `critical errors ${critical.length}${critical.length ? `: ${critical.join(', ')}` : ''}`,
    `no valid output: ${failures.length ? failures.map((n) => `#${n}`).join(', ') : 'none'}`,
    `tokens in ${inputTokens} · out ${outputTokens}`,
    cost === null
      ? 'cost: set AI_EVAL_INPUT_USD_PER_MTOK and AI_EVAL_OUTPUT_USD_PER_MTOK to estimate it'
      : `cost ≈ USD ${cost.toFixed(4)} · per draft ≈ USD ${(cost / Math.max(evaluated, 1)).toFixed(5)}`,
  ];
  console.log(lines.join('\n'));
  process.exitCode = accuracy >= TARGET_ACCURACY && critical.length === 0 ? 0 : 1;
};

main().catch((error: unknown) => {
  // Only the error class: a message could carry request details.
  console.error(`ai:eval-live failed: ${error instanceof Error ? error.name : 'Error'}`);
  process.exit(1);
});
