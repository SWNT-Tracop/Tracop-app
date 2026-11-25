import { Module } from '@nestjs/common';
import { createId } from '../../shared/kernel/ids.js';
import type { AppEnvironment } from '../../shared/infra/env.js';
import { StorageModule } from '../../shared/infra/storage/storage.module.js';
import {
  APP_CLOCK,
  APP_ENVIRONMENT,
  OUTBOX_WRITER,
  UNIT_OF_WORK,
} from '../../shared/infra/tokens.js';
import type { Clock } from '../../shared/kernel/clock.js';
import type { UnitOfWork } from '../../shared/infra/unit-of-work.js';
import type { OutboxWriter } from '../../shared/ports/outbox-writer.js';
import {
  PHOTO_PROCESSOR_PORT,
  type PhotoProcessorPort,
} from '../../shared/ports/photo-processor.js';
import { STORAGE_PORT, type StoragePort } from '../../shared/ports/storage.js';
import { AUDIT_WRITER, type AuditWriter } from '../../shared/ports/audit-writer.js';
import { PARAMETER_READER, type ParameterReader } from '../../shared/ports/parameter-reader.js';
import { OrderDeliveredSubscriber } from './adapters/in/order-delivered.subscriber.js';
import {
  OrderPaymentsController,
  PaymentsController,
  SettlementsController,
} from './adapters/in/payments.controller.js';
import {
  DrizzleLedgerRepository,
  DrizzlePaymentRepository,
  DrizzlePaymentsMetricsQuery,
  DrizzleSettlementRepository,
} from './adapters/out/drizzle-payments-repositories.js';
import { PaymentsService } from './application/payments-service.js';
import {
  PAYMENTS_MAINTENANCE,
  PAYMENTS_METRICS,
  PAYMENTS_OUTBOX_SUBSCRIBER,
  PAYMENTS_SERVICE,
  type PaymentsMaintenanceApi,
} from './application/payments-tokens.js';
import {
  DELIVERING_CARRIER_PORT,
  PAYMENT_ORDER_PORT,
  PAYMENTS_SETTINGS,
  type DeliveringCarrierPort,
  type PaymentOrderPort,
  type PaymentsSettings,
} from './ports/payments-ports.js';

@Module({
  imports: [StorageModule],
  controllers: [OrderPaymentsController, PaymentsController, SettlementsController],
  providers: [
    DrizzlePaymentRepository,
    DrizzleLedgerRepository,
    DrizzleSettlementRepository,
    DrizzlePaymentsMetricsQuery,
    { provide: PAYMENTS_METRICS, useExisting: DrizzlePaymentsMetricsQuery },
    {
      provide: PAYMENTS_SETTINGS,
      inject: [APP_ENVIRONMENT],
      useFactory: (env: AppEnvironment): PaymentsSettings => ({
        proofMaxBytes: env.PAYMENT_PROOF_MAX_BYTES,
        proofUploadUrlTtlSeconds: env.PAYMENT_PROOF_UPLOAD_URL_TTL_SECONDS,
        proofDownloadUrlTtlSeconds: env.PAYMENT_PROOF_DOWNLOAD_URL_TTL_SECONDS,
        // Proofs go through the same image limits as lot photos.
        image: {
          maxInputPixels: env.CATALOG_PHOTO_MAX_INPUT_PIXELS,
          maxInputDimension: env.CATALOG_PHOTO_MAX_INPUT_DIMENSION,
          maxOutputDimension: env.CATALOG_PHOTO_MAX_OUTPUT_DIMENSION,
          quality: env.CATALOG_PHOTO_WEBP_QUALITY,
        },
      }),
    },
    {
      provide: PAYMENTS_SERVICE,
      inject: [
        DrizzlePaymentRepository,
        DrizzleLedgerRepository,
        DrizzleSettlementRepository,
        PAYMENT_ORDER_PORT,
        DELIVERING_CARRIER_PORT,
        STORAGE_PORT,
        PHOTO_PROCESSOR_PORT,
        OUTBOX_WRITER,
        UNIT_OF_WORK,
        APP_CLOCK,
        PAYMENTS_SETTINGS,
        AUDIT_WRITER,
        PARAMETER_READER,
      ],
      useFactory: (
        payments: DrizzlePaymentRepository,
        ledger: DrizzleLedgerRepository,
        settlements: DrizzleSettlementRepository,
        orders: PaymentOrderPort,
        carriers: DeliveringCarrierPort,
        storage: StoragePort,
        processor: PhotoProcessorPort,
        outbox: OutboxWriter,
        uow: UnitOfWork,
        clock: Clock,
        settings: PaymentsSettings,
        audit: AuditWriter,
        parameters: ParameterReader,
      ) =>
        new PaymentsService(
          payments,
          ledger,
          settlements,
          orders,
          carriers,
          storage,
          processor,
          outbox,
          uow,
          clock,
          settings,
          audit,
          parameters,
          createId,
        ),
    },
    {
      provide: PAYMENTS_MAINTENANCE,
      inject: [PAYMENTS_SERVICE],
      useFactory: (service: PaymentsService): PaymentsMaintenanceApi => ({
        issueDueSettlements: () => service.issueDueSettlements(),
      }),
    },
    {
      provide: PAYMENTS_OUTBOX_SUBSCRIBER,
      inject: [PAYMENTS_SERVICE],
      useFactory: (service: PaymentsService) => new OrderDeliveredSubscriber(service),
    },
  ],
  exports: [PAYMENTS_SERVICE, PAYMENTS_MAINTENANCE, PAYMENTS_OUTBOX_SUBSCRIBER, PAYMENTS_METRICS],
})
export class PaymentsModule {}
