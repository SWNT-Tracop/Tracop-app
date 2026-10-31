import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

export const WEBHOOK_BODY_LIMIT = '64kb';

export const configureHttp = (app: INestApplication): void => {
  (app as NestExpressApplication).useBodyParser('json', { limit: WEBHOOK_BODY_LIMIT });
};
