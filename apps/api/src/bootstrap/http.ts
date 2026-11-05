import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

export const WEBHOOK_BODY_LIMIT = '64kb';

export const configureHttp = (app: INestApplication, syncPushBodyLimitBytes = 256 * 1024): void => {
  const expressApp = app as NestExpressApplication;
  expressApp.useBodyParser('json', {
    limit: WEBHOOK_BODY_LIMIT,
    type: (request: { readonly path: string }) => request.path !== '/sync/push',
  });
  expressApp.useBodyParser('json', {
    limit: syncPushBodyLimitBytes,
    type: (request: { readonly path: string }) => request.path === '/sync/push',
  });
};
