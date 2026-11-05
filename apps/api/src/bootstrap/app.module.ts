import { Controller, Get, Module } from '@nestjs/common';
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

@Module({
  imports: [
    SharedInfraModule,
    AuthModule,
    CatalogBridgeModule,
    CatalogSyncBridgeModule,
    CatalogModule,
    SyncModule,
    IdentityBridgeModule,
    MessagingModule,
    IdentityModule,
    OtpDeliveryModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
