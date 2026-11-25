import { Inject, Injectable } from '@nestjs/common';
import { OUTBOX_WRITER } from '../../../shared/ports/outbox-writer.js';
import { PARAMETER_READER, type ParameterReader } from '../../../shared/ports/parameter-reader.js';
import type { OutboxWriter } from '../../../shared/ports/outbox-writer.js';
import { DomainError } from '../../../shared/kernel/domain-error.js';
import {
  Order,
  assertNoDuplicateLotLines,
  type OrderEvent,
  type OrderProps,
  type OrderLineProps,
} from '../domain/order.js';
import { Quote, type QuoteProps } from '../domain/quote.js';
import { hashOrderEvent } from '../domain/order-events.js';
import type {
  LotQuotePort,
  LotReservationPort,
  OrderAggregate,
  OrderRepository,
  OrderingMetrics,
  OrderingRateLimit,
  OrderingUnitOfWork,
  PricingPort,
  OrderingClock,
} from '../ports/ordering-ports.js';
import {
  LOT_QUOTE_PORT,
  LOT_RESERVATION_PORT,
  ORDER_REPOSITORY,
  ORDERING_RATE_LIMIT,
  ORDERING_UNIT_OF_WORK,
  PRICING_PORT,
  ORDERING_CLOCK,
} from '../ports/ordering-ports.js';
import { createId } from '../../../shared/kernel/ids.js';
import { createHash } from 'node:crypto';

type Actor = { readonly sub: string; readonly role: string };

export interface CreateOrderInput {
  readonly id: string;
  readonly buyerId: string;
  readonly lines: readonly { readonly lotId: string; readonly quantityMilli: bigint }[];
  readonly deliveryAddress: string;
  readonly deliveryWindow: string | null;
}

export interface AcceptQuoteInput {
  readonly actor: Actor;
  readonly orderId: string;
  readonly expectedVersion: number;
}

export interface CancelOrderInput {
  readonly actor: Actor;
  readonly orderId: string;
  readonly expectedVersion: number;
  readonly reason?: string;
}

export interface ExpireQuoteInput {
  readonly orderId: string;
  readonly now: Date;
}

export interface ExpireReservationInput {
  readonly orderId: string;
  readonly now: Date;
}

const enrichEventsWithHash = (events: readonly OrderEvent[]): readonly OrderEvent[] => {
  let previousHash: string | null = null;
  return events.map((event) => {
    const payload = { ...event.payload };
    const hash = hashOrderEvent(previousHash, payload);
    const enriched = {
      ...event,
      prevHash: previousHash,
      hash,
      payload: { ...payload, prevHash: previousHash, hash },
    };
    previousHash = hash;
    return enriched;
  });
};

/** Order states before payment, whose stock reservation can still lapse. */
const RESERVATION_EXPIRABLE_STATUSES: readonly OrderProps['status'][] = [
  'requested',
  'quoted',
  'accepted',
  'payment_pending',
];

