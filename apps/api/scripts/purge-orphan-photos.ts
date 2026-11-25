import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/bootstrap/app.module.js';
import { LotPhotoService } from '../src/modules/catalog/application/lot-photo-service.js';

const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
try {
  const count = await app.get(LotPhotoService).purgeOrphans();
  process.stdout.write(`Removed ${count} orphan catalog photo objects.\n`);
} finally {
  await app.close();
}
