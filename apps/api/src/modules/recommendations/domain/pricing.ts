/**
 * Price ranges by transparent statistics: integer percentiles (linear interpolation between
 * closest ranks, R-7, rounded half up) over reference prices and TRACOP's own observations.
 * No individual price is ever returned; a range needs at least `minSample` values.
 */

/** The q-th percentile (q in 0..100) of sorted integer values, rounded half up. */
export const percentile = (sorted: readonly bigint[], q: number): bigint => {
  if (sorted.length === 0) throw new Error('No values.');
  if (!Number.isInteger(q) || q < 0 || q > 100) throw new Error('Invalid percentile.');
  // position = (n - 1) * q / 100, kept as an exact fraction position = whole + rest / 100.
  const scaled = (sorted.length - 1) * q;
  const whole = Math.floor(scaled / 100);
  const rest = BigInt(scaled % 100);
  const low = sorted[whole]!;
  if (rest === 0n) return low;
  const high = sorted[whole + 1]!;
  // low + (high - low) * rest / 100, rounded half up, in integers.
  return low + ((high - low) * rest * 2n + 100n) / 200n;
};

export const sortValues = (values: readonly bigint[]): bigint[] =>
  [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

export interface PriceSource {
  readonly name: 'DANE-SIPSA' | 'TRACOP';
  readonly count: number;
  /** Most recent observation used. */
  readonly observedAt: Date;
}

export type PriceSuggestion =
  | {
      readonly status: 'ok';
      readonly low: bigint;
      readonly median: bigint;
      readonly high: bigint;
      readonly sources: readonly PriceSource[];
    }
  | { readonly status: 'insufficient_data' };

export interface Observation {
  readonly unitPrice: bigint;
  readonly observedAt: Date;
  /** Keyed hash of the provider: counts distinct providers without keeping who they are. */
  readonly providerKey: string;
}

export interface SuggestionRules {
  /** Minimum values in any aggregate (k-anonymity). */
  readonly minSample: number;
  /** Own observations are combined only from this many, and from two providers or more. */
  readonly minOwnObservations: number;
  readonly minOwnProviders: number;
}

const latest = (dates: readonly Date[]): Date =>
  new Date(Math.max(...dates.map((date) => date.getTime())));

/**
 * Reference prices plus own observations when there are enough of them (≥ minOwnObservations
 * from ≥ minOwnProviders providers); otherwise the reference alone. Fewer than minSample values
 * in the result → insufficient_data.
 */
export const suggestPrice = (
  reference: readonly { readonly price: bigint; readonly observedAt: Date }[],
  own: readonly Observation[],
  rules: SuggestionRules,
): PriceSuggestion => {
  const ownUsable =
    own.length >= rules.minOwnObservations &&
    new Set(own.map(({ providerKey }) => providerKey)).size >= rules.minOwnProviders;
  const values = [
    ...reference.map(({ price }) => price),
    ...(ownUsable ? own.map(({ unitPrice }) => unitPrice) : []),
  ];
  if (values.length < rules.minSample) return { status: 'insufficient_data' };
  const sorted = sortValues(values);
  const sources: PriceSource[] = [];
  if (reference.length)
    sources.push({
      name: 'DANE-SIPSA',
      count: reference.length,
      observedAt: latest(reference.map(({ observedAt }) => observedAt)),
    });
  if (ownUsable)
    sources.push({
      name: 'TRACOP',
      count: own.length,
      observedAt: latest(own.map(({ observedAt }) => observedAt)),
    });
  return {
    status: 'ok',
    low: percentile(sorted, 25),
    median: percentile(sorted, 50),
    high: percentile(sorted, 75),
    sources,
  };
};
