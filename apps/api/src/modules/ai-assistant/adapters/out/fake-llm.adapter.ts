import type { LLMPort, LLMRequest, LLMResult } from '../../ports/assistant-ports.js';

/**
 * Deterministic model for tests and CI: answers by a function of the request, or fails on
 * demand. Never calls a network.
 */
export class FakeLLMAdapter implements LLMPort {
  readonly requests: LLMRequest[] = [];
  private responder: (request: LLMRequest) => LLMResult | Promise<LLMResult>;

  constructor(responder?: (request: LLMRequest) => LLMResult | Promise<LLMResult>) {
    this.responder =
      responder ??
      (() => ({ kind: 'error', reason: 'unavailable', inputTokens: 0, outputTokens: 0 }));
  }

  respondWith(responder: (request: LLMRequest) => LLMResult | Promise<LLMResult>): void {
    this.responder = responder;
  }

  async complete(request: LLMRequest): Promise<LLMResult> {
    this.requests.push(request);
    return this.responder(request);
  }
}

export const fakeJson = (value: unknown, inputTokens = 300, outputTokens = 60): LLMResult => ({
  kind: 'ok',
  text: JSON.stringify(value),
  inputTokens,
  outputTokens,
});
