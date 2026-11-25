import type { RateeKind, RatingProps } from '../domain/rating.js';
import type { VerificationProps, VerificationStatus } from '../domain/verification.js';

/** What trust needs to know about an order, from ordering, logistics and payments (bootstrap). */
export interface OrderDeliveryInfo {
  readonly orderId: string;
  readonly buyerId: string;
  readonly providerId: string;
  /** The carrier of the completed delivery stop, null if staff marked it delivered. */
  readonly carrierId: string | null;
  readonly deliveredAt: Date | null;
  readonly deliveryWindow: Date | null;
  readonly paymentVerified: boolean;
}

export interface OrderDeliveryInfoPort {
  get(orderId: string): Promise<OrderDeliveryInfo | null>;
}

export interface ReputationTotals {
  readonly ratingSum: bigint;
  readonly ratingsCount: bigint;
}

export interface CarrierDeliveryStats {
  readonly deliveredCount: number;
  readonly withWindowCount: number;
  readonly onTimeCount: number;
}

export interface TrustRepository {
  findRating(id: string): Promise<RatingProps | null>;
  /** Inserts unless the id or (order, ratee kind) exists; returns whether it inserted. */
  insertRating(rating: RatingProps): Promise<boolean>;
  /** Atomic `rating_sum + score`, `ratings_count + 1` (no recount). */
  addToReputation(subjectId: string, kind: RateeKind, score: number, now: Date): Promise<void>;
  reputations(
    subjectIds: readonly string[],
    kind: RateeKind,
  ): Promise<ReadonlyMap<string, ReputationTotals>>;
  /** Visible (not hidden) comments of a subject. */
  visibleComments(subjectId: string, kind: RateeKind): Promise<readonly RatingProps[]>;
  ratingsOf(subjectId: string): Promise<readonly RatingProps[]>;
  hideComment(id: string, staffId: string, now: Date): Promise<RatingProps | null>;
  /** Counts the order once; returns false if it was counted already. */
  countDelivery(
    orderId: string,
    carrierId: string,
    withWindow: boolean,
    onTime: boolean,
    now: Date,
  ): Promise<boolean>;
  carrierStats(carrierId: string): Promise<CarrierDeliveryStats | null>;
  findVerification(providerId: string, lock?: boolean): Promise<VerificationProps | null>;
  saveVerification(verification: VerificationProps): Promise<void>;
  verifiedProviders(providerIds: readonly string[]): Promise<ReadonlySet<string>>;
  listVerifications(
    status: VerificationStatus,
    limit: number,
  ): Promise<readonly VerificationProps[]>;
}

export interface TrustRateLimitPort {
  consume(key: string, now: Date): void;
}

export interface TrustUnitOfWork {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export interface TrustClock {
  now(): Date;
}

export const ORDER_DELIVERY_INFO_PORT = Symbol('ORDER_DELIVERY_INFO_PORT');
export const TRUST_CLOCK = Symbol('TRUST_CLOCK');
export const TRUST_REPOSITORY = Symbol('TRUST_REPOSITORY');
export const TRUST_RATING_RATE_LIMIT = Symbol('TRUST_RATING_RATE_LIMIT');
export const TRUST_VERIFICATION_RATE_LIMIT = Symbol('TRUST_VERIFICATION_RATE_LIMIT');
