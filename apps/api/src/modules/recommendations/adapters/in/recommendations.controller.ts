import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  alertResponseSchema,
  createAlertSchema,
  createMappingSchema,
  mappingResponseSchema,
  priceSuggestionQuerySchema,
  priceSuggestionResponseSchema,
  recommendationsQuerySchema,
  recommendationsResponseSchema,
} from '@tracop/contracts';
import { z } from 'zod';
import { AuthGuard, type AuthPrincipal } from '../../../../shared/auth/index.js';
import { DomainError } from '../../../../shared/kernel/domain-error.js';
import { ApiErrorResponses, ApiZodBody, ApiZodResponse } from '../../../../shared/infra/openapi.js';
import type {
  RecommendationsService,
  SuggestionView,
} from '../../application/recommendations-service.js';
import {
  RECOMMENDATION_CURSOR_CODEC,
  RECOMMENDATIONS_SERVICE,
} from '../../application/recommendations-tokens.js';
import type { AlertProps } from '../../domain/alerts.js';
import type { SourceMapping } from '../../ports/recommendations-ports.js';
import type { RecommendationCursorCodec } from './recommendation-cursor.js';

type AuthenticatedRequest = { readonly identity: AuthPrincipal };

const serializeSuggestion = (view: SuggestionView) =>
  view.suggestion.status === 'ok'
    ? {
        status: 'ok' as const,
        productId: view.productId,
        unit: view.unit,
        low: view.suggestion.low.toString(),
        median: view.suggestion.median.toString(),
        high: view.suggestion.high.toString(),
        sources: view.suggestion.sources.map((source) => ({
          name: source.name,
          count: source.count,
          observedAt: source.observedAt.toISOString(),
        })),
        citation: view.citation,
      }
    : { status: 'insufficient_data' as const, productId: view.productId, unit: view.unit };

const serializeAlert = (alert: AlertProps) => ({
  id: alert.id,
  productId: alert.productId,
  maxPrice: alert.maxPrice.toString(),
  radiusKm: alert.radiusKm,
  centerLat: alert.centerLat,
  centerLng: alert.centerLng,
  createdAt: alert.createdAt.toISOString(),
});

const serializeMapping = (mapping: SourceMapping) => ({
  id: mapping.id,
  productId: mapping.productId,
  unit: mapping.unit,
  source: mapping.source,
  sourceProduct: mapping.sourceProduct,
  presentation: mapping.presentation,
  createdAt: mapping.createdAt.toISOString(),
});

const id = '018f47a2-8b45-7cc2-9a1e-123456789abc';

@ApiTags('recommendations')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller()
export class RecommendationsController {
  constructor(
    @Inject(RECOMMENDATIONS_SERVICE) private readonly service: RecommendationsService,
    @Inject(RECOMMENDATION_CURSOR_CODEC) private readonly cursors: RecommendationCursorCodec,
  ) {}

  @Get('pricing/suggestion')
  @ApiOperation({
    summary: 'Rango de precio sugerido (productor, proveedor)',
    description:
      'Percentiles 25–75 de los precios de referencia (DANE-SIPSA) y, con al menos 3 observaciones ' +
      'propias de 2 o más proveedores, también de los precios de TRACOP. Nunca un precio individual; ' +
      'con menos de 3 valores responde `insufficient_data`. Es solo una sugerencia, con su fuente y fecha.',
  })
  @ApiQuery({ name: 'productId', schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'unit', schema: { type: 'string' } })
  @ApiZodResponse(200, priceSuggestionResponseSchema, {
    status: 'ok',
    productId: id,
    unit: 'bulto',
    low: '85000',
    median: '90000',
    high: '96000',
    sources: [{ name: 'DANE-SIPSA', count: 12, observedAt: '2026-11-24T00:00:00.000Z' }],
    citation: 'Fuente: Departamento Administrativo Nacional de Estadística: www.dane.gov.co',
  })
  @ApiErrorResponses(400, 401, 403, 404, 429)
  async suggestion(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const { productId, unit } = priceSuggestionQuerySchema.parse(query);
    return serializeSuggestion(await this.service.suggestion(req.identity, productId, unit));
  }

