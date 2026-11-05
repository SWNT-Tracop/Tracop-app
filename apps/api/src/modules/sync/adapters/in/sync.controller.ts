import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  syncPullQuerySchema,
  syncPullResponseSchema,
  syncPushResponseSchema,
  syncPushSchema,
} from '@tracop/contracts';
import { AuthGuard, type AuthenticatedRequest } from '../../../../shared/auth/index.js';
import { ApiErrorResponses, ApiZodBody, ApiZodResponse } from '../../../../shared/infra/openapi.js';
import { SyncService } from '../../application/sync-service.js';

@ApiTags('sync')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('sync')
export class SyncController {
  constructor(@Inject(SyncService) private readonly sync: SyncService) {}

  @Post('push')
  @ApiOperation({
    summary: 'Aplicar operaciones offline',
    description:
      'Aplica hasta 50 operaciones en el orden recibido. deviceId siempre procede de la sesión autenticada.',
  })
  @ApiZodBody(syncPushSchema, {
    operations: [
      {
        opId: '0190f47a-8b45-7cc2-9a1e-123456789abc',
        entity: 'lot',
        entityId: '0190f47a-8b45-7cc2-9a1e-123456789abd',
        type: 'create',
        payload: {},
      },
    ],
  })
  @ApiZodResponse(200, syncPushResponseSchema, {
    results: [
      { opId: '0190f47a-8b45-7cc2-9a1e-123456789abc', status: 'applied', serverVersion: 1 },
    ],
  })
  @ApiErrorResponses(400, 401, 413, 429)
  async push(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = syncPushSchema.parse(body);
    const identity = request.identity!;
    return this.sync.push(
      { sub: identity.sub, role: identity.role, did: identity.did },
      input.operations,
    );
  }

  @Get('pull')
  @ApiOperation({
    summary: 'Obtener cambios sincronizables',
    description:
      'El cursor es server_seq, no una fecha. Aplique un cambio solo si su versión es mayor que la versión local; el flujo incluye cambios originados por este mismo dispositivo. Fuera de este corte: retención/compactación de change_log y processed_operations, catálogo público offline, fotos en sync y worker periódico.',
  })
  @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string', default: '0' } })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
  })
  @ApiZodResponse(200, syncPullResponseSchema, {
    changes: [],
    nextCursor: '0',
    hasMore: false,
  })
  @ApiErrorResponses(400, 401, 429)
  async pull(@Query() query: Record<string, string>, @Req() request: AuthenticatedRequest) {
    const input = syncPullQuerySchema.parse(query);
    const identity = request.identity!;
    return this.sync.pull(
      { sub: identity.sub, role: identity.role, did: identity.did },
      input.cursor,
      input.limit,
    );
  }
}
