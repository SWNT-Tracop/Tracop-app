import { Controller, Get, Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/index.js';
import { SharedInfraModule } from '../shared/infra/shared-infra.module.js';

@Controller('health')
class HealthController {
  @Get()
  getHealth(): { status: string } {
    return { status: 'ok' };
  }
}

@Module({ imports: [SharedInfraModule, IdentityModule], controllers: [HealthController] })
export class AppModule {}
