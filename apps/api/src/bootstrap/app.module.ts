import {
  AssistantPriceBridgeModule,
  RecommendationsFactsBridgeModule,
} from './recommendations-bridge.module.js';
import { RecommendationsModule } from '../modules/recommendations/index.js';
import {
  AiAssistantConversationBridgeModule,
  AiAssistantPortsBridgeModule,
} from './ai-assistant-bridge.module.js';
import { AiAssistantModule } from '../modules/ai-assistant/index.js';
import { Controller, Get, Module } from '@nestjs/common';
import { OperationsController } from './operations.controller.js';
import { IdentityModule } from '../modules/identity/index.js';
import { MessagingModule } from '../modules/messaging/index.js';
import { SharedInfraModule } from '../shared/infra/shared-infra.module.js';
import { AuthModule } from './auth.module.js';
import { IdentityBridgeModule } from './identity-bridge.module.js';
import { OtpDeliveryModule } from './otp-delivery.module.js';
import { CatalogModule } from '../modules/catalog/index.js';
import { CatalogBridgeModule } from './catalog-bridge.module.js';
import { SyncModule } from '../modules/sync/index.js';
import { CatalogSyncBridgeModule } from './catalog-sync-bridge.module.js';
import { OrderingModule } from '../modules/ordering/index.js';
import { OrderingBridgeModule } from './ordering-bridge.module.js';
import { LogisticsModule } from '../modules/logistics/index.js';
import { LogisticsBridgeModule } from './logistics-bridge.module.js';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('health')
@Controller('health')
class HealthController {
  @Get()
  @ApiOperation({
    summary: 'Comprobar disponibilidad',
    description: 'Indica que la API está disponible.',
  })
  @ApiResponse({
    status: 200,
    description: 'Servicio disponible.',
    schema: { type: 'object', properties: { status: { type: 'string', example: 'ok' } } },
  })
  @ApiResponse({
    status: 500,
    description: 'Ocurrió un error interno.',
    schema: {
      type: 'object',
      required: ['statusCode', 'message'],
      properties: {
        statusCode: { type: 'integer', example: 500 },
        message: { type: 'string', example: 'Error interno.' },
      },
    },
  })
  getHealth(): { status: string } {
    return { status: 'ok' };
  }
}

/** Modules and bridges shared by the HTTP API and the worker process. */
import { BackofficeModule } from '../modules/backoffice/index.js';
import { BackofficeBridgeModule } from './backoffice-bridge.module.js';
import { ProviderTrustBridgeModule, TrustDeliveryBridgeModule } from './trust-bridge.module.js';
import { TrustModule } from '../modules/trust/index.js';
import { LogisticsLocationBridgeModule } from './logistics-location-bridge.module.js';
import { NotificationsModule } from '../modules/notifications/index.js';
import { PaymentsModule } from '../modules/payments/index.js';
import { NotificationsBridgeModule } from './notifications-bridge.module.js';
import { PaymentsBridgeModule } from './payments-bridge.module.js';

export const APPLICATION_MODULES = [
  SharedInfraModule,
  BackofficeModule,
  AuthModule,
  CatalogBridgeModule,
  CatalogSyncBridgeModule,
  CatalogModule,
  SyncModule,
  IdentityBridgeModule,
  MessagingModule,
  IdentityModule,
  OtpDeliveryModule,
  OrderingBridgeModule,
  OrderingModule,
  LogisticsBridgeModule,
  LogisticsLocationBridgeModule,
  LogisticsModule,
  PaymentsBridgeModule,
  PaymentsModule,
  NotificationsBridgeModule,
  NotificationsModule,
  BackofficeBridgeModule,
  TrustDeliveryBridgeModule,
  ProviderTrustBridgeModule,
  TrustModule,
  RecommendationsFactsBridgeModule,
  AssistantPriceBridgeModule,
  RecommendationsModule,
  AiAssistantPortsBridgeModule,
  AiAssistantConversationBridgeModule,
  AiAssistantModule,
];

@Module({
  imports: APPLICATION_MODULES,
  controllers: [HealthController, OperationsController],
})
export class AppModule {}