  @Get('recommendations/lots')
  @ApiOperation({
    summary: 'Lotes recomendados (comprador)',
    description:
      'Orden determinista por puntuación con razones en códigos (reorder, nearby, good_price, ' +
      'verified_provider, fresh). Solo lotes disponibles; usa solo el historial del propio comprador. ' +
      'La distancia es un entero en km desde el punto enviado (lat y lng juntos); no se devuelven ' +
      'coordenadas. cursor es opaco.',
  })
  @ApiZodResponse(200, recommendationsResponseSchema, {
    items: [
      {
        lotId: id,
        productId: id,
        unit: 'bulto',
        unitPrice: '88000',
        distanceKm: 12,
        score: 70,
        reasons: ['reorder', 'nearby', 'good_price'],
      },
    ],
    nextCursor: null,
  })
  @ApiErrorResponses(400, 401, 403, 429)
  async recommendations(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const input = recommendationsQuerySchema.parse(query);
    const after = input.cursor ? this.cursors.decode(input.cursor) : undefined;
    if (after === null) throw new DomainError('Cursor inválido.', 'invalid_cursor');
    const page = await this.service.recommendLots(req.identity, {
      ...(input.lat !== undefined && input.lng !== undefined
        ? { lat: input.lat, lng: input.lng }
        : {}),
      ...(input.radiusKm !== undefined ? { radiusKm: input.radiusKm } : {}),
      limit: input.limit,
      ...(after ? { after } : {}),
    });
    return {
      items: page.items.map((item) => ({ ...item, unitPrice: item.unitPrice.toString() })),
      nextCursor: page.next ? this.cursors.encode(page.next) : null,
    };
  }

  @Post('alerts')
  @ApiOperation({
    summary: 'Crear una alerta de precio (comprador)',
    description:
      'Avisa cuando se publique un lote del producto dentro del radio y bajo el precio máximo. ' +
      'Idempotente por id. El centro se guarda redondeado a 2 decimales. Máximo de alertas por usuario.',
  })
  @ApiZodBody(createAlertSchema, {
    id,
    productId: id,
    maxPrice: 90000,
    radiusKm: 50,
    lat: 4.65,
    lng: -74.1,
  })
  @ApiZodResponse(201, alertResponseSchema, {
    id,
    productId: id,
    maxPrice: '90000',
    radiusKm: 50,
    centerLat: 4.65,
    centerLng: -74.1,
    createdAt: '2026-11-25T15:00:00.000Z',
  })
  @ApiErrorResponses(400, 401, 403, 404, 409, 429)
  async createAlert(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { status(code: number): unknown },
  ) {
    const input = createAlertSchema.parse(body);
    const result = await this.service.createAlert(req.identity, {
      ...input,
      maxPrice: BigInt(input.maxPrice),
    });
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return serializeAlert(result.alert);
  }

  @Get('alerts')
  @ApiOperation({ summary: 'Mis alertas de precio (comprador)' })
  @ApiZodResponse(200, z.object({ items: z.array(alertResponseSchema) }), { items: [] })
  @ApiErrorResponses(401, 403)
  async listAlerts(@Req() req: AuthenticatedRequest) {
    return { items: (await this.service.listAlerts(req.identity)).map(serializeAlert) };
  }

  @Delete('alerts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borrar una alerta propia (comprador); la de otro responde 404' })
  @ApiErrorResponses(400, 401, 403, 404)
  async deleteAlert(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) alertId: string) {
    await this.service.deleteAlert(req.identity, alertId);
  }

  @Get('pricing/mappings')
  @ApiOperation({ summary: 'Asociaciones producto ↔ fuente de precios (operator, admin)' })
  @ApiQuery({ name: 'productId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiZodResponse(200, z.object({ items: z.array(mappingResponseSchema) }), { items: [] })
  @ApiErrorResponses(400, 401, 403)
  async listMappings(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const { productId } = z
      .object({ productId: z.string().uuid().optional() })
      .strict()
      .parse(query);
    return {
      items: (await this.service.listMappings(req.identity, productId)).map(serializeMapping),
    };
  }

  @Post('pricing/mappings')
  @ApiOperation({
    summary:
      'Asociar un producto del catálogo con un producto y presentación de DANE-SIPSA (operator, admin)',
    description:
      'La unidad es la del producto del catálogo: el personal confirma que la presentación de la ' +
      'fuente corresponde a esa unidad; no se calcula ninguna equivalencia. Auditado.',
  })
  @ApiZodBody(createMappingSchema, {
    id,
    productId: id,
    sourceProduct: 'Papa criolla limpia',
    presentation: 'bulto 50 kg',
  })
  @ApiZodResponse(201, mappingResponseSchema, {
    id,
    productId: id,
    unit: 'bulto',
    source: 'DANE-SIPSA',
    sourceProduct: 'papa criolla limpia',
    presentation: 'bulto 50 kg',
    createdAt: '2026-11-25T15:00:00.000Z',
  })
  @ApiErrorResponses(400, 401, 403, 404, 409)
  async createMapping(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return serializeMapping(
      await this.service.createMapping(req.identity, createMappingSchema.parse(body)),
    );
  }

  @Delete('pricing/mappings/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borrar una asociación (operator, admin). Auditado.' })
  @ApiErrorResponses(400, 401, 403, 404)
  async deleteMapping(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) mappingId: string,
  ) {
    await this.service.deleteMapping(req.identity, mappingId);
  }
}
