import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/bootstrap/app.module.js';
import { CatalogService } from '../src/modules/catalog/index.js';

const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
try {
  const result = await app.get(CatalogService).backfillChanges();
  process.stdout.write(
    `Backfilled ${result.recorded} catalog entities; skipped ${result.skipped}.\n`,
  );
} finally {
  await app.close();
}