@Injectable()
export class OrderingService {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orderRepository: OrderRepository,
    @Inject(LOT_QUOTE_PORT) private readonly lotQuotePort: LotQuotePort,
    @Inject(LOT_RESERVATION_PORT) private readonly lotReservationPort: LotReservationPort,
    @Inject(PRICING_PORT) private readonly pricingPort: PricingPort,
    @Inject(ORDERING_UNIT_OF_WORK) private readonly uow: OrderingUnitOfWork,
    @Inject(ORDERING_CLOCK) private readonly clock: OrderingClock,
    @Inject(ORDERING_RATE_LIMIT) private readonly rateLimit: OrderingRateLimit,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    @Inject(PARAMETER_READER) private readonly parameters: ParameterReader,
  ) {}

  async createOrder(actor: Actor, input: CreateOrderInput): Promise<OrderAggregate> {
    if (actor.role !== 'buyer')
      throw new DomainError('Solo el rol buyer puede crear pedidos.', 'invalid_role');
    assertNoDuplicateLotLines(input.lines);
    this.rateLimit.consume(actor.sub, 'create_order');

    const orderId = input.id;
    const requestHash = this.hashRequest(actor.sub, input);
    const existing = await this.orderRepository.findById(orderId);
    if (existing) {
      if (existing.order.buyerId !== actor.sub)
        throw new DomainError('El pedido ya existe.', 'idempotency_conflict');
      if (existing.order.requestHash !== requestHash)
        throw new DomainError(
          'El pedido ya existe con contenido distinto.',
          'idempotency_content_mismatch',
        );
      return existing;
    }

    return this.uow.run(async () => {
      const raced = await this.orderRepository.findById(orderId);
      if (raced) {
        if (raced.order.buyerId !== actor.sub)
          throw new DomainError('El pedido ya existe.', 'idempotency_conflict');
        if (raced.order.requestHash !== requestHash)
          throw new DomainError(
            'El pedido ya existe con contenido distinto.',
            'idempotency_content_mismatch',
          );
        return raced;
      }
      const now = this.clock.now();
      const lotQuotes = await Promise.all(
        input.lines.map(async (line) => {
          const quote = await this.lotQuotePort.getQuote(line.lotId);
          return { line, quote };
        }),
      );

      for (const { line, quote } of lotQuotes) {
        if (quote.status !== 'published' && quote.status !== 'reserved')
          throw new DomainError('Lote no disponible.', 'lot_unavailable');
        if (quote.availableUntil < now) throw new DomainError('Lote vencido.', 'lot_unavailable');
        if (quote.availableQuantityMilli < line.quantityMilli)
          throw new DomainError('No hay disponibilidad suficiente.', 'insufficient_stock');
      }

      const lineProps: OrderLineProps[] = [];
      const pricingLines: { unitPrice: bigint; quantityMilli: bigint }[] = [];
      for (const { line, quote } of lotQuotes) {
        const id = createId();
        lineProps.push({
          id,
          lotId: line.lotId,
          providerId: quote.providerId,
          quantityMilli: line.quantityMilli,
          unitPrice: quote.unitPrice,
          unit: quote.unit,
        });
        pricingLines.push({ unitPrice: quote.unitPrice, quantityMilli: line.quantityMilli });
      }

      if (new Set(lineProps.map((l) => l.providerId)).size !== 1)
        throw new DomainError(
          'Todas las líneas deben pertenecer al mismo proveedor.',
          'multiple_providers',
        );
      const providerId = lineProps[0]!.providerId;

      const quoteAmounts = await this.pricingPort.calculate(pricingLines);
      const quoteTtlHours = Number(await this.parameters.get('order.quote_ttl_hours'));
      const validUntil = new Date(now.getTime() + quoteTtlHours * 60 * 60 * 1000);
      const quoteId = createId();
      const quote: QuoteProps = {
        id: quoteId,
        orderId,
        ...quoteAmounts,
        validUntil,
        status: 'active',
      };

      const order: OrderProps = {
        id: orderId,
        buyerId: input.buyerId,
        providerId,
        status: 'draft',
        deliveryAddress: input.deliveryAddress,
        deliveryWindow: input.deliveryWindow,
        requestHash,
        createdAt: now,
        updatedAt: now,
        version: 1,
        acceptedAt: null,
        cancelReason: null,
      };

      const orderEntity = Order.create(order);
      orderEntity.transition('requested', now);
      orderEntity.transition('quoted', now);
      const orderEvents = orderEntity.drainEvents();

      const aggregate: OrderAggregate = {
        order: orderEntity.props,
        lines: lineProps,
        quote: Quote.create(quote).props,
      };
      const created = await this.orderRepository.create(aggregate, orderEvents);
      if (!created) {
        const raced = await this.orderRepository.findById(orderId);
        if (!raced)
          throw new DomainError('No fue posible crear el pedido.', 'idempotency_conflict');
        if (raced.order.buyerId !== actor.sub)
          throw new DomainError('El pedido ya existe.', 'idempotency_conflict');
        if (raced.order.requestHash !== requestHash)
          throw new DomainError(
            'El pedido ya existe con contenido distinto.',
            'idempotency_content_mismatch',
          );
        return raced;
      }
      await this.recordOrderEvents(orderEvents);

      return aggregate;
    });
  }

  async acceptQuote(input: AcceptQuoteInput): Promise<OrderAggregate> {
    return this.uow.run(async () => {
      const now = this.clock.now();
      const aggregate = await this.orderRepository.findById(input.orderId, true);
      // Only the buyer may accept; anyone else gets the same answer as for a missing order,
      // before any version or state check can reveal details of someone else's order.
      if (!aggregate || aggregate.order.buyerId !== input.actor.sub)
        throw new DomainError('Pedido no encontrado.', 'not_found');
      if (aggregate.order.version !== input.expectedVersion)
        throw new DomainError('Conflicto de versión.', 'version_conflict');
      if (aggregate.order.status !== 'quoted')
        throw new DomainError('El pedido no está cotizado.', 'invalid_transition');

      const quote = aggregate.quote;
      if (quote.validUntil < now)
        throw new DomainError('La cotización ha expirado.', 'quote_expired');

      for (const line of aggregate.lines) {
        const lotQuote = await this.lotQuotePort.getQuote(line.lotId);
        if (lotQuote.status !== 'published' && lotQuote.status !== 'reserved')
          throw new DomainError('Lote no disponible.', 'lot_unavailable');
        if (lotQuote.availableUntil < now)
          throw new DomainError('Lote vencido.', 'lot_unavailable');
        if (lotQuote.availableQuantityMilli < line.quantityMilli)
          throw new DomainError('No hay disponibilidad suficiente.', 'insufficient_stock');
      }

      const orderEntity = Order.reconstitute(aggregate.order);
      orderEntity.transition('accepted', now, { actorId: input.actor.sub });
      const orderEvents = orderEntity.drainEvents();
      const enrichedEvents = enrichEventsWithHash(orderEvents);

      const updatedAggregate: OrderAggregate = {
        order: orderEntity.props,
        lines: aggregate.lines,
        quote: { ...quote, status: 'accepted' },
      };
      const reservationTtlHours = Number(await this.parameters.get('order.reservation_ttl_hours'));
      const reservationExpiresAt = new Date(now.getTime() + reservationTtlHours * 60 * 60 * 1000);
      await this.lotReservationPort.reserve(
        input.orderId,
        aggregate.lines.map((line) => ({
          lotId: line.lotId,
          quantityMilli: line.quantityMilli,
        })),
        reservationExpiresAt,
      );
      await this.orderRepository.save(updatedAggregate, enrichedEvents);
      await this.recordOrderEvents(orderEvents);

      return updatedAggregate;
    });
  }

  async cancelOrder(input: CancelOrderInput): Promise<OrderAggregate> {
    return this.uow.run(async () => {
      const now = this.clock.now();
      const aggregate = await this.orderRepository.findById(input.orderId, true);
      const isBuyer = aggregate?.order.buyerId === input.actor.sub;
      const isProvider = aggregate?.order.providerId === input.actor.sub;
      // A third party gets not_found before any version or state check (no information leak).
      if (!aggregate || (!isBuyer && !isProvider))
        throw new DomainError('Pedido no encontrado.', 'not_found');
      if (aggregate.order.version !== input.expectedVersion)
        throw new DomainError('Conflicto de versión.', 'version_conflict');
      if (!['requested', 'quoted', 'accepted', 'payment_pending'].includes(aggregate.order.status))
        throw new DomainError(
          'El pedido no se puede cancelar en su estado actual.',
          'invalid_transition',
        );

      const orderEntity = Order.reconstitute(aggregate.order);
      orderEntity.transition('cancelled', now, {
        reason: input.reason ?? (isBuyer ? 'buyer_cancelled' : 'provider_cancelled'),
        actorId: input.actor.sub,
      });
      const orderEvents = orderEntity.drainEvents();
      const enrichedEvents = enrichEventsWithHash(orderEvents);

      const updatedAggregate: OrderAggregate = {
        order: orderEntity.props,
        lines: aggregate.lines,
        quote: { ...aggregate.quote, status: 'cancelled' },
      };
      await this.orderRepository.save(updatedAggregate, enrichedEvents);
      await this.lotReservationPort.release(input.orderId);
      await this.recordOrderEvents(orderEvents);

      return updatedAggregate;
    });
  }

  async expireQuote(input: ExpireQuoteInput): Promise<boolean> {
    return this.uow.run(async () => {
      const aggregate = await this.orderRepository.findById(input.orderId, true);
      if (!aggregate) return false;
      if (aggregate.order.status !== 'quoted') return false;
      if (aggregate.quote.validUntil >= input.now) return false;

      const orderEntity = Order.reconstitute(aggregate.order);
      orderEntity.transition('cancelled', input.now, { reason: 'expired' });
      const orderEvents = orderEntity.drainEvents();
      const enrichedEvents = enrichEventsWithHash(orderEvents);

      const updatedAggregate: OrderAggregate = {
        order: orderEntity.props,
        lines: aggregate.lines,
        quote: { ...aggregate.quote, status: 'expired' },
      };
      await this.orderRepository.save(updatedAggregate, enrichedEvents);
      await this.lotReservationPort.release(input.orderId);
      await this.recordOrderEvents(orderEvents);

      return true;
    });
  }

  async expireReservation(input: ExpireReservationInput): Promise<boolean> {
    return this.uow.run(async () => {
      const aggregate = await this.orderRepository.findById(input.orderId, true);
      if (!aggregate) return false;
      // Stock is reserved when the quote is accepted and held for ORDER_RESERVATION_TTL_HOURS;
      // an order not paid by then gives the stock back. Paid orders keep their reservation.
      if (!RESERVATION_EXPIRABLE_STATUSES.includes(aggregate.order.status)) return false;
      // Re-check under the order lock: a payment proof may have held the reservation (it no
      // longer lapses) after the expiry job listed this order.
      if (!(await this.lotReservationPort.isExpired(input.orderId, input.now))) return false;

      const orderEntity = Order.reconstitute(aggregate.order);
      orderEntity.transition('cancelled', input.now, { reason: 'reservation_expired' });
      const orderEvents = orderEntity.drainEvents();

      const updatedAggregate: OrderAggregate = {
        order: orderEntity.props,
        lines: aggregate.lines,
        quote: { ...aggregate.quote, status: 'cancelled' },
      };
      await this.orderRepository.save(updatedAggregate, orderEvents);
      await this.lotReservationPort.release(input.orderId);
      await this.recordOrderEvents(orderEvents);

      return true;
    });
  }

  /** Order data for payments; payments checks who may act on it. */
  async getForPayment(orderId: string): Promise<OrderAggregate | null> {
    return this.orderRepository.findById(orderId);
  }

  /**
   * The buyer chose how to pay: an accepted order moves to payment_pending (a new payment
   * after a rejected proof finds it there already). The reservation must still be live.
   */
  async startPayment(orderId: string, actorId: string): Promise<OrderAggregate> {
    return this.mutateForPayment(orderId, async (aggregate, order, now) => {
      if (aggregate.order.buyerId !== actorId)
        throw new DomainError('Pedido no encontrado.', 'not_found');
      if (await this.lotReservationPort.isExpired(orderId, now))
        throw new DomainError('La reserva del pedido ya venció.', 'reservation_expired');
      if (aggregate.order.status === 'payment_pending') return false;
      if (aggregate.order.status !== 'accepted')
        throw new DomainError('El pedido no admite pagos en su estado.', 'invalid_transition');
      order.transition('payment_pending', now, { actorId });
      return true;
    });
  }

  /** A payment proof was uploaded: its order keeps the stock while it is reviewed. */
  async holdStockForPaymentReview(orderId: string): Promise<void> {
    await this.mutateForPayment(orderId, async (aggregate) => {
      this.requirePaymentPending(aggregate);
      await this.lotReservationPort.hold(orderId);
      return false;
    });
  }

  /** A payment proof was rejected: the reservation lapses again at `expiresAt`. */
  async resumeStockExpiry(orderId: string, expiresAt: Date): Promise<void> {
    await this.mutateForPayment(orderId, async (aggregate) => {
      this.requirePaymentPending(aggregate);
      await this.lotReservationPort.resumeExpiry(orderId, expiresAt);
      return false;
    });
  }

  /** The payment was verified: the order is paid and its reserved stock is sold. */
  async markPaid(orderId: string, actorId: string): Promise<OrderAggregate> {
    return this.mutateForPayment(orderId, async (aggregate, order, now) => {
      this.requirePaymentPending(aggregate);
      order.transition('paid', now, { actorId });
      await this.lotReservationPort.consume(orderId);
      return true;
    });
  }

  /** The buyer disputed a paid order; logistics and settlement stop. */
  async markDisputed(orderId: string, actorId: string): Promise<OrderAggregate> {
    return this.mutateForPayment(orderId, async (_aggregate, order, now) => {
      order.transition('disputed', now, { actorId });
      return true;
    });
  }

  /** Settled, or a dispute was resolved: the order is closed for good. */
  async closeOrder(orderId: string, actorId: string | null): Promise<OrderAggregate> {
    return this.mutateForPayment(orderId, async (_aggregate, order, now) => {
      order.transition('closed', now, actorId ? { actorId } : {});
      return true;
    });
  }

  /**
   * Delivery address and lots of an order, for logistics to show the assigned carrier and staff
   * where to go. Not exposed by any controller; logistics decides who may see it.
   */
  async getDeliveryDetails(
    orderId: string,
  ): Promise<{ readonly deliveryAddress: string; readonly lotIds: readonly string[] } | null> {
    const aggregate = await this.orderRepository.findById(orderId);
    if (!aggregate) return null;
    return {
      deliveryAddress: aggregate.order.deliveryAddress,
      lotIds: [...new Set(aggregate.lines.map((line) => line.lotId))],
    };
  }

  /**
   * Who took part in an order and when it was delivered (from its OrderDelivered event), for
   * trust to decide who may rate whom. Not exposed by any controller.
   */
  async getDeliveryRecord(orderId: string): Promise<{
    readonly buyerId: string;
    readonly providerId: string;
    readonly status: OrderProps['status'];
    readonly deliveryWindow: Date | null;
    readonly deliveredAt: Date | null;
  } | null> {
    const aggregate = await this.orderRepository.findById(orderId);
    if (!aggregate) return null;
    const window = aggregate.order.deliveryWindow;
    return {
      buyerId: aggregate.order.buyerId,
      providerId: aggregate.order.providerId,
      status: aggregate.order.status,
      deliveryWindow: window ? new Date(window) : null,
      deliveredAt: (await this.orderRepository.findDeliveredAt?.(orderId)) ?? null,
    };
  }

  /** Backoffice metrics (aggregates only, no personal data). */
  async metrics(): Promise<OrderingMetrics> {
    if (!this.orderRepository.metrics) throw new Error('metrics_unavailable');
    return this.orderRepository.metrics();
  }

  async listMine(
    buyerId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: readonly OrderAggregate[]; nextCursor?: string }> {
    return this.orderRepository.listMine(buyerId, cursor, limit);
  }

  async listIncoming(
    providerId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: readonly OrderAggregate[]; nextCursor?: string }> {
    return this.orderRepository.listIncoming(providerId, cursor, limit);
  }

  async expireReservations(now: Date, limit: number): Promise<number> {
    const expiredOrderIds = await this.lotReservationPort.findExpiredOrderIds(now, limit);
    let count = 0;
    for (const orderId of expiredOrderIds) {
      const didExpire = await this.expireReservation({ orderId, now });
      if (didExpire) count += 1;
    }
    return count;
  }

  /** Orders whose active quote is past its validity, for the expiry job. */
  async getExpiredQuoteIds(now: Date, limit: number): Promise<readonly string[]> {
    return this.orderRepository.findExpiredQuoteIds(now, limit);
  }

  async getById(actor: Actor, orderId: string): Promise<OrderAggregate | null> {
    const aggregate = await this.orderRepository.findById(orderId);
    if (!aggregate) return null;
    const isBuyer = actor.sub === aggregate.order.buyerId;
    const isProvider = actor.sub === aggregate.order.providerId;
    if (!isBuyer && !isProvider) {
      throw new DomainError('Pedido no encontrado.', 'not_found');
    }
    return aggregate;
  }

  /** Consulta usada por logistics; la propiedad del viaje se valida en ese módulo. */
  async listForLogistics(
    actor: Actor,
    status: 'paid',
    limit: number,
  ): Promise<readonly OrderAggregate[]> {
    this.requireLogisticsRole(actor);
    if (!this.orderRepository.listByStatus) return [];
    return this.orderRepository.listByStatus(status, limit);
  }

  /** Consulta usada por logistics; la propiedad del viaje se valida en ese módulo. */
  async getForLogistics(actor: Actor, orderId: string): Promise<OrderAggregate | null> {
    this.requireLogisticsRole(actor);
    return this.orderRepository.findById(orderId);
  }

  async transitionForLogistics(
    actor: Actor,
    orderId: string,
    expectedVersion: number,
    next: 'pickup_scheduled' | 'in_transit' | 'delivered',
  ): Promise<OrderAggregate> {
    this.requireLogisticsRole(actor);
    return this.uow.run(async () => {
      const now = this.clock.now();
      const aggregate = await this.orderRepository.findById(orderId, true);
      if (!aggregate) throw new DomainError('Pedido no encontrado.', 'not_found');
      if (aggregate.order.version !== expectedVersion)
        throw new DomainError('Conflicto de versión.', 'version_conflict');
      const order = Order.reconstitute(aggregate.order);
      order.transition(next, now, { actorId: actor.sub });
      const events = order.drainEvents();
      const enriched = enrichEventsWithHash(events);
      const updated: OrderAggregate = {
        order: order.props,
        lines: aggregate.lines,
        quote: aggregate.quote,
      };
      await this.orderRepository.save(updated, enriched);
      await this.recordOrderEvents(events);
      return updated;
    });
  }

  private requirePaymentPending(aggregate: OrderAggregate): void {
    if (aggregate.order.status !== 'payment_pending')
      throw new DomainError('El pedido no está pendiente de pago.', 'invalid_transition');
  }

  /**
   * Locks the order, lets `change` decide whether it transitions (returning true), and saves
   * the transition with its hash-chained events. Runs inside the caller's transaction.
   */
  private async mutateForPayment(
    orderId: string,
    change: (aggregate: OrderAggregate, order: Order, now: Date) => Promise<boolean>,
  ): Promise<OrderAggregate> {
    return this.uow.run(async () => {
      const now = this.clock.now();
      const aggregate = await this.orderRepository.findById(orderId, true);
      if (!aggregate) throw new DomainError('Pedido no encontrado.', 'not_found');
      const order = Order.reconstitute(aggregate.order);
      if (!(await change(aggregate, order, now))) return aggregate;
      const events = order.drainEvents();
      const updated: OrderAggregate = {
        order: order.props,
        lines: aggregate.lines,
        quote: aggregate.quote,
      };
      await this.orderRepository.save(updated, enrichEventsWithHash(events));
      await this.recordOrderEvents(events);
      return updated;
    });
  }

  private requireLogisticsRole(actor: Actor): void {
    if (actor.role !== 'carrier' && actor.role !== 'operator')
      throw new DomainError('Rol no autorizado.', 'invalid_role');
  }

  private hashRequest(buyerId: string, input: CreateOrderInput): string {
    const normalized = {
      buyerId,
      lines: [...input.lines]
        .sort((a, b) => a.lotId.localeCompare(b.lotId))
        .map((l) => ({ lotId: l.lotId, quantityMilli: l.quantityMilli.toString() })),
      deliveryAddress: input.deliveryAddress.trim(),
      deliveryWindow: input.deliveryWindow,
    };
    return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  }

  private async recordOrderEvents(
    events: readonly {
      type: string;
      orderId: string;
      occurredAt: string;
      payload: Record<string, unknown>;
    }[],
  ): Promise<void> {
    if (events.length === 0) return;
    await this.outbox.append(
      events.map((event) => ({
        aggregate: `order:${event.orderId}`,
        type: event.type,
        payload: {
          ...event.payload,
          hash: event.payload.hash ?? hashOrderEvent(null, event.payload),
        },
      })),
    );
  }
}

export const orderingServiceProvider = {
  provide: 'ORDERING_SERVICE',
  useClass: OrderingService,
};
