/** Why a lot is recommended; the codes are the source of truth, texts are the app's. */
export const REASONS = ['reorder', 'nearby', 'good_price', 'verified_provider', 'fresh'] as const;
export type Reason = (typeof REASONS)[number];

export type ReasonWeights = Readonly<Record<Reason, number>>;

export interface CandidateFacts {
  readonly lotId: string;
  readonly productId: string;
  readonly unitPrice: bigint;
  readonly availableFrom: Date;
  /** Integer kilometres from the buyer's point, when the buyer gave one. */
  readonly distanceKm: number | null;
  readonly providerVerified: boolean;
  /** Median of the product's suggested range for the lot's unit, when there is one. */
  readonly referenceMedian: bigint | null;
}

export interface ScoringContext {
  /** Products this buyer bought before (their own history only). */
  readonly purchasedProductIds: ReadonlySet<string>;
  readonly now: Date;
  readonly nearbyKm: number;
  readonly freshHours: number;
  readonly weights: ReasonWeights;
}

export interface ScoredLot {
  readonly lotId: string;
  readonly score: number;
  readonly reasons: readonly Reason[];
}

/** The reasons that hold for one lot, in the fixed REASONS order. */
export const reasonsFor = (lot: CandidateFacts, context: ScoringContext): Reason[] => {
  const holds: Record<Reason, boolean> = {
    reorder: context.purchasedProductIds.has(lot.productId),
    nearby: lot.distanceKm !== null && lot.distanceKm <= context.nearbyKm,
    good_price: lot.referenceMedian !== null && lot.unitPrice <= lot.referenceMedian,
    verified_provider: lot.providerVerified,
    fresh:
      lot.availableFrom.getTime() <= context.now.getTime() &&
      context.now.getTime() - lot.availableFrom.getTime() <= context.freshHours * 3_600_000,
  };
  return REASONS.filter((reason) => holds[reason]);
};

/** Score = sum of the weights of the reasons that hold. */
export const scoreLot = (lot: CandidateFacts, context: ScoringContext): ScoredLot => {
  const reasons = reasonsFor(lot, context);
  return {
    lotId: lot.lotId,
    score: reasons.reduce((sum, reason) => sum + context.weights[reason], 0),
    reasons,
  };
};

/** Highest score first; ties by lot id, so the order never depends on input order. */
export const compareScored = (left: ScoredLot, right: ScoredLot): number =>
  right.score - left.score || (left.lotId < right.lotId ? -1 : left.lotId > right.lotId ? 1 : 0);

/** True when `lot` comes strictly after the cursor position in that order. */
export const isAfter = (
  lot: ScoredLot,
  cursor: { readonly score: number; readonly lotId: string },
) => compareScored({ lotId: cursor.lotId, score: cursor.score, reasons: [] }, lot) < 0;

/** Lots without any reason are not recommendations. */
export const rank = (candidates: readonly CandidateFacts[], context: ScoringContext): ScoredLot[] =>
  candidates
    .map((lot) => scoreLot(lot, context))
    .filter(({ reasons }) => reasons.length > 0)
    .sort(compareScored);
