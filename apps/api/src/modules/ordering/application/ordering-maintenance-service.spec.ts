import { OrderingMaintenanceService } from './ordering-maintenance-service.js';

const now = new Date('2026-11-20T12:00:00.000Z');

describe('OrderingMaintenanceService', () => {
  it('uses one clock reading for reservations and quotes and counts real expirations', async () => {
    const ordering = {
      expireReservations: jest.fn(async () => 2),
      getExpiredQuoteIds: jest.fn(async () => ['a', 'b', 'c']),
      expireQuote: jest.fn(async ({ orderId }: { orderId: string; now: Date }) => orderId !== 'b'),
    };
    const result = await new OrderingMaintenanceService(ordering, {
      now: () => now,
    }).expireReservationsAndQuotes();
    expect(result).toEqual({ reservations: 2, quotes: 2 });
    expect(ordering.expireReservations).toHaveBeenCalledWith(now, 100);
    expect(ordering.getExpiredQuoteIds).toHaveBeenCalledWith(now, 100);
    expect(ordering.expireQuote).toHaveBeenCalledWith({ orderId: 'a', now });
  });

  it('stops paging quotes when a full page expires nothing', async () => {
    const page = Array.from({ length: 100 }, (_, index) => `order-${index}`);
    const ordering = {
      expireReservations: jest.fn(async () => 0),
      getExpiredQuoteIds: jest.fn(async () => page),
      expireQuote: jest.fn(async () => false),
    };
    const result = await new OrderingMaintenanceService(ordering, {
      now: () => now,
    }).expireReservationsAndQuotes();
    expect(result).toEqual({ reservations: 0, quotes: 0 });
    expect(ordering.getExpiredQuoteIds).toHaveBeenCalledTimes(1);
  });
});
