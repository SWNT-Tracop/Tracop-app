import type { OrderEvent, OrderLineProps, OrderProps } from '../domain/order.js';
import type { QuoteProps } from '../domain/quote.js';
import type { QuoteAmounts } from '../domain/pricing.js';

export interface LotQuoteSnapshot {
  readonly id: string;
  readonly providerId: string;
  readonly unit: string;
  readonly unitPrice: bigint;
  readonly availableUntil: Date;
  readonly status: string;
  readonly availableQuantityMilli: bigint;
}

export interface LotQuotePort {
  getQuote(lotId: string): Promise<LotQuoteSnapshot>;
}
export interface LotReservationPort {
  reserve(
    orderId: string,
    lines: readonly { lotId: string; quantityMilli: bigint }[],
    expiresAt: Date,
  ): Promise<void>;
  release(orderId: string): Promise<void>;
  findExpiredOrderIds(now: Date, limit: number): Promise<readonly string[]>;
  /** Keeps the reservation while a payment proof is reviewed; fails if it already lapsed. */
  hold(orderId: string): Promise<void>;
  /** Gives a held reservation an expiry again (rejected proof). */
  resumeExpiry(orderId: string, expiresAt: Date): Promise<void>;
  /** The payment was verified: the reserved stock is sold. */
  consume(orderId: string): Promise<void>;
  isExpired(orderId: string, now: Date): Promise<boolean>;
}

/** Quotes with the current commission and freight (run-time parameters, AGENTS §23). */
export interface PricingPort {
  calculate(
    lines: readonly Pick<OrderLineProps, 'unitPrice' | 'quantityMilli'>[],
  ): Promise<QuoteAmounts>;
}

export interface OrderAggregate {
  readonly order: OrderProps;
  readonly lines: readonly OrderLineProps[];
  readonly quote: QuoteProps;
}

export interface OrderRepository {
  findById(id: string, lock?: boolean): Promise<OrderAggregate | null>;
  create(aggregate: OrderAggregate, events: readonly OrderEvent[]): Promise<boolean>;
  save(aggregate: OrderAggregate, events: readonly OrderEvent[]): Promise<void>;
  listMine(
    buyerId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: readonly OrderAggregate[]; nextCursor?: string }>;
  listIncoming(
    providerId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: readonly OrderAggregate[]; nextCursor?: string }>;
  findExpiredQuoteIds(now: Date, limit: number): Promise<readonly string[]>;
  listByStatus?(status: OrderProps['status'], limit: number): Promise<readonly OrderAggregate[]>;
  metrics?(): Promise<OrderingMetrics>;
  /** When the order was delivered, from its OrderDelivered event; null if it was not. */
  findDeliveredAt?(orderId: string): Promise<Date | null>;
}

export interface OrderingMetrics {
  /** Orders per status (every status, zero included). */
  readonly byStatus: Readonly<Record<string, number>>;
  /** Sum of quote totals of orders paid or beyond (not cancelled, disputed or refunded). */
  readonly paidTotalCop: bigint;
}

export interface OrderingUnitOfWork {
  run<T>(operation: () => Promise<T>): Promise<T>;
}
export interface OrderingClock {
  now(): Date;
}
export interface OrderingRateLimit {
  consume(userId: string, action: string): void;
}

export interface ProviderPublicSummary {
  readonly displayName: string;
  readonly municipality: string;
  readonly department: string;
}

export interface ProviderDirectoryPort {
  getProviderPublicSummaries(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, ProviderPublicSummary>>;
}

export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');
export const ORDERING_UNIT_OF_WORK = Symbol('ORDERING_UNIT_OF_WORK');
export const ORDERING_CLOCK = Symbol('ORDERING_CLOCK');
export const PRICING_PORT = Symbol('PRICING_PORT');
export const LOT_QUOTE_PORT = Symbol('LOT_QUOTE_PORT');
export const LOT_RESERVATION_PORT = Symbol('LOT_RESERVATION_PORT');
export const ORDERING_RATE_LIMIT = Symbol('ORDERING_RATE_LIMIT');
export const ORDER_PROVIDER_DIRECTORY = Symbol('ORDER_PROVIDER_DIRECTORY');

/** Public trust of providers (verified badge, visible rating), from trust via bootstrap. */
export interface ProviderTrustSummary {
  readonly verified: boolean;
  readonly rating: string | null;
  readonly ratingsCount: number;
}

export interface ProviderTrustPort {
  /** At most 50 distinct ids per call; unknown providers come back unverified and unrated. */
  get(providerIds: readonly string[]): Promise<ReadonlyMap<string, ProviderTrustSummary>>;
}

export const ORDER_PROVIDER_TRUST = Symbol('ORDER_PROVIDER_TRUST');
