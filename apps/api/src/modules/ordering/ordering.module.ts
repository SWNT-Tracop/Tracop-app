import { Module } from '@nestjs/common';
import { OrderingController } from './adapters/in/ordering.controller.js';
import { OrderingService } from './application/ordering-service.js';
import {
  ORDERING_MAINTENANCE,
  OrderingMaintenanceService,
} from './application/ordering-maintenance-service.js';
import type { OrderingClock } from './ports/ordering-ports.js';
import { DrizzleOrderRepository } from './adapters/out/drizzle-repositories.js';
import { parameterPricingPortProvider } from './adapters/out/drizzle-repositories.js';
import { InMemoryOrderingRateLimit } from './adapters/in/rate-limiter.js';
import { UNIT_OF_WORK, APP_CLOCK } from '../../shared/infra/tokens.js';
import {
  ORDER_REPOSITORY,
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
    { provide: 'ORDERING_SERVICE', useExisting: OrderingService },
    { provide: ORDER_REPOSITORY, useClass: DrizzleOrderRepository },
    // LOT_QUOTE_PORT and LOT_RESERVATION_PORT provided by OrderingBridgeModule
    parameterPricingPortProvider,
    { provide: ORDERING_UNIT_OF_WORK, useExisting: UNIT_OF_WORK },
    { provide: ORDERING_CLOCK, useExisting: APP_CLOCK },
    { provide: ORDERING_RATE_LIMIT, useClass: InMemoryOrderingRateLimit },
    {
      provide: 'ORDER_SUBTOTAL_ROUNDING',
      useFactory: (env: { ORDER_SUBTOTAL_ROUNDING: 'half_up' | 'floor' | 'ceil' }) =>
        env.ORDER_SUBTOTAL_ROUNDING,
      inject: [APP_ENVIRONMENT],
    },
    {
      provide: ORDERING_MAINTENANCE,
      inject: [OrderingService, ORDERING_CLOCK],
      useFactory: (ordering: OrderingService, clock: OrderingClock) =>
        new OrderingMaintenanceService(ordering, clock),
    },
  ],
  exports: [OrderingService, ORDER_REPOSITORY, PRICING_PORT, ORDERING_MAINTENANCE],
})
export class OrderingModule {}
