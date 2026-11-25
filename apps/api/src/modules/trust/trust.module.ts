import { Module } from '@nestjs/common';
import type { AppEnvironment } from '../../shared/infra/env.js';
import {
  APP_CLOCK,
  APP_ENVIRONMENT,
  OUTBOX_WRITER,
  UNIT_OF_WORK,
} from '../../shared/infra/tokens.js';
import type { UnitOfWork } from '../../shared/infra/unit-of-work.js';
import type { Clock } from '../../shared/kernel/clock.js';
import { AUDIT_WRITER, type AuditWriter } from '../../shared/ports/audit-writer.js';
import type { OutboxWriter } from '../../shared/ports/outbox-writer.js';
import { PARAMETER_READER, type ParameterReader } from '../../shared/ports/parameter-reader.js';
import { OrderDeliveredTrustSubscriber } from './adapters/in/order-delivered-trust.subscriber.js';
import { InMemoryTrustRateLimit } from './adapters/in/trust-rate-limiter.js';
import { TrustController } from './adapters/in/trust.controller.js';
import { DrizzleTrustRepository } from './adapters/out/drizzle-trust-repository.js';
import { TrustService } from './application/trust-service.js';
import { TRUST_OUTBOX_SUBSCRIBER, TRUST_SERVICE } from './application/trust-tokens.js';
import {
  ORDER_DELIVERY_INFO_PORT,
  TRUST_CLOCK,
  TRUST_RATING_RATE_LIMIT,
  TRUST_VERIFICATION_RATE_LIMIT,
  type OrderDeliveryInfoPort,
  type TrustRateLimitPort,
} from './ports/trust-ports.js';

@Module({
  controllers: [TrustController],
  providers: [
    DrizzleTrustRepository,
    { provide: TRUST_CLOCK, useExisting: APP_CLOCK },
    {
      provide: TRUST_RATING_RATE_LIMIT,
      inject: [APP_ENVIRONMENT],
      useFactory: (env: AppEnvironment) =>
        new InMemoryTrustRateLimit(env.TRUST_RATING_RATE_LIMIT, env.TRUST_RATE_WINDOW_SECONDS),
    },
    {
      provide: TRUST_VERIFICATION_RATE_LIMIT,
      inject: [APP_ENVIRONMENT],
      useFactory: (env: AppEnvironment) =>
        new InMemoryTrustRateLimit(
          env.TRUST_VERIFICATION_RATE_LIMIT,
          env.TRUST_RATE_WINDOW_SECONDS,
        ),
    },
    {
      provide: TRUST_SERVICE,
      inject: [
        DrizzleTrustRepository,
        ORDER_DELIVERY_INFO_PORT,
        PARAMETER_READER,
        AUDIT_WRITER,
        OUTBOX_WRITER,
        TRUST_RATING_RATE_LIMIT,
        TRUST_VERIFICATION_RATE_LIMIT,
        UNIT_OF_WORK,
        TRUST_CLOCK,
      ],
      useFactory: (
        repository: DrizzleTrustRepository,
        deliveries: OrderDeliveryInfoPort,
        parameters: ParameterReader,
        audit: AuditWriter,
        outbox: OutboxWriter,
        ratingRateLimit: TrustRateLimitPort,
        verificationRateLimit: TrustRateLimitPort,
        uow: UnitOfWork,
        clock: Clock,
      ) =>
        new TrustService(
          repository,
          deliveries,
          parameters,
          audit,
          outbox,
          ratingRateLimit,
          verificationRateLimit,
          uow,
          clock,
        ),
    },
    {
      provide: TRUST_OUTBOX_SUBSCRIBER,
      inject: [TRUST_SERVICE],
      useFactory: (service: TrustService) => new OrderDeliveredTrustSubscriber(service),
    },
  ],
  exports: [TRUST_SERVICE, TRUST_OUTBOX_SUBSCRIBER],
})
export class TrustModule {}
