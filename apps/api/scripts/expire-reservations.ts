import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/bootstrap/app.module.js';
import { OrderingService } from '../src/modules/ordering/application/ordering-service.js';

const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
try {
  const ordering = app.get(OrderingService);
  const now = new Date();
  let totalExpired = 0;
  let batchExpired: number;
  do {
    batchExpired = await ordering.expireReservations(now, 100);
    totalExpired += batchExpired;
  } while (batchExpired > 0);
  process.stdout.write(`Expired ${totalExpired} order reservations.\n`);
} finally {
  await app.close();
}
