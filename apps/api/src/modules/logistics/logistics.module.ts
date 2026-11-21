import { Module } from '@nestjs/common';
import { SharedInfraModule } from '../../shared/infra/shared-infra.module.js';
import { APP_CLOCK, UNIT_OF_WORK } from '../../shared/infra/tokens.js';
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
  controllers: [LogisticsController],
  providers: [
    CarrierProfileService,
    TripPlanningService,
    CheckinService,
    IncidentService,
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
