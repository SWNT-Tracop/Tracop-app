import { Global, Module } from '@nestjs/common';
import { DatabaseService } from '../../shared/infra/database.js';
import type { AppEnvironment } from '../../shared/infra/env.js';
import { APP_CLOCK, APP_ENVIRONMENT, UNIT_OF_WORK } from '../../shared/infra/tokens.js';
import type { UnitOfWork } from '../../shared/infra/unit-of-work.js';
import type { Clock } from '../../shared/kernel/clock.js';
import { AUDIT_WRITER, type AuditWriter } from '../../shared/ports/audit-writer.js';
import { PARAMETER_READER } from '../../shared/ports/parameter-reader.js';
import { BackofficeController } from './adapters/in/backoffice.controller.js';
import {
  DrizzleAuditQueryRepository,
  DrizzleAuditWriter,
  DrizzleParameterRepository,
  StoredParameterReader,
} from './adapters/out/drizzle-backoffice-repositories.js';
import { BackofficeService } from './application/backoffice-service.js';
import { BACKOFFICE_SERVICE } from './application/backoffice-tokens.js';
import {
  METRICS_SOURCES_PORT,
  PARAMETER_DEFAULTS,
  type MetricsSourcesPort,
  type ParameterDefaults,
} from './ports/backoffice-ports.js';

/**
 * Global: every module writes audit entries and reads run-time parameters through the shared
 * ports AUDIT_WRITER and PARAMETER_READER, implemented here.
 */
@Global()
@Module({
  controllers: [BackofficeController],
  providers: [
    DrizzleParameterRepository,
    DrizzleAuditQueryRepository,
    {
      provide: PARAMETER_DEFAULTS,
      inject: [APP_ENVIRONMENT],
      useFactory: (env: AppEnvironment): ParameterDefaults => ({
        'order.commission_rate_bps': env.ORDER_COMMISSION_RATE_BPS,
        'order.freight_cop': env.ORDER_FREIGHT_COP,
        'order.quote_ttl_hours': BigInt(env.ORDER_QUOTE_TTL_HOURS),
        'order.reservation_ttl_hours': BigInt(env.ORDER_RESERVATION_TTL_HOURS),
        'payment.claim_window_hours': BigInt(env.PAYMENT_CLAIM_WINDOW_HOURS),
        'payment.rejection_grace_hours': BigInt(env.PAYMENT_REJECTION_GRACE_HOURS),
        'catalog.product_proposal_pending_limit': BigInt(
          env.CATALOG_PRODUCT_PROPOSAL_PENDING_LIMIT,
        ),
        'trust.rating_window_days': BigInt(env.TRUST_RATING_WINDOW_DAYS),
        'trust.min_ratings_visible': BigInt(env.TRUST_MIN_RATINGS_VISIBLE),
        'trust.comment_max_length': BigInt(env.TRUST_COMMENT_MAX_LENGTH),
        'trust.verification_cooldown_days': BigInt(env.TRUST_VERIFICATION_COOLDOWN_DAYS),
      }),
    },
    {
      provide: AUDIT_WRITER,
      inject: [DatabaseService, APP_CLOCK, APP_ENVIRONMENT],
      useFactory: (database: DatabaseService, clock: Clock, env: AppEnvironment) =>
        new DrizzleAuditWriter(database, clock, env.RATE_LIMIT_HMAC_SECRET),
    },
    {
      provide: PARAMETER_READER,
      inject: [DrizzleParameterRepository, PARAMETER_DEFAULTS],
      useFactory: (repository: DrizzleParameterRepository, defaults: ParameterDefaults) =>
        new StoredParameterReader(repository, defaults),
    },
    {
      provide: BACKOFFICE_SERVICE,
      inject: [
        DrizzleParameterRepository,
        DrizzleAuditQueryRepository,
        AUDIT_WRITER,
        PARAMETER_DEFAULTS,
        UNIT_OF_WORK,
        APP_CLOCK,
        METRICS_SOURCES_PORT,
      ],
      useFactory: (
        parameters: DrizzleParameterRepository,
        auditQueries: DrizzleAuditQueryRepository,
        audit: AuditWriter,
        defaults: ParameterDefaults,
        uow: UnitOfWork,
        clock: Clock,
        metrics: MetricsSourcesPort,
      ) => new BackofficeService(parameters, auditQueries, audit, defaults, uow, clock, metrics),
    },
  ],
  exports: [AUDIT_WRITER, PARAMETER_READER, BACKOFFICE_SERVICE],
})
export class BackofficeModule {}
