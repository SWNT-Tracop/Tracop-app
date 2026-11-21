import { Inject, Injectable } from '@nestjs/common';
import { OUTBOX_WRITER } from '../../../shared/infra/tokens.js';
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
    @Inject('ORDER_QUOTE_TTL_HOURS') private readonly quoteTtlHours: number,
    @Inject('ORDER_RESERVATION_TTL_HOURS') private readonly reservationTtlHours: number,
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

      const quoteAmounts = this.pricingPort.calculate(pricingLines);
      const validUntil = new Date(now.getTime() + this.quoteTtlHours * 60 * 60 * 1000);
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
      if (!aggregate) throw new DomainError('Pedido no encontrado.', 'not_found');
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
      const reservationExpiresAt = new Date(
        now.getTime() + this.reservationTtlHours * 60 * 60 * 1000,
      );
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
      if (!aggregate) throw new DomainError('Pedido no encontrado.', 'not_found');
      if (aggregate.order.version !== input.expectedVersion)
        throw new DomainError('Conflicto de versión.', 'version_conflict');
      if (!['requested', 'quoted', 'accepted', 'payment_pending'].includes(aggregate.order.status))
        throw new DomainError(
          'El pedido no se puede cancelar en su estado actual.',
          'invalid_transition',
        );

      const isBuyer = input.actor.sub === aggregate.order.buyerId;
      const isProvider = input.actor.sub === aggregate.order.providerId;
      if (!isBuyer && !isProvider)
        throw new DomainError('No tiene permiso para cancelar este pedido.', 'access_denied');

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
      if (!['requested', 'quoted'].includes(aggregate.order.status)) return false;

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
