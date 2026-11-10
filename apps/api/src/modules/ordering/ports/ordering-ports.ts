import type { OrderEvent, OrderLineProps, OrderProps } from '../domain/order.js';
import type { QuoteProps } from '../domain/quote.js';
import type { PricingConfiguration, QuoteAmounts } from '../domain/pricing.js';

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
}

export interface PricingPort {
  readonly configuration: PricingConfiguration;
  calculate(lines: readonly Pick<OrderLineProps, 'unitPrice' | 'quantityMilli'>[]): QuoteAmounts;
}

export interface OrderAggregate {
  readonly order: OrderProps;
  readonly lines: readonly OrderLineProps[];
  readonly quote: QuoteProps;
}

export interface OrderRepository {
  findById(id: string, lock?: boolean): Promise<OrderAggregate | null>;
  create(aggregate: OrderAggregate): Promise<void>;
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

export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');
export const ORDERING_UNIT_OF_WORK = Symbol('ORDERING_UNIT_OF_WORK');
export const ORDERING_CLOCK = Symbol('ORDERING_CLOCK');
export const PRICING_PORT = Symbol('PRICING_PORT');
export const LOT_QUOTE_PORT = Symbol('LOT_QUOTE_PORT');
export const LOT_RESERVATION_PORT = Symbol('LOT_RESERVATION_PORT');
export const ORDERING_RATE_LIMIT = Symbol('ORDERING_RATE_LIMIT');
