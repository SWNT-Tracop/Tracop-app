import { DomainError } from '../../../shared/kernel/domain-error.js';
import type { LotUnit, PriceBasis } from './parsing.js';

export const DRAFT_STATUSES = [
  'collecting',
  'awaiting_confirmation',
  'confirmed',
  'saved_as_draft',
  'cancelled',
  'expired',
] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const TERMINAL_STATUSES: readonly DraftStatus[] = [
  'confirmed',
  'saved_as_draft',
  'cancelled',
  'expired',
];

const TRANSITIONS: Readonly<Record<DraftStatus, readonly DraftStatus[]>> = {
  collecting: ['collecting', 'awaiting_confirmation', 'cancelled', 'expired'],
  awaiting_confirmation: [
    'collecting',
    'awaiting_confirmation',
    'confirmed',
    'saved_as_draft',
    'cancelled',
    'expired',
  ],
  confirmed: [],
  saved_as_draft: [],
  cancelled: [],
  expired: [],
};

/** The one thing the bot is asking right now. */
export const DRAFT_QUESTIONS = [
  'product',
  'product_choice',
  'product_proposal',
  'proposal_category',
  'quantity',
  'unit',
  'unit_mismatch',
  'price',
  'price_basis',
  'available_from',
  'available_until',
  'location',
  'quality',
  'edit_field',
] as const;
export type DraftQuestion = (typeof DRAFT_QUESTIONS)[number];

/** Fields the user can choose to edit from the confirmation. */
export const EDITABLE_FIELDS = [
  'product',
  'quantity',
  'price',
  'quality',
  'available_from',
  'available_until',
  'location',
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export interface DraftProduct {
  readonly id: string;
  readonly name: string;
  readonly unit: LotUnit;
  /** A product the user proposed that staff has not approved: the lot can only be a draft. */
  readonly pending: boolean;
}

export interface DraftLocation {
  readonly lat: number;
  readonly lng: number;
  readonly source: 'profile' | 'shared';
  /** For the confirmation text; coordinates are never shown in a chat. */
  readonly municipality: string | null;
}

export interface DraftFields {
  readonly productQuery?: string | undefined;
  readonly candidates?: readonly DraftProduct[] | undefined;
  readonly product?: DraftProduct | undefined;
  readonly proposalCategoryId?: string | undefined;
  readonly quantityMilli?: string | undefined; // bigint as text: the fields are stored as JSON
  readonly unit?: LotUnit | undefined;
  readonly priceAmount?: string | undefined;
  readonly priceBasis?: PriceBasis | undefined;
  readonly unitPrice?: string | undefined;
  readonly quality?: string | null | undefined;
  readonly availableFromDay?: string | undefined;
  readonly availableUntilDay?: string | undefined;
  readonly location?: DraftLocation | undefined;
  /** The user declined AI for this draft: the bot only asks guided questions. */
  readonly aiDeclined?: boolean | undefined;
}

export interface LotDraftProps {
  readonly id: string;
  /** Short number used in Telegram buttons (callback_data ≤ 64 bytes), never the UUID. */
  readonly shortCode: number;
  readonly userId: string;
  readonly status: DraftStatus;
  readonly version: number;
  readonly fields: DraftFields;
  readonly question: DraftQuestion | null;
  /** The lot id is fixed with the draft so a second Confirm creates nothing new. */
  readonly lotId: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export const isTerminal = (status: DraftStatus): boolean => TERMINAL_STATUSES.includes(status);

export const isExpired = (draft: LotDraftProps, now: Date): boolean =>
  !isTerminal(draft.status) && draft.expiresAt.getTime() <= now.getTime();

/**
 * Moves a draft to `to`. Terminal states drop every field (coordinates, product words,
 * prices): only the status and the lot id remain.
 */
export const transitionDraft = (
  draft: LotDraftProps,
  to: DraftStatus,
  now: Date,
  changes: { fields?: DraftFields; question?: DraftQuestion | null; ttlMs?: number } = {},
): LotDraftProps => {
  if (!TRANSITIONS[draft.status].includes(to))
    throw new DomainError('Ese borrador ya no se puede cambiar.', 'invalid_transition');
  const terminal = isTerminal(to);
  return {
    ...draft,
    status: to,
    version: draft.version + 1,
    fields: terminal ? {} : (changes.fields ?? draft.fields),
    question: terminal ? null : changes.question === undefined ? draft.question : changes.question,
    expiresAt:
      !terminal && changes.ttlMs !== undefined
        ? new Date(now.getTime() + changes.ttlMs)
        : draft.expiresAt,
    updatedAt: now,
  };
};

/**
 * The next missing piece, in the order a person would tell it. Quality is optional and never
 * asked; it can be added with «Editar».
 */
export const nextQuestion = (fields: DraftFields): DraftQuestion | null => {
  if (!fields.product) return fields.candidates?.length ? 'product_choice' : 'product';
  if (!fields.quantityMilli) return 'quantity';
  if (fields.unit && fields.unit !== fields.product.unit) return 'unit_mismatch';
  if (!fields.unitPrice) return fields.priceAmount && !fields.priceBasis ? 'price_basis' : 'price';
  if (!fields.availableFromDay) return 'available_from';
  if (!fields.availableUntilDay) return 'available_until';
  if (!fields.location) return 'location';
  return null;
};

export const newDraft = (input: {
  readonly id: string;
  readonly shortCode: number;
  readonly userId: string;
  readonly lotId: string;
  readonly now: Date;
  readonly ttlMs: number;
  readonly fields?: DraftFields;
}): LotDraftProps => ({
  id: input.id,
  shortCode: input.shortCode,
  userId: input.userId,
  status: 'collecting',
  version: 1,
  fields: input.fields ?? {},
  question: nextQuestion(input.fields ?? {}),
  lotId: input.lotId,
  expiresAt: new Date(input.now.getTime() + input.ttlMs),
  createdAt: input.now,
  updatedAt: input.now,
});
