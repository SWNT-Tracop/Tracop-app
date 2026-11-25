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
import { RecommendationCursorCodec } from './adapters/in/recommendation-cursor.js';
import { InMemoryRecommendationsRateLimit } from './adapters/in/recommendations-rate-limiter.js';
import {
  LotAlertsSubscriber,
  OrderObservationsSubscriber,
} from './adapters/in/recommendations-subscribers.js';
import { RecommendationsController } from './adapters/in/recommendations.controller.js';
import { DrizzleRecommendationsRepository } from './adapters/out/drizzle-recommendations-repository.js';
import { RecommendationsService } from './application/recommendations-service.js';
import {
  RECOMMENDATION_CURSOR_CODEC,
  RECOMMENDATIONS_OUTBOX_SUBSCRIBERS,
  RECOMMENDATIONS_SERVICE,
} from './application/recommendations-tokens.js';
import {
  CATALOG_FACTS_PORT,
  ORDER_FACTS_PORT,
  PROVIDER_VERIFICATION_PORT,
  RECOMMENDATIONS_CLOCK,
  type CatalogFactsPort,
  type OrderFactsPort,
  type ProviderVerificationPort,
} from './ports/recommendations-ports.js';

/** CATALOG_FACTS_PORT, ORDER_FACTS_PORT and PROVIDER_VERIFICATION_PORT come from bootstrap. */
@Module({
  controllers: [RecommendationsController],
  providers: [
    DrizzleRecommendationsRepository,
    { provide: RECOMMENDATIONS_CLOCK, useExisting: APP_CLOCK },
    {
      provide: RECOMMENDATION_CURSOR_CODEC,
      inject: [APP_ENVIRONMENT],
      useFactory: (environment: AppEnvironment) =>
        new RecommendationCursorCodec(environment.JWT_SECRET),
    },
    {
      provide: RECOMMENDATIONS_SERVICE,
      inject: [
        DrizzleRecommendationsRepository,
        CATALOG_FACTS_PORT,
        ORDER_FACTS_PORT,
        PROVIDER_VERIFICATION_PORT,
        OUTBOX_WRITER,
        AUDIT_WRITER,
        UNIT_OF_WORK,
        APP_ENVIRONMENT,
        RECOMMENDATIONS_CLOCK,
      ],
      useFactory: (
        repository: DrizzleRecommendationsRepository,
        catalog: CatalogFactsPort,
        orders: OrderFactsPort,
        providers: ProviderVerificationPort,
        outbox: OutboxWriter,
        audit: AuditWriter,
        uow: UnitOfWork,
        environment: AppEnvironment,
        clock: Clock,
      ) =>
        new RecommendationsService(
          repository,
          catalog,
          orders,
          providers,
          outbox,
          audit,
          new InMemoryRecommendationsRateLimit(
            environment.RECOMMENDATIONS_RATE_LIMIT,
            environment.RECOMMENDATIONS_RATE_WINDOW_SECONDS,
            clock,
          ),
          uow,
          {
            referenceMaxAgeDays: environment.RECOMMENDATIONS_REFERENCE_MAX_AGE_DAYS,
            observationWindowDays: environment.RECOMMENDATIONS_OBSERVATION_WINDOW_DAYS,
            minSample: environment.RECOMMENDATIONS_MIN_SAMPLE,
            minOwnObservations: environment.RECOMMENDATIONS_MIN_OWN_OBSERVATIONS,
            minOwnProviders: environment.RECOMMENDATIONS_MIN_OWN_PROVIDERS,
            weights: {
              reorder: environment.RECOMMENDATIONS_WEIGHT_REORDER,
              nearby: environment.RECOMMENDATIONS_WEIGHT_NEARBY,
              good_price: environment.RECOMMENDATIONS_WEIGHT_GOOD_PRICE,
              verified_provider: environment.RECOMMENDATIONS_WEIGHT_VERIFIED_PROVIDER,
              fresh: environment.RECOMMENDATIONS_WEIGHT_FRESH,
            },
            nearbyKm: environment.RECOMMENDATIONS_NEARBY_KM,
            freshHours: environment.RECOMMENDATIONS_FRESH_HOURS,
            candidateLimit: environment.RECOMMENDATIONS_CANDIDATE_LIMIT,
            defaultRadiusKm: environment.RECOMMENDATIONS_DEFAULT_RADIUS_KM,
            alertsPerUser: environment.RECOMMENDATIONS_ALERTS_PER_USER,
            providerKeySecret: environment.RATE_LIMIT_HMAC_SECRET,
          },
          clock,
        ),
    },
    {
      provide: RECOMMENDATIONS_OUTBOX_SUBSCRIBERS,
      inject: [RECOMMENDATIONS_SERVICE],
      useFactory: (service: RecommendationsService) => [
        new LotAlertsSubscriber(service),
        new OrderObservationsSubscriber(service),
      ],
    },
  ],
  exports: [RECOMMENDATIONS_SERVICE, RECOMMENDATIONS_OUTBOX_SUBSCRIBERS, RECOMMENDATIONS_CLOCK],
})
export class RecommendationsModule {}
