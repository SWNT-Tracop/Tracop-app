import { createHash } from 'node:crypto';
import { DomainError } from '../../../shared/kernel/domain-error.js';

export const RATEE_KINDS = ['provider', 'carrier'] as const;
export type RateeKind = (typeof RATEE_KINDS)[number];

export interface RatingProps {
  readonly id: string;
  readonly orderId: string;
  readonly raterId: string;
  readonly rateeId: string;
  readonly rateeKind: RateeKind;
  readonly score: number;
  /** Untrusted text: never logged, never public, hidden by staff if needed. */
  readonly comment: string | null;
  readonly createdAt: Date;
  readonly hiddenAt: Date | null;
}

/** A whole score from 1 to 5. */
export const validateScore = (score: number): number => {
  if (!Number.isInteger(score) || score < 1 || score > 5)
    throw new DomainError('La calificación debe ser un entero de 1 a 5.', 'invalid_score');
  return score;
};

/** Trimmed comment, null when empty; longer than maxLength is refused (0 disables comments). */
export const normalizeComment = (
  comment: string | null | undefined,
  maxLength: number,
): string | null => {
  const trimmed = comment?.trim() ?? '';
  if (!trimmed) return null;
  if (trimmed.length > maxLength)
    throw new DomainError(`El comentario supera ${maxLength} caracteres.`, 'comment_too_long');
  return trimmed;
};

/** Average in tenths, rounded half up, with integer arithmetic only (no floating point). */
export const averageTenths = (ratingSum: bigint, ratingsCount: bigint): bigint | null => {
  if (ratingsCount <= 0n) return null;
  return (ratingSum * 20n + ratingsCount) / (ratingsCount * 2n);
};

/** "4.3" from 43 tenths. */
export const formatTenths = (tenths: bigint): string => `${tenths / 10n}.${tenths % 10n}`;

/** The public average: null until the subject has at least minVisible ratings. */
export const visibleRating = (
  ratingSum: bigint,
  ratingsCount: bigint,
  minVisible: bigint,
): string | null => {
  if (ratingsCount < minVisible) return null;
  const tenths = averageTenths(ratingSum, ratingsCount);
  return tenths === null ? null : formatTenths(tenths);
};

/**
 * A stable order that says nothing about when each rating was made, so the ratee cannot match a
 * comment to an order by its position: sorted by a hash of the rating id.
 */
export const nonChronologicalOrder = <T extends { readonly id: string }>(
  items: readonly T[],
): T[] =>
  [...items]
    .map((item) => ({
      item,
      key: createHash('sha256').update(`trust.comment:${item.id}`).digest('hex'),
    }))
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(({ item }) => item);

/** Whether a delivered order can still be rated at `now`. */
export const withinRatingWindow = (deliveredAt: Date, now: Date, windowDays: number): boolean =>
  now.getTime() >= deliveredAt.getTime() &&
  now.getTime() <= deliveredAt.getTime() + windowDays * 86_400_000;
