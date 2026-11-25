import { OrderingService } from './ordering-service.js';
import type { OrderAggregate, OrderRepository } from '../ports/ordering-ports.js';
import { DomainError } from '../../../shared/kernel/domain-error.js';

const now = new Date('2026-11-18T12:00:00.000Z');

const createHarness = () => {
  const state = new Map<string, OrderAggregate>();
  const repository: OrderRepository = {
    findById: async (id) => state.get(id) ?? null,
    create: async (aggregate) => {
      state.set(aggregate.order.id, aggregate);
      return true;
    },
    save: async (aggregate) => {
      state.set(aggregate.order.id, aggregate);
    },
    listMine: async () => ({ items: [] }),
    listIncoming: async () => ({ items: [] }),
    findExpiredQuoteIds: async () => [],
  };
  const lotQuote = {
    getQuote: async (lotId: string) => ({
      id: lotId,
      providerId: 'provider',
      unit: 'kg',
      unitPrice: 5000n,
      availableUntil: new Date('2026-12-01T12:00:00.000Z'),
      status: 'published',
      availableQuantityMilli: 5000n,
    }),
  };
  const lotReservation = {
    reserve: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    findExpiredOrderIds: jest.fn(async () => []),
    hold: jest.fn(async () => undefined),
    resumeExpiry: jest.fn(async () => undefined),
    consume: jest.fn(async () => undefined),
    isExpired: jest.fn(async () => false),
  };
  const pricing = {
    calculate: async () => ({
      subtotal: 5000n,
      freight: 0n,
      commission: 0n,
      total: 5000n,
      providerNet: 5000n,
    }),
  };
  const outbox = { append: jest.fn(async () => undefined) };
  const service = new OrderingService(
    repository,
    lotQuote,
    lotReservation,
    pricing,
    { run: async (operation) => operation() },
    { now: () => now },
    { consume: () => undefined },
    outbox,
    { get: async () => 24n },
  );
  return { state, repository, lotQuote, lotReservation, pricing, outbox, service };
};

