import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import type pino from 'pino';
import type { HttpMetrics } from '../shared/infra/http-metrics.js';
import { newRequestContext, runWithRequestContext } from '../shared/infra/request-context.js';

export const WEBHOOK_BODY_LIMIT = '64kb';

export const configureHttp = (
  app: INestApplication,
  syncPushBodyLimitBytes = 256 * 1024,
  allowedCorsOrigins: readonly string[] = [],
  /** Request logs and metrics; main.ts passes both, minimal test apps may omit them. */
  observability: { readonly logger?: pino.Logger; readonly metrics?: HttpMetrics } = {},
): void => {
  const expressApp = app as NestExpressApplication;
  // Security headers. The API only returns JSON, so the content policy forbids everything;
  // Swagger UI (/docs, outside production) needs its own scripts and styles.
  const apiHeaders = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
    },
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
    referrerPolicy: { policy: 'no-referrer' },
  });
  const docsHeaders = helmet({ strictTransportSecurity: false });
  expressApp.disable('x-powered-by');
  expressApp.use((request: Request, response: Response, next: NextFunction) =>
    (request.path === '/docs' || request.path.startsWith('/docs/') ? docsHeaders : apiHeaders)(
      request,
      response,
      next,
    ),
  );
  const { logger, metrics } = observability;
  // Every request gets a context (request id, client IP honoring TRUST_PROXY) for the audit log,
  // and one structured log line plus metrics when it finishes: method, route template, status
  // and duration. Never the concrete path, query, body or IP.
  expressApp.use((request: Request, response: Response, next: NextFunction) => {
    const context = newRequestContext(request.ip);
    const startedAt = process.hrtime.bigint();
    response.setHeader('X-Request-Id', context.requestId);
    response.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const routePath = (request as Request & { route?: { path?: string } }).route?.path;
      const route = routePath ? `${request.baseUrl}${routePath}` : 'unmatched';
      metrics?.record(request.method, route, response.statusCode, durationMs);
      logger?.info(
        {
          event: 'http_request',
          requestId: context.requestId,
          method: request.method,
          route,
          status: response.statusCode,
          durationMs: Math.round(durationMs),
        },
        'HTTP request.',
      );
    });
    runWithRequestContext(context, next);
  });
  expressApp.use((request: Request, response: Response, next: NextFunction) => {
    if (request.path === '/webhooks/telegram') {
      next();
      return;
    }
    const origin = request.headers.origin;
    if (typeof origin === 'string' && allowedCorsOrigins.includes(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
      response.setHeader('Access-Control-Expose-Headers', 'Retry-After');
      response.setHeader('Access-Control-Max-Age', '600');
      if (request.method === 'OPTIONS') {
        response.status(204).end();
        return;
      }
    }
    next();
  });
  expressApp.useBodyParser('json', {
    limit: WEBHOOK_BODY_LIMIT,
    type: (request: { readonly path: string }) => request.path !== '/sync/push',
  });
  expressApp.useBodyParser('json', {
    limit: syncPushBodyLimitBytes,
    type: (request: { readonly path: string }) => request.path === '/sync/push',
  });
};
