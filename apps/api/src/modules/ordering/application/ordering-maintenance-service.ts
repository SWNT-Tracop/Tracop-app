import type { OrderingClock } from '../ports/ordering-ports.js';
import type { OrderingService } from './ordering-service.js';

export interface OrderingExpiryResult {
  readonly reservations: number;
  readonly quotes: number;
}

/** Public maintenance use case of ordering, run by the worker. */
export interface OrderingMaintenanceApi {
  expireReservationsAndQuotes(): Promise<OrderingExpiryResult>;
}

const BATCH_SIZE = 100;
const MAX_BATCHES = 100;

export class OrderingMaintenanceService implements OrderingMaintenanceApi {
  constructor(
    private readonly ordering: Pick<
      OrderingService,
      'expireReservations' | 'getExpiredQuoteIds' | 'expireQuote'
    >,
    private readonly clock: OrderingClock,
  ) {}

  async expireReservationsAndQuotes(): Promise<OrderingExpiryResult> {
    const now = this.clock.now();
    let reservations = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const expired = await this.ordering.expireReservations(now, BATCH_SIZE);
      reservations += expired;
      if (expired < BATCH_SIZE) break;
    }
    let quotes = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const ids = await this.ordering.getExpiredQuoteIds(now, BATCH_SIZE);
      let expired = 0;
      // expireQuote locks the order and re-checks status and validity, so a concurrent
      // run or a buyer acting at the same time never double-expires a quote.
      for (const orderId of ids)
        if (await this.ordering.expireQuote({ orderId, now })) expired += 1;
      quotes += expired;
      if (ids.length < BATCH_SIZE || expired === 0) break;
    }
    return { reservations, quotes };
  }
}

export const ORDERING_MAINTENANCE = Symbol('ORDERING_MAINTENANCE');
