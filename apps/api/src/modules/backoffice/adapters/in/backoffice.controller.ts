import { Body, Controller, Get, Inject, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  auditPageResponseSchema,
  auditQuerySchema,
  metricsResponseSchema,
  parameterListResponseSchema,
  parameterResponseSchema,
  updateParameterSchema,
} from '@tracop/contracts';
import { AuthGuard, type AuthPrincipal } from '../../../../shared/auth/index.js';
import { ApiErrorResponses, ApiZodBody, ApiZodResponse } from '../../../../shared/infra/openapi.js';
import type { BackofficeService, ParameterView } from '../../application/backoffice-service.js';
import { BACKOFFICE_SERVICE } from '../../application/backoffice-tokens.js';
import type { AuditRecord, BackofficeMetrics } from '../../ports/backoffice-ports.js';

type AuthenticatedRequest = { readonly identity: AuthPrincipal };

const serializeParameter = (parameter: ParameterView) => ({
  key: parameter.key,
  unit: parameter.unit,
  value: parameter.value.toString(),
  defaultValue: parameter.defaultValue.toString(),
  min: parameter.min.toString(),
  max: parameter.max.toString(),
  provisional: parameter.provisional,
  description: parameter.description,
  updatedAt: parameter.updatedAt?.toISOString() ?? null,
});

const serializeAudit = (record: AuditRecord) => ({
  id: record.id,
  actorId: record.actorId,
  actorRole: record.actorRole,
  action: record.action,
  entity: record.entity,
  entityId: record.entityId,
  before: record.before,
  after: record.after,
  at: record.at.toISOString(),
});

const serializeMetrics = (metrics: BackofficeMetrics & { readonly generatedAt: Date }) => ({
  generatedAt: metrics.generatedAt.toISOString(),
  ordersByStatus: metrics.ordersByStatus,
  paidOrdersTotalCop: metrics.paidOrdersTotalCop.toString(),
  lotsByStatus: metrics.lotsByStatus,
  payments: {
    proofsAwaitingReview: metrics.payments.proofsAwaitingReview,
    oldestProofUploadedAt: metrics.payments.oldestProofUploadedAt?.toISOString() ?? null,
    openDisputes: metrics.payments.openDisputes,
    settlementsIssued: {
      count: metrics.payments.settlementsIssued.count,
      amountCop: metrics.payments.settlementsIssued.amountCop.toString(),
    },
    settlementsPaid: {
      count: metrics.payments.settlementsPaid.count,
      amountCop: metrics.payments.settlementsPaid.amountCop.toString(),
    },
  },
  notificationDeliveries: metrics.notificationDeliveries,
  outbox: metrics.outbox,
});

const parameterExample = {
  key: 'order.commission_rate_bps',
  unit: 'bps',
  value: '500',
  defaultValue: '0',
  min: '0',
  max: '10000',
  provisional: true,
  description: 'Comisión sobre el subtotal, en puntos básicos (100 = 1 %).',
  updatedAt: '2026-11-25T15:00:00.000Z',
};

@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('backoffice')
export class BackofficeController {
  constructor(@Inject(BACKOFFICE_SERVICE) private readonly backoffice: BackofficeService) {}

  @Get('parameters')
  @ApiOperation({
    summary: 'Parámetros de negocio (operator, finance, admin)',
    description:
      'Valor vigente, valor por defecto (del entorno), rango y si sigue PROVISIONAL (AGENTS §23).',
  })
  @ApiZodResponse(200, parameterListResponseSchema, { items: [parameterExample] })
  @ApiErrorResponses(401, 403)
  async listParameters(@Req() req: AuthenticatedRequest) {
    const items = await this.backoffice.listParameters(req.identity);
    return { items: items.map(serializeParameter) };
  }

  @Put('parameters/:key')
  @ApiOperation({
    summary: 'Cambiar un parámetro (admin)',
    description:
      'Solo hacia adelante: afecta lo que ocurra desde ahora (por ejemplo, la comisión solo aplica a ' +
      'cotizaciones nuevas). Queda en el audit log con el valor anterior y el nuevo.',
  })
  @ApiZodBody(updateParameterSchema, { value: '500' })
  @ApiZodResponse(200, parameterResponseSchema, parameterExample)
  @ApiErrorResponses(400, 401, 403, 404)
  async updateParameter(
    @Req() req: AuthenticatedRequest,
    @Param('key') key: string,
    @Body() body: unknown,
  ) {
    const { value } = updateParameterSchema.parse(body);
    return serializeParameter(await this.backoffice.updateParameter(req.identity, key, value));
  }

  @Get('metrics')
  @ApiOperation({
    summary: 'Métricas operativas (operator, finance, admin)',
    description:
      'Agregados calculados al momento por cada módulo: pedidos por estado, importe pagado, lotes, ' +
      'cola de comprobantes y disputas, liquidaciones, entregas de notificaciones y outbox. Sin datos ' +
      'personales.',
  })
  @ApiZodResponse(200, metricsResponseSchema, {
    generatedAt: '2026-11-25T15:00:00.000Z',
    ordersByStatus: { quoted: 4, paid: 2 },
    paidOrdersTotalCop: '90000',
    lotsByStatus: { published: 3, sold_out: 1 },
    payments: {
      proofsAwaitingReview: 1,
      oldestProofUploadedAt: '2026-11-25T14:00:00.000Z',
      openDisputes: 0,
      settlementsIssued: { count: 1, amountCop: '45000' },
      settlementsPaid: { count: 2, amountCop: '90000' },
    },
    notificationDeliveries: { pending: 0, sent: 12, failed: 1, skipped: 4 },
    outbox: { pending: 0, deadLettered: 0 },
  })
  @ApiErrorResponses(401, 403)
  async metrics(@Req() req: AuthenticatedRequest) {
    return serializeMetrics(await this.backoffice.metrics(req.identity));
  }

  @Get('audit')
  @ApiOperation({
    summary: 'Audit log de acciones del personal (admin)',
    description: 'Más recientes primero. No expone la IP ni su HMAC.',
  })
  @ApiZodResponse(200, auditPageResponseSchema, { items: [] })
  @ApiErrorResponses(400, 401, 403)
  async audit(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const { cursor, limit, ...filter } = auditQuerySchema.parse(query);
    const page = await this.backoffice.listAudit(req.identity, filter, cursor, limit);
    return {
      items: page.items.map(serializeAudit),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
}
