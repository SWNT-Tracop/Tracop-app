import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './bootstrap/app.module.js';
import { configureHttp } from './bootstrap/http.js';
import { loadAppEnvironment } from './shared/infra/env.js';
import { APP_LOGGER } from './shared/infra/tokens.js';
import { HTTP_METRICS } from './shared/ports/operations.js';
import { NestPinoLogger } from './shared/infra/nest-pino-logger.js';
import { setupSwagger } from './shared/infra/swagger.js';

const bootstrap = async (): Promise<void> => {
  const environment = loadAppEnvironment();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  configureHttp(app, environment.SYNC_PUSH_MAX_BODY_BYTES, environment.allowedCorsOrigins, {
    logger: app.get(APP_LOGGER),
    metrics: app.get(HTTP_METRICS),
  });
  app.useLogger(new NestPinoLogger(app.get(APP_LOGGER)));
  app.getHttpAdapter().getInstance().set('trust proxy', environment.TRUST_PROXY);
  app.enableShutdownHooks();
  // The interactive docs are only for local development, never in the demo or production.
  if (environment.APP_PROFILE === 'development') setupSwagger(app, environment.NODE_ENV);
  await app.listen(environment.PORT);
};

void bootstrap();
