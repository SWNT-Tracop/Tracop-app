import { Module } from '@nestjs/common';
import { OrderingController } from './adapters/in/ordering.controller.js';
import { OrderingService } from './application/ordering-service.js';
import { DrizzleOrderRepository } from './adapters/out/drizzle-repositories.js';
import { DrizzleLotQuotePort } from './adapters/out/drizzle-repositories.js';
import { DrizzleLotReservationPort } from './adapters/out/drizzle-repositories.js';
import { envPricingPortProvider } from './adapters/out/drizzle-repositories.js';
import { InMemoryOrderingRateLimit } from './adapters/in/rate-limiter.js';
import { UNIT_OF_WORK, APP_CLOCK } from '../../shared/infra/tokens.js';
import {
  ORDER_REPOSITORY,
  LOT_QUOTE_PORT,
  LOT_RESERVATION_PORT,
  PRICING_PORT,
  ORDERING_UNIT_OF_WORK,
  ORDERING_CLOCK,
  ORDERING_RATE_LIMIT,
} from './ports/ordering-ports.js';
import { APP_ENVIRONMENT } from '../../shared/infra/tokens.js';

@Module({
  controllers: [OrderingController],
  providers: [
    OrderingService,
    { provide: ORDER_REPOSITORY, useClass: DrizzleOrderRepository },
    { provide: LOT_QUOTE_PORT, useClass: DrizzleLotQuotePort },
    { provide: LOT_RESERVATION_PORT, useClass: DrizzleLotReservationPort },
    envPricingPortProvider,
    { provide: ORDERING_UNIT_OF_WORK, useExisting: UNIT_OF_WORK },
    { provide: ORDERING_CLOCK, useExisting: APP_CLOCK },
    { provide: ORDERING_RATE_LIMIT, useClass: InMemoryOrderingRateLimit },
    {
      provide: 'ORDER_COMMISSION_RATE_BPS',
      useFactory: (env: { ORDER_COMMISSION_RATE_BPS: bigint }) => env.ORDER_COMMISSION_RATE_BPS,
      inject: [APP_ENVIRONMENT],
    },
    {
      provide: 'ORDER_FREIGHT_COP',
      useFactory: (env: { ORDER_FREIGHT_COP: bigint }) => env.ORDER_FREIGHT_COP,
      inject: [APP_ENVIRONMENT],
    },
    {
      provide: 'ORDER_SUBTOTAL_ROUNDING',
      useFactory: (env: { ORDER_SUBTOTAL_ROUNDING: 'half_up' | 'floor' | 'ceil' }) =>
        env.ORDER_SUBTOTAL_ROUNDING,
      inject: [APP_ENVIRONMENT],
    },
  ],
  exports: [OrderingService, ORDER_REPOSITORY, LOT_QUOTE_PORT, LOT_RESERVATION_PORT, PRICING_PORT],
})
export class OrderingModule {}
