import type { PriceSuggestion, PriceSuggestionPort } from '../../ports/assistant-ports.js';

/** Until phase 8 there is no reference price source: nothing is suggested. */
export class NullPriceSuggestionAdapter implements PriceSuggestionPort {
  async suggest(): Promise<PriceSuggestion | null> {
    return null;
  }
}
