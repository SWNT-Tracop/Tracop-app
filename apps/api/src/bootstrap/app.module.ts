import { Controller, Get, Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/index.js';
import { MessagingModule } from '../modules/messaging/index.js';
import { SharedInfraModule } from '../shared/infra/shared-infra.module.js';
import { AuthModule } from './auth.module.js';
import { IdentityBridgeModule } from './identity-bridge.module.js';
import { OtpDeliveryModule } from './otp-delivery.module.js';
import { CatalogModule } from '../modules/catalog/index.js';
import { CatalogBridgeModule } from './catalog-bridge.module.js';

@Controller('health')
class HealthController {
  @Get()
  getHealth(): { status: string } {
    return { status: 'ok' };
  }
}

@Module({
  imports: [
    SharedInfraModule,
    AuthModule,
    CatalogBridgeModule,
    CatalogModule,
    IdentityBridgeModule,
    MessagingModule,
    IdentityModule,
    OtpDeliveryModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