describe('OrderingService', () => {
  it('creates and quotes an order without reserving stock', async () => {
    const harness = createHarness();
    const orderId = '018f47a2-8b45-7cc2-9a1e-123456789abc';
    const aggregate = await harness.service.createOrder(
      { sub: 'buyer', role: 'buyer' },
      {
        id: orderId,
        buyerId: 'buyer',
        lines: [{ lotId: '018f47a2-8b45-7cc2-9a1e-123456789abd', quantityMilli: 1000n }],
        deliveryAddress: 'Dirección sintética',
        deliveryWindow: null,
      },
    );
    expect(aggregate.order.status).toBe('quoted');
    expect(harness.lotReservation.reserve).not.toHaveBeenCalled();
  });

  it('rejects duplicate lot lines and mismatched idempotency content', async () => {
    const harness = createHarness();
    await expect(
      harness.service.createOrder(
        { sub: 'buyer', role: 'buyer' },
        {
          id: '018f47a2-8b45-7cc2-9a1e-123456789abc',
          buyerId: 'buyer',
          lines: [
            { lotId: 'lot-a', quantityMilli: 1000n },
            { lotId: 'lot-a', quantityMilli: 1000n },
          ],
          deliveryAddress: 'Dirección',
          deliveryWindow: null,
        },
      ),
    ).rejects.toMatchObject({ code: 'duplicate_lot_line' });

    const first = await harness.service.createOrder(
      { sub: 'buyer', role: 'buyer' },
      {
        id: '018f47a2-8b45-7cc2-9a1e-123456789abd',
        buyerId: 'buyer',
        lines: [{ lotId: '018f47a2-8b45-7cc2-9a1e-123456789abe', quantityMilli: 1000n }],
        deliveryAddress: 'Primera',
        deliveryWindow: null,
      },
    );
    await expect(
      harness.service.createOrder(
        { sub: 'buyer', role: 'buyer' },
        {
          id: first.order.id,
          buyerId: 'buyer',
          lines: first.lines.map((line) => ({
            lotId: line.lotId,
            quantityMilli: line.quantityMilli,
          })),
          deliveryAddress: 'Distinta',
          deliveryWindow: null,
        },
      ),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('accepts by reserving all lines and cancelling releases them', async () => {
    const harness = createHarness();
    const orderId = '018f47a2-8b45-7cc2-9a1e-123456789abc';
    await harness.service.createOrder(
      { sub: 'buyer', role: 'buyer' },
      {
        id: orderId,
        buyerId: 'buyer',
        lines: [{ lotId: '018f47a2-8b45-7cc2-9a1e-123456789abd', quantityMilli: 1000n }],
        deliveryAddress: 'Dirección',
        deliveryWindow: null,
      },
    );
    const accepted = await harness.service.acceptQuote({
      actor: { sub: 'buyer', role: 'buyer' },
      orderId,
      expectedVersion: 3,
    });
    expect(accepted.order.status).toBe('accepted');
    expect(harness.lotReservation.reserve).toHaveBeenCalledTimes(1);
    await harness.service.cancelOrder({
      actor: { sub: 'buyer', role: 'buyer' },
      orderId,
      expectedVersion: 4,
    });
    expect(harness.lotReservation.release).toHaveBeenCalledWith(orderId);
  });

  it('expires quote and reservation candidates', async () => {
    const harness = createHarness();
    const orderId = '018f47a2-8b45-7cc2-9a1e-123456789abc';
    await harness.service.createOrder(
      { sub: 'buyer', role: 'buyer' },
      {
        id: orderId,
        buyerId: 'buyer',
        lines: [{ lotId: '018f47a2-8b45-7cc2-9a1e-123456789abd', quantityMilli: 1000n }],
        deliveryAddress: 'Dirección',
        deliveryWindow: null,
      },
    );
    expect(
      await harness.service.expireQuote({
        orderId,
        now: new Date('2027-11-18T12:00:00.000Z'),
      }),
    ).toBe(true);
    expect(await harness.service.expireReservations(now, 100)).toBe(0);
  });

  it('rejects quote_expired, lot_unavailable and insufficient_stock before acceptance', async () => {
    const expiredHarness = createHarness();
    const expiredId = '018f47a2-8b45-7cc2-9a1e-123456789abc';
    const expired = await expiredHarness.service.createOrder(
      { sub: 'buyer', role: 'buyer' },
      {
        id: expiredId,
        buyerId: 'buyer',
        lines: [{ lotId: '018f47a2-8b45-7cc2-9a1e-123456789abd', quantityMilli: 1000n }],
        deliveryAddress: 'Dirección',
        deliveryWindow: null,
      },
    );
    expiredHarness.state.set(expiredId, {
      ...expired,
      quote: { ...expired.quote, validUntil: new Date('2026-11-18T11:59:59.999Z') },
    });
    await expect(
      expiredHarness.service.acceptQuote({
        actor: { sub: 'buyer', role: 'buyer' },
        orderId: expiredId,
        expectedVersion: expired.order.version,
      }),
    ).rejects.toMatchObject({ code: 'quote_expired' });

    const unavailableHarness = createHarness();
    const unavailableId = '018f47a2-8b45-7cc2-9a1e-123456789abd';
    await unavailableHarness.service.createOrder(
      { sub: 'buyer', role: 'buyer' },
      {
        id: unavailableId,
        buyerId: 'buyer',
        lines: [{ lotId: '018f47a2-8b45-7cc2-9a1e-123456789abe', quantityMilli: 1000n }],
        deliveryAddress: 'Dirección',
        deliveryWindow: null,
      },
    );
    unavailableHarness.lotQuote.getQuote = async (lotId: string) => ({
      id: lotId,
      providerId: 'provider',
      unit: 'kg',
      unitPrice: 5000n,
      availableUntil: new Date('2026-12-01T12:00:00.000Z'),
      status: 'cancelled',
      availableQuantityMilli: 5000n,
    });
    await expect(
      unavailableHarness.service.acceptQuote({
        actor: { sub: 'buyer', role: 'buyer' },
        orderId: unavailableId,
        expectedVersion: 3,
      }),
    ).rejects.toMatchObject({ code: 'lot_unavailable' });

    const insufficientHarness = createHarness();
    const insufficientId = '018f47a2-8b45-7cc2-9a1e-123456789abe';
    await insufficientHarness.service.createOrder(
      { sub: 'buyer', role: 'buyer' },
      {
        id: insufficientId,
        buyerId: 'buyer',
        lines: [{ lotId: '018f47a2-8b45-7cc2-9a1e-123456789abf', quantityMilli: 1000n }],
        deliveryAddress: 'Dirección',
        deliveryWindow: null,
      },
    );
    insufficientHarness.lotQuote.getQuote = async (lotId: string) => ({
      id: lotId,
      providerId: 'provider',
      unit: 'kg',
      unitPrice: 5000n,
      availableUntil: new Date('2026-12-01T12:00:00.000Z'),
      status: 'published',
      availableQuantityMilli: 999n,
    });
    await expect(
      insufficientHarness.service.acceptQuote({
        actor: { sub: 'buyer', role: 'buyer' },
        orderId: insufficientId,
        expectedVersion: 3,
      }),
    ).rejects.toMatchObject({ code: 'insufficient_stock' });
  });

  describe('payment transitions', () => {
    const orderId = '018f47a2-8b45-7cc2-9a1e-123456789abc';
    const acceptedHarness = async () => {
      const harness = createHarness();
      await harness.service.createOrder(
        { sub: 'buyer', role: 'buyer' },
        {
          id: orderId,
          buyerId: 'buyer',
          lines: [{ lotId: '018f47a2-8b45-7cc2-9a1e-123456789abd', quantityMilli: 1000n }],
          deliveryAddress: 'Dirección',
          deliveryWindow: null,
        },
      );
      await harness.service.acceptQuote({
        actor: { sub: 'buyer', role: 'buyer' },
        orderId,
        expectedVersion: 3,
      });
      harness.outbox.append.mockClear();
      return harness;
    };
    const eventTypes = (harness: ReturnType<typeof createHarness>) =>
      (harness.outbox.append.mock.calls as unknown as [readonly { type: string }[]][]).flatMap(
        ([events]) => events.map((event) => event.type),
      );

    it('starts a payment once: accepted -> payment_pending, then a no-op', async () => {
      const harness = await acceptedHarness();
      const pending = await harness.service.startPayment(orderId, 'buyer');
      expect(pending.order.status).toBe('payment_pending');
      const again = await harness.service.startPayment(orderId, 'buyer');
      expect(again.order.version).toBe(pending.order.version);
      expect(eventTypes(harness)).toEqual(['OrderPaymentPending']);
    });

    it('answers not_found to anyone but the buyer and refuses a lapsed reservation', async () => {
      const harness = await acceptedHarness();
      await expect(harness.service.startPayment(orderId, 'provider')).rejects.toMatchObject({
        code: 'not_found',
      });
      await expect(harness.service.startPayment('missing', 'buyer')).rejects.toMatchObject({
        code: 'not_found',
      });
      harness.lotReservation.isExpired.mockResolvedValueOnce(true);
      await expect(harness.service.startPayment(orderId, 'buyer')).rejects.toMatchObject({
        code: 'reservation_expired',
      });
    });

    it('refuses to start a payment before the quote is accepted', async () => {
      const harness = createHarness();
      await harness.service.createOrder(
        { sub: 'buyer', role: 'buyer' },
        {
          id: orderId,
          buyerId: 'buyer',
          lines: [{ lotId: '018f47a2-8b45-7cc2-9a1e-123456789abd', quantityMilli: 1000n }],
          deliveryAddress: 'Dirección',
          deliveryWindow: null,
        },
      );
      await expect(harness.service.startPayment(orderId, 'buyer')).rejects.toMatchObject({
        code: 'invalid_transition',
      });
    });

    it('holds, resumes and consumes the reservation only while payment is pending', async () => {
      const harness = await acceptedHarness();
      await expect(harness.service.holdStockForPaymentReview(orderId)).rejects.toMatchObject({
        code: 'invalid_transition',
      });
      await harness.service.startPayment(orderId, 'buyer');
      await harness.service.holdStockForPaymentReview(orderId);
      expect(harness.lotReservation.hold).toHaveBeenCalledWith(orderId);
      const graceEnd = new Date('2026-11-18T14:00:00.000Z');
      await harness.service.resumeStockExpiry(orderId, graceEnd);
      expect(harness.lotReservation.resumeExpiry).toHaveBeenCalledWith(orderId, graceEnd);

      const paid = await harness.service.markPaid(orderId, 'finance');
      expect(paid.order.status).toBe('paid');
      expect(harness.lotReservation.consume).toHaveBeenCalledWith(orderId);
      await expect(harness.service.markPaid(orderId, 'finance')).rejects.toMatchObject({
        code: 'invalid_transition',
      });
    });

    it('disputes a paid order and closes it, recording every transition', async () => {
      const harness = await acceptedHarness();
      await harness.service.startPayment(orderId, 'buyer');
      await harness.service.markPaid(orderId, 'finance');
      const disputed = await harness.service.markDisputed(orderId, 'buyer');
      expect(disputed.order.status).toBe('disputed');
      const closed = await harness.service.closeOrder(orderId, 'operator');
      expect(closed.order.status).toBe('closed');
      expect(eventTypes(harness)).toEqual([
        'OrderPaymentPending',
        'OrderPaid',
        'OrderDisputed',
        'OrderClosed',
      ]);
      await expect(harness.service.markDisputed(orderId, 'buyer')).rejects.toMatchObject({
        code: 'invalid_transition',
      });
      expect((await harness.service.getForPayment(orderId))?.order.status).toBe('closed');
    });

    it('does not cancel an order whose reservation is held when the expiry job reaches it', async () => {
      const harness = await acceptedHarness();
      await harness.service.startPayment(orderId, 'buyer');
      harness.lotReservation.findExpiredOrderIds.mockResolvedValueOnce([orderId] as never);
      harness.lotReservation.isExpired.mockResolvedValueOnce(false);
      expect(await harness.service.expireReservations(now, 10)).toBe(0);
      expect((await harness.service.getForPayment(orderId))?.order.status).toBe('payment_pending');

      harness.lotReservation.findExpiredOrderIds.mockResolvedValueOnce([orderId] as never);
      harness.lotReservation.isExpired.mockResolvedValueOnce(true);
      expect(await harness.service.expireReservations(now, 10)).toBe(1);
      expect((await harness.service.getForPayment(orderId))?.order.status).toBe('cancelled');
    });
  });
});
