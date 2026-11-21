import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../../shared/infra/database.js';
import type { OrderAggregate, OrderRepository, PricingPort } from '../../ports/ordering-ports.js';
import type { OrderEvent, OrderLineProps, OrderProps } from '../../domain/order.js';
import type { PricingConfiguration, QuoteAmounts } from '../../domain/pricing.js';
import type { QuoteProps } from '../../domain/quote.js';
import { createId } from '../../../../shared/kernel/ids.js';
import { orders, orderLines, quotes, orderEvents } from './drizzle-schema.js';
import { calculateQuoteAmounts } from '../../domain/pricing.js';
import { hashOrderEvent } from '../../domain/order-events.js';

const toOrderProps = (row: typeof orders.$inferSelect): OrderProps => ({
  id: row.id,
  buyerId: row.buyerId,
  providerId: row.providerId,
  status: row.status as OrderProps['status'],
  deliveryAddress: row.deliveryAddress,
  deliveryWindow: row.deliveryWindow?.toISOString() ?? null,
  requestHash: row.requestHash,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  version: row.version,
  acceptedAt: row.acceptedAt ?? null,
  cancelReason: row.cancelReason ?? null,
});

const parseMilli = (value: string): bigint => {
  // numeric(12,3) from PostgreSQL comes as string like "1000.000"
  const [whole, frac] = value.split('.');
  const fraction = (frac ?? '').padEnd(3, '0').slice(0, 3);
  if (fraction === '000') return BigInt(whole ?? '0');
  return BigInt(whole ?? '0') * 1000n + BigInt(fraction);
};

const toLineProps = (row: typeof orderLines.$inferSelect): OrderLineProps => ({
  id: row.id,
  lotId: row.lotId,
  providerId: row.providerId,
  quantityMilli: parseMilli(row.quantityMilli),
  unitPrice: BigInt(row.unitPrice),
  unit: row.unit,
});

const toQuoteProps = (row: typeof quotes.$inferSelect): QuoteProps => ({
  id: row.id,
  orderId: row.orderId,
  subtotal: BigInt(row.subtotal),
  freight: BigInt(row.freight),
  commission: BigInt(row.commission),
  total: BigInt(row.total),
  providerNet: BigInt(row.providerNet),
  validUntil: row.validUntil,
  status: row.status as QuoteProps['status'],
});

