import { Module } from '@nestjs/common';
import { SharedInfraModule } from '../../shared/infra/shared-infra.module.js';
import { OrderingModule } from '../ordering/index.js';
import { TrustController } from './adapters/in/trust.controller.js';
import { TrustService } from './application/trust-service.js';

@Module({
  imports: [SharedInfraModule, OrderingModule],
  controllers: [TrustController],
  providers: [TrustService],
  exports: [TrustService],
})
export class TrustModule {}
