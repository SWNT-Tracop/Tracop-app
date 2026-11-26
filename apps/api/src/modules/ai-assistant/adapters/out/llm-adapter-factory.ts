import type { LLMPort } from '../../ports/assistant-ports.js';
import { AnthropicLLMAdapter } from './anthropic-llm.adapter.js';
import { GeminiLLMAdapter } from './gemini-llm.adapter.js';
import type { LLMHttpOptions } from './llm-http.js';

/** Providers behind LLMPort; `LLM_PROVIDER` picks one. */
export const LLM_PROVIDERS = ['anthropic', 'google'] as const;
export type LLMProvider = (typeof LLM_PROVIDERS)[number];

export interface LLMAdapterSettings extends LLMHttpOptions {
  readonly provider: LLMProvider;
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
}

/** The real adapter for the configured provider; used by the module and by `ai:eval-live`. */
export const createLLMAdapter = ({ provider, ...options }: LLMAdapterSettings): LLMPort =>
  provider === 'google' ? new GeminiLLMAdapter(options) : new AnthropicLLMAdapter(options);
