import { timingSafeEqual } from 'node:crypto';
import { Controller, Get, Header, Inject, NotFoundException, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AppEnvironment } from '../shared/infra/env.js';
import type { HttpMetrics } from '../shared/infra/http-metrics.js';
import { APP_CLOCK, APP_ENVIRONMENT } from '../shared/infra/tokens.js';
import type { Clock } from '../shared/kernel/clock.js';
import { OUTBOX_METRICS, type OutboxMetricsQuery } from '../shared/ports/outbox-metrics.js';
import {
  HTTP_METRICS,
  OPERATIONS_PROBE,
  type OperationsProbe,
} from '../shared/ports/operations.js';

const sameSecret = (given: string, expected: string): boolean => {
  const left = Buffer.from(given);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

@ApiTags('health')
@Controller()
export class OperationsController {
  constructor(
    @Inject(OPERATIONS_PROBE) private readonly probe: OperationsProbe,
    @Inject(OUTBOX_METRICS) private readonly outbox: OutboxMetricsQuery,
    @Inject(HTTP_METRICS) private readonly metrics: HttpMetrics,
    @Inject(APP_ENVIRONMENT) private readonly environment: AppEnvironment,
    @Inject(APP_CLOCK) private readonly clock: Clock,
  ) {}

  @Get('ready')
  @ApiOperation({
    summary: 'Comprobar si el servicio puede atender',
    description:
      'Público. 200 si la base de datos responde y algún trabajador latió en los últimos ' +
      '`READY_WORKER_MAX_AGE_SECONDS` (180); si no, 503 indicando qué falla. No da más detalles.',
  })
  @ApiResponse({ status: 200, description: '{ status: "ready", database: "ok", worker: "ok" }' })
  @ApiResponse({ status: 503, description: '{ status: "not_ready", database, worker }' })
  async ready(@Res({ passthrough: true }) response: Response) {
    const database = await this.probe.databaseReachable();
    const beat = database ? await this.probe.latestHeartbeat().catch(() => null) : null;
    const workerAlive =
      beat !== null &&
      this.clock.now().getTime() - beat.getTime() <=
        this.environment.READY_WORKER_MAX_AGE_SECONDS * 1000;
    const body = {
      status: database && workerAlive ? 'ready' : 'not_ready',
      database: database ? 'ok' : 'unreachable',
      worker: workerAlive ? 'ok' : 'stale',
    };
    response.status(body.status === 'ready' ? 200 : 503);
    return body;
  }

  /** Prometheus text; only with `Authorization: Bearer <METRICS_TOKEN>`, otherwise 404. */
  @Get('metrics')
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async render(@Req() request: Request): Promise<string> {
    const token = this.environment.METRICS_TOKEN;
    const given = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
    if (!token || !given || !sameSecret(given, token)) throw new NotFoundException();
    const [outbox, beat] = await Promise.all([
      this.outbox.snapshot().catch(() => null),
      this.probe.latestHeartbeat().catch(() => null),
    ]);
    return this.metrics.render({
      ...(outbox
        ? {
            tracop_outbox_pending: outbox.pending,
            tracop_outbox_dead_lettered: outbox.deadLettered,
          }
        : {}),
      ...(beat
        ? {
            tracop_worker_heartbeat_age_seconds: Math.max(
              0,
              Math.floor((this.clock.now().getTime() - beat.getTime()) / 1000),
            ),
          }
        : {}),
    });
  }
}
