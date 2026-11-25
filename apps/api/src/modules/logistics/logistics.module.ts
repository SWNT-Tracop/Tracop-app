import { Module } from '@nestjs/common';
import { SharedInfraModule } from '../../shared/infra/shared-infra.module.js';
import type { AppEnvironment } from '../../shared/infra/env.js';
import { APP_CLOCK, APP_ENVIRONMENT, UNIT_OF_WORK } from '../../shared/infra/tokens.js';
import { InMemoryLocationRateLimit } from './adapters/in/location-rate-limiter.js';
import { TripLocationController } from './adapters/in/trip-location.controller.js';
import { TripLocationService } from './application/trip-location.service.js';
import {
  LOCATION_RATE_LIMIT_PORT,
  LOCATION_SETTINGS,
  type LocationSettings,
} from './ports/trip-location-ports.js';
import { CarrierProfileService } from './application/carrier-profile.service.js';
import { CheckinService } from './application/checkin.service.js';
import { IncidentService } from './application/incident.service.js';
import { TripPlanningService } from './application/trip-planning.service.js';
import { LogisticsController } from './adapters/in/logistics.controller.js';
import { DrizzleLogisticsRepository } from './adapters/out/drizzle-logistics-repository.js';
import {
  LOGISTICS_CLOCK,
  LOGISTICS_REPOSITORY,
  LOGISTICS_UNIT_OF_WORK,
} from './ports/logistics-ports.js';

@Module({
  imports: [SharedInfraModule],
  controllers: [LogisticsController, TripLocationController],
  providers: [
    CarrierProfileService,
    TripPlanningService,
    CheckinService,
    IncidentService,
    TripLocationService,
    {
      provide: LOCATION_SETTINGS,
      inject: [APP_ENVIRONMENT],
      useFactory: (env: AppEnvironment): LocationSettings => ({
        maxTtlHours: env.LOGISTICS_LOCATION_MAX_TTL_HOURS,
      }),
    },
    {
      provide: LOCATION_RATE_LIMIT_PORT,
      inject: [APP_ENVIRONMENT],
      useFactory: (env: AppEnvironment) =>
        new InMemoryLocationRateLimit(
          env.LOGISTICS_LOCATION_RATE_LIMIT,
          env.LOGISTICS_LOCATION_RATE_WINDOW_SECONDS,
        ),
    },
    { provide: LOGISTICS_REPOSITORY, useClass: DrizzleLogisticsRepository },
    { provide: LOGISTICS_UNIT_OF_WORK, useExisting: UNIT_OF_WORK },
    { provide: LOGISTICS_CLOCK, useExisting: APP_CLOCK },
  ],
  exports: [
    CarrierProfileService,
    TripPlanningService,
    CheckinService,
    IncidentService,
    LOGISTICS_REPOSITORY,
    LOGISTICS_CLOCK,
  ],
})
export class LogisticsModule {}
