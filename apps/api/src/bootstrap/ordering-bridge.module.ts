import { Global, Module } from '@nestjs/common';
import { CatalogModule } from '../modules/catalog/index.js';
import {
  LOT_QUOTE_PORT,
  LOT_RESERVATION_PORT,
  type LotQuotePort,
  type LotReservationPort,
} from '../modules/ordering/index.js';
import { CATALOG_LOT_REPOSITORY, CATALOG_CLOCK } from '../modules/catalog/index.js';
import type { LotRepository, CatalogClock } from '../modules/catalog/index.js';
import { DomainError } from '../shared/kernel/domain-error.js';

export class CatalogLotQuoteAdapter implements LotQuotePort {
  constructor(
    private readonly lotRepo: LotRepository,
    private readonly clock: CatalogClock,
  ) {}

  async getQuote(lotId: string) {
    const lot = await this.lotRepo.findById(lotId);
    if (!lot) throw new Error('Lot not found');
    const availableQuantityMilli = await this.lotRepo.getAvailableQuantity(lotId, this.clock.now());
    return {
      id: lot.id,
      providerId: lot.providerId,
      unit: lot.unit,
      unitPrice: lot.unitPrice,
      availableUntil: lot.availableUntil,
      status: lot.status,
      availableQuantityMilli,
    };
  }
}

export class CatalogLotReservationAdapter implements LotReservationPort {
  constructor(
    private readonly lotRepo: LotRepository,
    private readonly clock: CatalogClock,
  ) {}

  async reserve(
    orderId: string,
    lines: readonly { lotId: string; quantityMilli: bigint }[],
    expiresAt: Date,
  ): Promise<void> {
    // Lock lot rows to prevent concurrent over-reservation
    const lotIds = [...new Set(lines.map((l) => l.lotId))];
    await this.lotRepo.lockForReservation(lotIds);

    // Re-check availability while holding the lock
    const now = this.clock.now();
    for (const line of lines) {
      const available = await this.lotRepo.getAvailableQuantity(line.lotId, now);
      if (available < line.quantityMilli) {
        throw new DomainError('No hay disponibilidad suficiente.', 'insufficient_stock');
      }
    }

    // Create reservations
    for (const line of lines) {
      await this.lotRepo.reserveStock({ ...line, orderId, expiresAt, now });
    }
  }

  async release(orderId: string): Promise<void> {
    await this.lotRepo.releaseOrderReservations(orderId, this.clock.now());
  }

  async findExpiredOrderIds(now: Date, limit: number): Promise<readonly string[]> {
    return this.lotRepo.findExpiredReservationOrderIds(now, limit);
  }
}

@Global()
@Module({
  imports: [CatalogModule],
  providers: [
    {
      provide: LOT_QUOTE_PORT,
      inject: [CATALOG_LOT_REPOSITORY, CATALOG_CLOCK],
      useFactory: (lotRepo: LotRepository, clock: CatalogClock) =>
        new CatalogLotQuoteAdapter(lotRepo, clock),
    },
    {
      provide: LOT_RESERVATION_PORT,
      inject: [CATALOG_LOT_REPOSITORY, CATALOG_CLOCK],
      useFactory: (lotRepo: LotRepository, clock: CatalogClock) =>
        new CatalogLotReservationAdapter(lotRepo, clock),
    },
  ],
  exports: [LOT_QUOTE_PORT, LOT_RESERVATION_PORT],
})
export class OrderingBridgeModule {}
