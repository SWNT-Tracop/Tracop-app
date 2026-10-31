import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/bootstrap/app.module.js';
import { CatalogService } from '../src/modules/catalog/application/catalog-service.js';

const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
try {
  const count = await app.get(CatalogService).expireLots();
  process.stdout.write(`Expired ${count} catalog lots.\n`);
} finally {
  await app.close();
}