@Injectable()
export class DrizzleOrderRepository implements OrderRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async findById(id: string, lock = false): Promise<OrderAggregate | null> {
    const db = this.database.current();
    const query = db
      .select()
      .from(orders)
      .where(and(eq(orders.id, id), isNull(orders.deletedAt) ?? sql`true`));
    const [orderRow] = await (lock ? query.for('update') : query);
    if (!orderRow) return null;
    const lineRows = await db.select().from(orderLines).where(eq(orderLines.orderId, id));
    const [quoteRow] = await db.select().from(quotes).where(eq(quotes.orderId, id));
    return {
      order: toOrderProps(orderRow),
      lines: lineRows.map(toLineProps),
      quote: quoteRow ? toQuoteProps(quoteRow) : null!,
    };
  }

  async create(aggregate: OrderAggregate, events: readonly OrderEvent[]): Promise<boolean> {
    const db = this.database.current();
    const [inserted] = await db
      .insert(orders)
      .values({
        id: aggregate.order.id,
        buyerId: aggregate.order.buyerId,
        providerId: aggregate.order.providerId,
        status: aggregate.order.status,
        deliveryAddress: aggregate.order.deliveryAddress,
        deliveryWindow: aggregate.order.deliveryWindow
          ? new Date(aggregate.order.deliveryWindow)
          : null,
        requestHash: aggregate.order.requestHash,
        createdAt: aggregate.order.createdAt,
        updatedAt: aggregate.order.updatedAt,
        version: aggregate.order.version,
        acceptedAt: aggregate.order.acceptedAt ? new Date(aggregate.order.acceptedAt) : null,
        cancelReason: aggregate.order.cancelReason,
      })
      .onConflictDoNothing()
      .returning({ id: orders.id });
    if (!inserted) return false;
    await db.insert(orderLines).values(
      aggregate.lines.map((line) => ({
        id: line.id,
        orderId: aggregate.order.id,
        lotId: line.lotId,
        providerId: line.providerId,
        quantityMilli: line.quantityMilli.toString(),
        unitPrice: line.unitPrice.toString(),
        unit: line.unit,
      })),
    );
    if (aggregate.quote) {
      await db.insert(quotes).values({
        id: aggregate.quote.id,
        orderId: aggregate.order.id,
        subtotal: aggregate.quote.subtotal.toString(),
        freight: aggregate.quote.freight.toString(),
        commission: aggregate.quote.commission.toString(),
        total: aggregate.quote.total.toString(),
        providerNet: aggregate.quote.providerNet.toString(),
        validUntil: aggregate.quote.validUntil,
        status: aggregate.quote.status,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    if (events.length) {
      let previousHash: string | null = null;
      await db.insert(orderEvents).values(
        events.map((event) => {
          const hash = hashOrderEvent(previousHash, event.payload);
          const payload = { ...event.payload, prevHash: previousHash, hash };
          const row = {
            id: createId(),
            orderId: event.orderId,
            type: event.type,
            payload: JSON.stringify(payload),
            actorId: aggregate.order.buyerId,
            occurredAt: new Date(event.occurredAt),
            prevHash: previousHash,
            hash,
          };
          previousHash = hash;
          return row;
        }),
      );
    }
    return true;
  }

  async save(aggregate: OrderAggregate, events: readonly OrderEvent[]): Promise<void> {
    const db = this.database.current();
    await db
      .update(orders)
      .set({
        status: aggregate.order.status,
        updatedAt: aggregate.order.updatedAt,
        version: aggregate.order.version,
        acceptedAt: aggregate.order.acceptedAt ? new Date(aggregate.order.acceptedAt) : null,
        cancelReason: aggregate.order.cancelReason,
      })
      .where(eq(orders.id, aggregate.order.id));
    if (events.length) {
      const [lastEvent] = await db
        .select({ hash: orderEvents.hash })
        .from(orderEvents)
        .where(eq(orderEvents.orderId, aggregate.order.id))
        .orderBy(desc(orderEvents.occurredAt), desc(orderEvents.id))
        .limit(1);
      let previousHash = lastEvent?.hash ?? null;
      await db.insert(orderEvents).values(
        events.map((event) => {
          const hash = hashOrderEvent(previousHash, event.payload);
          const payload = { ...event.payload, prevHash: previousHash, hash };
          const row = {
            id: createId(),
            orderId: event.orderId,
            type: event.type,
            payload: JSON.stringify(payload),
            actorId: (event.payload.actorId as string | undefined) ?? aggregate.order.buyerId,
            occurredAt: new Date(event.occurredAt),
            prevHash: previousHash,
            hash,
          };
          previousHash = hash;
          return row;
        }),
      );
    }
  }

  async listMine(
    buyerId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: readonly OrderAggregate[]; nextCursor?: string }> {
    const db = this.database.current();
    const where = cursor
      ? and(eq(orders.buyerId, buyerId), lt(orders.id, cursor))
      : eq(orders.buyerId, buyerId);
    const orderRows = await db
      .select()
      .from(orders)
      .where(and(where, isNull(orders.deletedAt) ?? sql`true`))
      .orderBy(desc(orders.id))
      .limit(limit + 1);
    const items = orderRows.slice(0, limit);
    const aggregates = await Promise.all(
      items.map(async (orderRow: typeof orders.$inferSelect) => {
        const lineRows = await db
          .select()
          .from(orderLines)
          .where(eq(orderLines.orderId, orderRow.id));
        const [quoteRow] = await db.select().from(quotes).where(eq(quotes.orderId, orderRow.id));
        return {
          order: toOrderProps(orderRow),
          lines: lineRows.map(toLineProps),
          quote: quoteRow ? toQuoteProps(quoteRow) : null!,
        };
      }),
    );
    const nextCursor = orderRows.length > limit ? items[items.length - 1]?.id : undefined;
    return nextCursor ? { items: aggregates, nextCursor } : { items: aggregates };
  }

  async listIncoming(
    providerId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: readonly OrderAggregate[]; nextCursor?: string }> {
    const db = this.database.current();
    const where = cursor
      ? and(
          eq(orders.providerId, providerId),
          gt(orders.acceptedAt ?? sql`null`, new Date(0)),
          lt(orders.id, cursor),
        )
      : and(eq(orders.providerId, providerId), gt(orders.acceptedAt ?? sql`null`, new Date(0)));
    const orderRows = await db
      .select()
      .from(orders)
      .where(and(where, isNull(orders.deletedAt) ?? sql`true`))
      .orderBy(desc(orders.id))
      .limit(limit + 1);
    const items = orderRows.slice(0, limit);
    const aggregates = await Promise.all(
      items.map(async (orderRow: typeof orders.$inferSelect) => {
        const lineRows = await db
          .select()
          .from(orderLines)
          .where(eq(orderLines.orderId, orderRow.id));
        const [quoteRow] = await db.select().from(quotes).where(eq(quotes.orderId, orderRow.id));
        return {
          order: toOrderProps(orderRow),
          lines: lineRows.map(toLineProps),
          quote: quoteRow ? toQuoteProps(quoteRow) : null!,
        };
      }),
    );
    const nextCursor = orderRows.length > limit ? items[items.length - 1]?.id : undefined;
    return nextCursor ? { items: aggregates, nextCursor } : { items: aggregates };
  }

  async listByStatus(
    status: OrderProps['status'],
    limit: number,
  ): Promise<readonly OrderAggregate[]> {
    const db = this.database.current();
    const orderRows = await db
      .select()
      .from(orders)
      .where(and(eq(orders.status, status), isNull(orders.deletedAt) ?? sql`true`))
      .orderBy(asc(orders.createdAt))
      .limit(limit);
    return Promise.all(
      orderRows.map(async (orderRow) => {
        const lineRows = await db
          .select()
          .from(orderLines)
          .where(eq(orderLines.orderId, orderRow.id));
        const [quoteRow] = await db.select().from(quotes).where(eq(quotes.orderId, orderRow.id));
        return {
          order: toOrderProps(orderRow),
          lines: lineRows.map(toLineProps),
          quote: quoteRow ? toQuoteProps(quoteRow) : null!,
        };
      }),
    );
  }

  async findExpiredQuoteIds(now: Date, limit: number): Promise<readonly string[]> {
    const db = this.database.current();
    const rows = await db
      .select({ orderId: quotes.orderId })
      .from(quotes)
      .where(and(eq(quotes.status, 'active'), lt(quotes.validUntil, now)))
      .orderBy(asc(quotes.validUntil))
      .limit(limit);
    return rows.map((r) => r.orderId);
  }
}

@Injectable()
export class EnvPricingPort implements PricingPort {
  readonly configuration: PricingConfiguration;
  constructor(
    @Inject('ORDER_COMMISSION_RATE_BPS') commissionRateBps: bigint,
    @Inject('ORDER_FREIGHT_COP') freightCop: bigint,
    @Inject('ORDER_SUBTOTAL_ROUNDING') subtotalRounding: 'half_up' | 'floor' | 'ceil',
  ) {
    this.configuration = { commissionRateBps, freightCop, subtotalRounding };
  }

  calculate(lines: readonly Pick<OrderLineProps, 'unitPrice' | 'quantityMilli'>[]): QuoteAmounts {
    return calculateQuoteAmounts(lines, this.configuration);
  }
}

import { PRICING_PORT } from '../../ports/ordering-ports.js';

export const envPricingPortProvider = {
  provide: PRICING_PORT,
  useFactory: (
    commissionRateBps: bigint,
    freightCop: bigint,
    subtotalRounding: 'half_up' | 'floor' | 'ceil',
  ) => new EnvPricingPort(commissionRateBps, freightCop, subtotalRounding),
  inject: ['ORDER_COMMISSION_RATE_BPS', 'ORDER_FREIGHT_COP', 'ORDER_SUBTOTAL_ROUNDING'],
};
