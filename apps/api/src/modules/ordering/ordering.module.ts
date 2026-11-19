import { Module } from '@nestjs/common';
import { OrderingController } from './adapters/in/ordering.controller.js';
import { OrderingService } from './application/ordering-service.js';
import { DrizzleOrderRepository } from './adapters/out/drizzle-repositories.js';
import { envPricingPortProvider } from './adapters/out/drizzle-repositories.js';
import { InMemoryOrderingRateLimit } from './adapters/in/rate-limiter.js';
import { UNIT_OF_WORK, APP_CLOCK } from '../../shared/infra/tokens.js';
import {
  ORDER_REPOSITORY,
  PRICING_PORT,
  ORDERING_UNIT_OF_WORK,
  ORDERING_CLOCK,
  ORDERING_RATE_LIMIT,
  ORDER_TRACE_PORT,
} from './ports/ordering-ports.js';
import { APP_ENVIRONMENT } from '../../shared/infra/tokens.js';

@Module({
  controllers: [OrderingController],
  providers: [
    OrderingService,
    { provide: 'ORDERING_SERVICE', useExisting: OrderingService },
    { provide: ORDER_REPOSITORY, useClass: DrizzleOrderRepository },
    // LOT_QUOTE_PORT and LOT_RESERVATION_PORT provided by OrderingBridgeModule
    envPricingPortProvider,
    { provide: ORDERING_UNIT_OF_WORK, useExisting: UNIT_OF_WORK },
    { provide: ORDERING_CLOCK, useExisting: APP_CLOCK },
    { provide: ORDERING_RATE_LIMIT, useClass: InMemoryOrderingRateLimit },
    { provide: ORDER_TRACE_PORT, useExisting: OrderingService },
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
      provide: 'ORDER_QUOTE_TTL_HOURS',
      useFactory: (env: { ORDER_QUOTE_TTL_HOURS: number }) => env.ORDER_QUOTE_TTL_HOURS,
      inject: [APP_ENVIRONMENT],
    },
    {
      provide: 'ORDER_RESERVATION_TTL_HOURS',
      useFactory: (env: { ORDER_RESERVATION_TTL_HOURS: number }) => env.ORDER_RESERVATION_TTL_HOURS,
      inject: [APP_ENVIRONMENT],
    },
    {
      provide: 'ORDER_SUBTOTAL_ROUNDING',
      useFactory: (env: { ORDER_SUBTOTAL_ROUNDING: 'half_up' | 'floor' | 'ceil' }) =>
        env.ORDER_SUBTOTAL_ROUNDING,
      inject: [APP_ENVIRONMENT],
    },
  ],
  exports: [OrderingService, ORDER_REPOSITORY, PRICING_PORT, ORDER_TRACE_PORT],
})
export class OrderingModule {}
