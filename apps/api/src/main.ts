import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './bootstrap/app.module.js';

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create(AppModule);
  await app.listen(Number(process.env.PORT ?? 3000));
};

void bootstrap();
