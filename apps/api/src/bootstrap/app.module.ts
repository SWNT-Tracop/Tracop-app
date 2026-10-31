import { Controller, Get, Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/index.js';
import { MessagingModule } from '../modules/messaging/index.js';
import { SharedInfraModule } from '../shared/infra/shared-infra.module.js';
import { IdentityBridgeModule } from './identity-bridge.module.js';
import { OtpDeliveryModule } from './otp-delivery.module.js';

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
    IdentityBridgeModule,
    MessagingModule,
    IdentityModule,
    OtpDeliveryModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
