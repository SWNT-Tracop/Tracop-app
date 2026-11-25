import type { DraftProduct, LotDraftProps } from '../domain/lot-draft.js';
import type { LotUnit } from '../domain/parsing.js';

// ---------------------------------------------------------------------------- LLM

export interface LLMRequest {
  readonly system: string;
  /** Untrusted user text, already delimited by the prompt builder. */
  readonly user: string;
  /** JSON Schema for the provider's structured output (additionalProperties: false). */
  readonly jsonSchema: Record<string, unknown>;
  readonly maxOutputTokens: number;
}

export type LLMFailure = 'timeout' | 'unavailable' | 'rejected' | 'refusal' | 'truncated';

export type LLMResult =
  | {
      readonly kind: 'ok';
      readonly text: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  | {
      readonly kind: 'error';
      readonly reason: LLMFailure;
      readonly inputTokens: number;
      readonly outputTokens: number;
    };

/** Structured generation only: the model gets no tools and cannot change any data. */
export interface LLMPort {
  complete(request: LLMRequest): Promise<LLMResult>;
}

// ---------------------------------------------------------------------- consent

export type AiConsentStatus = 'accepted' | 'withdrawn' | 'none';

/** Consent to process the user's messages with AI (Ley 1581), per version; append-only. */
export interface AiConsentPort {
  status(userId: string, version: string): Promise<AiConsentStatus>;
  accept(userId: string, version: string): Promise<void>;
  withdraw(userId: string, version: string): Promise<void>;
}

// -------------------------------------------------------------------- user data

export interface AssistantUser {
  readonly userId: string;
  readonly role: string;
  readonly active: boolean;
}

export interface ProviderLocation {
  readonly lat: number;
  readonly lng: number;
  readonly municipality: string;
}

export interface AssistantUserPort {
  /** The active user linked to this chat, or null. */
  byChannel(channel: string, channelUserId: string): Promise<AssistantUser | null>;
  /** The provider profile location, or null when there is no profile. */
  providerLocation(userId: string): Promise<ProviderLocation | null>;
}

// ---------------------------------------------------------------------- catalog

export interface CatalogCategory {
  readonly id: string;
  readonly name: string;
}

export interface DraftLotInput {
  readonly lotId: string;
  readonly product: DraftProduct;
  readonly quantityMilli: bigint;
  readonly unitPrice: bigint;
  readonly qualityGrade: string | null;
  readonly availableFrom: Date;
  readonly availableUntil: Date;
  readonly lat: number;
  readonly lng: number;
}

/** catalog's public use cases, adapted in bootstrap. The actor is always the draft's owner. */
export interface DraftCatalogPort {
  /** Approved products matching the words by tokens, plus the user's own pending proposals. */
  searchProducts(actorId: string, query: string, limit: number): Promise<readonly DraftProduct[]>;
  categories(): Promise<readonly CatalogCategory[]>;
  proposeProduct(
    actor: { readonly sub: string; readonly role: string },
    input: {
      readonly id: string;
      readonly name: string;
      readonly categoryId: string;
      readonly unit: LotUnit;
    },
  ): Promise<DraftProduct>;
  /**
   * Creates the lot with the draft's fixed id (idempotent) and publishes it unless `publish` is
   * false. Runs inside the caller's transaction.
   */
  createLot(
    actor: { readonly sub: string; readonly role: string },
    input: DraftLotInput,
    publish: boolean,
  ): Promise<{ readonly status: string }>;
}

// ---------------------------------------------------------------------- channel

export type AssistantButton = { readonly text: string; readonly action: string };

export interface ChannelRef {
  readonly channel: string;
  readonly channelUserId: string;
}

export interface AssistantChannelPort {
  send(
    to: ChannelRef,
    text: string,
    buttons?: readonly (readonly AssistantButton[])[],
  ): Promise<void>;
}

// ------------------------------------------------------------------------ price

export interface PriceSuggestion {
  readonly unitPrice: bigint;
  readonly source: string;
  readonly observedAt: Date;
}

/** Reference prices arrive in phase 8; until then the null adapter suggests nothing. */
export interface PriceSuggestionPort {
  suggest(productId: string, unit: LotUnit): Promise<PriceSuggestion | null>;
}

// ------------------------------------------------------------------ persistence

export type InboxPayload =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'action'; readonly action: string }
  | { readonly type: 'location'; readonly lat: number; readonly lng: number };

export interface InboxItem {
  readonly id: string;
  readonly channel: string;
  readonly channelUserId: string;
  readonly payload: InboxPayload;
  readonly receivedAt: Date;
  readonly attempts: number;
  readonly leaseToken: string;
}

export interface InboxRepository {
  /** Inserts the item and notifies the worker; runs in the webhook's transaction. */
  enqueue(item: {
    readonly id: string;
    readonly channel: string;
    readonly channelUserId: string;
    readonly payload: InboxPayload;
    readonly receivedAt: Date;
    readonly availableAt: Date;
  }): Promise<void>;
  /**
   * Leases the oldest item of a chat with no other leased item, so the messages of one person
   * are handled one at a time and in order.
   */
  leaseNext(now: Date, leaseSeconds: number): Promise<InboxItem | null>;
  /** Deletes the item (and with it the user's text) once handled. */
  complete(id: string, leaseToken: string): Promise<void>;
  /** Releases a failed item for a later attempt. */
  release(id: string, leaseToken: string, now: Date): Promise<void>;
  /** Drops items still failing after the attempt limit. */
  deleteExhausted(maxAttempts: number): Promise<number>;
}

export interface DraftRepository {
  /** The user's active draft (collecting or awaiting confirmation), locked for update. */
  findActive(userId: string): Promise<LotDraftProps | null>;
  findByShortCode(shortCode: number): Promise<LotDraftProps | null>;
  nextShortCode(): Promise<number>;
  insert(draft: LotDraftProps): Promise<void>;
  /** Saves when the stored version is `expectedVersion`; false otherwise. */
  update(draft: LotDraftProps, expectedVersion: number): Promise<boolean>;
  /** Marks active drafts past their expiry as expired and clears their fields. */
  expireDue(now: Date, limit: number): Promise<number>;
  /** Deletes finished drafts older than the cutoff. */
  purgeFinishedBefore(cutoff: Date, limit: number): Promise<number>;
  /** Serializes everything that touches one user's drafts in the current transaction. */
  lockUser(userId: string): Promise<void>;
}

export type UsageOutcome =
  | 'ok'
  | 'invalid_output'
  | 'timeout'
  | 'unavailable'
  | 'rejected'
  | 'refusal'
  | 'truncated'
  | 'budget_exhausted';

export interface UsageRecord {
  readonly id: string;
  readonly userId: string;
  readonly purpose: 'extract' | 'choose_product';
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly outcome: UsageOutcome;
  readonly at: Date;
}

export interface UsageRepository {
  record(usage: UsageRecord): Promise<void>;
  /** Model calls the user made on a Bogotá calendar day. */
  countForDay(userId: string, day: string): Promise<number>;
  /**
   * Atomically reserves tokens of the month's budget: true only when used + reserved + tokens
   * stays within the cap.
   */
  reserve(month: string, tokens: number, cap: number): Promise<boolean>;
  /** Replaces a reservation with the tokens really consumed. */
  settle(month: string, reserved: number, used: number): Promise<void>;
  purgeBefore(cutoff: Date, limit: number): Promise<number>;
}

export interface AssistantUnitOfWork {
  run<T>(operation: () => Promise<T>): Promise<T>;
}
