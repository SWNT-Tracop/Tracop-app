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
  };
  const pricing = {
    configuration: { commissionRateBps: 0n, freightCop: 0n, subtotalRounding: 'half_up' as const },
    calculate: () => ({
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
    24,
    24,
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
});
