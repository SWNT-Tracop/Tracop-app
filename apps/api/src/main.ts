import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './bootstrap/app.module.js';
import { configureHttp } from './bootstrap/http.js';
import { loadAppEnvironment } from './shared/infra/env.js';
import { APP_LOGGER } from './shared/infra/tokens.js';
import { NestPinoLogger } from './shared/infra/nest-pino-logger.js';

const bootstrap = async (): Promise<void> => {
  const environment = loadAppEnvironment();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  configureHttp(app);
  app.useLogger(new NestPinoLogger(app.get(APP_LOGGER)));
  app.getHttpAdapter().getInstance().set('trust proxy', environment.TRUST_PROXY);
  app.enableShutdownHooks();
  const documentConfig = new DocumentBuilder()
    .setTitle('TRACOP API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, documentConfig));
  await app.listen(environment.PORT);
};

void bootstrap();
