import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import {
  createOrderSchema,
  orderCursorQuerySchema,
  orderPageResponseSchema,
} from '@tracop/contracts';
import { z } from 'zod';
import { OrderingService } from '../../application/ordering-service.js';
import type { OrderAggregate } from '../../ports/ordering-ports.js';
import { DomainError } from '../../../../shared/kernel/domain-error.js';
import { AuthGuard, type AuthPrincipal } from '../../../../shared/auth/index.js';
import { Inject } from '@nestjs/common';
import {
  ORDER_PROVIDER_DIRECTORY,
  ORDER_PROVIDER_TRUST,
  type ProviderDirectoryPort,
  type ProviderTrustPort,
  type ProviderTrustSummary,
} from '../../ports/ordering-ports.js';

@ApiTags('ordering')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('orders')
export class OrderingController {
  constructor(
    @Inject('ORDERING_SERVICE')
    private readonly ordering: OrderingService,
    @Inject(ORDER_PROVIDER_DIRECTORY)
    private readonly providerDirectory: ProviderDirectoryPort,
    @Inject(ORDER_PROVIDER_TRUST)
    private readonly providerTrust: ProviderTrustPort,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear pedido (solo compradores)' })
  @ApiResponse({ status: 201, description: 'Pedido creado o recuperado por idempotencia' })
  @ApiResponse({ status: 400, description: 'Entrada inválida' })
  @ApiResponse({ status: 409, description: 'Conflicto de idempotencia con contenido distinto' })
  @ApiResponse({ status: 503, description: 'Lock o statement timeout' })
  async create(@Req() req: { identity: AuthPrincipal }, @Body() body: unknown) {
    const input = createOrderSchema.parse(body);
    const actor = req.identity;
    const lines = input.lines.map(({ lotId, quantityMilli }) => ({
      lotId,
      quantityMilli: BigInt(quantityMilli),
    }));
    const aggregate = await this.ordering.createOrder(actor, {
      id: input.id,
      buyerId: actor.sub,
      lines,
      deliveryAddress: input.deliveryAddress,
      deliveryWindow: input.deliveryWindow ?? null,
    });
    return this.serializeOrder(aggregate, req.identity);
  }

  @Get('mine')
  @ApiOperation({ summary: 'Listar mis pedidos (comprador)' })
  @ApiResponse({ status: 200, type: () => orderPageResponseSchema })
  @ApiResponse({ status: 401, description: 'No autenticado' })
  @ApiResponse({ status: 403, description: 'Rol no autorizado' })
  async listMine(@Req() req: { identity: AuthPrincipal }, @Query() query: unknown) {
    const { cursor, limit } = orderCursorQuerySchema.parse(query);
    const actor = req.identity;
    const result = await this.ordering.listMine(actor.sub, cursor, limit);
    // One trust lookup per page (at most 100 orders, in chunks of 50), not one per order.
    const trust = await this.trustFor(result.items.map((a) => a.order.providerId));
    return {
      items: await Promise.all(result.items.map((a) => this.serializeOrder(a, actor, trust))),
      nextCursor: result.nextCursor,
    };
  }

  @Get('incoming')
  @ApiOperation({ summary: 'Listar pedidos entrantes (productor/proveedor, solo accepted+)' })
  @ApiResponse({ status: 200, type: () => orderPageResponseSchema })
  @ApiResponse({ status: 401, description: 'No autenticado' })
  @ApiResponse({ status: 403, description: 'Rol no autorizado' })
  async listIncoming(@Req() req: { identity: AuthPrincipal }, @Query() query: unknown) {
    const actor = req.identity;
    if (actor.role !== 'producer' && actor.role !== 'supplier') {
      throw new DomainError('Rol no autorizado.', 'forbidden');
    }
    const { cursor, limit } = orderCursorQuerySchema.parse(query);
    const result = await this.ordering.listIncoming(actor.sub, cursor, limit);
    return {
      items: await Promise.all(result.items.map((a) => this.serializeOrder(a, actor))),
      nextCursor: result.nextCursor,
    };
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Aceptar cotización (comprador)' })
  @ApiResponse({ status: 200, description: 'Cotización aceptada' })
  @ApiResponse({ status: 404, description: 'Pedido inexistente o de otro comprador (not_found)' })
  @ApiResponse({
    status: 409,
    description: 'quote_expired, lot_unavailable, insufficient_stock o conflicto de versión',
  })
  @ApiResponse({ status: 503, description: 'Lock o statement timeout' })
  async accept(
    @Req() req: { identity: AuthPrincipal },
    @Param('id') id: string,
    @Body() body: { expectedVersion: number },
  ) {
    const actor = req.identity;
    const input = z.object({ expectedVersion: z.number().int().positive() }).parse(body);
    const aggregate = await this.ordering.acceptQuote({
      actor,
      orderId: id,
      expectedVersion: input.expectedVersion,
    });
    return this.serializeOrder(aggregate, actor);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancelar pedido (comprador o proveedor según estado)' })
  @ApiResponse({ status: 200, description: 'Pedido cancelado' })
  @ApiResponse({
    status: 404,
    description: 'Pedido inexistente o ajeno: ni comprador ni proveedor (not_found)',
  })
  @ApiResponse({ status: 409, description: 'Estado no permite cancelación o versión obsoleta' })
  @ApiResponse({ status: 503, description: 'Lock o statement timeout' })
  async cancel(
    @Req() req: { identity: AuthPrincipal },
    @Param('id') id: string,
    @Body() body: { expectedVersion: number; reason?: string },
  ) {
    const actor = req.identity;
    const input = z
      .object({
        expectedVersion: z.number().int().positive(),
        reason: z.string().max(200).optional(),
      })
      .parse(body);
    const cancelInput: {
      actor: AuthPrincipal;
      orderId: string;
      expectedVersion: number;
      reason?: string;
    } = { actor, orderId: id, expectedVersion: input.expectedVersion };
    if (input.reason !== undefined) cancelInput.reason = input.reason;
    const aggregate = await this.ordering.cancelOrder(cancelInput);
    return this.serializeOrder(aggregate, actor);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Consultar pedido (comprador o proveedor del pedido)' })
  @ApiResponse({ status: 200, description: 'Detalle del pedido' })
  @ApiResponse({ status: 401, description: 'No autenticado' })
  @ApiResponse({ status: 403, description: 'No es participante del pedido' })
  @ApiResponse({ status: 404, description: 'Pedido no encontrado' })
  async getById(@Req() req: { identity: AuthPrincipal }, @Param('id') id: string) {
    const actor = req.identity;
    const aggregate = await this.ordering.getById(actor, id);
    if (!aggregate) throw new DomainError('Pedido no encontrado.', 'not_found');
    return this.serializeOrder(aggregate, actor);
  }

  private async trustFor(
    providerIds: readonly string[],
  ): Promise<ReadonlyMap<string, ProviderTrustSummary>> {
    const ids = [...new Set(providerIds)];
    const merged = new Map<string, ProviderTrustSummary>();
    for (let start = 0; start < ids.length; start += 50)
      for (const [id, trust] of await this.providerTrust.get(ids.slice(start, start + 50)))
        merged.set(id, trust);
    return merged;
  }

  private async serializeOrder(
    aggregate: OrderAggregate,
    actor?: AuthPrincipal,
    prefetchedTrust?: ReadonlyMap<string, ProviderTrustSummary>,
  ): Promise<Record<string, unknown>> {
    const isBuyer = actor?.sub === aggregate.order.buyerId;
    const base = {
      id: aggregate.order.id,
      status: aggregate.order.status,
      version: aggregate.order.version,
      createdAt: aggregate.order.createdAt.toISOString(),
      lines: aggregate.lines.map((l) => ({
        lotId: l.lotId,
        quantityMilli: l.quantityMilli.toString(),
        unit: l.unit,
        unitPrice: l.unitPrice.toString(),
      })),
      subtotal: aggregate.quote.subtotal.toString(),
      freight: aggregate.quote.freight.toString(),
      commission: aggregate.quote.commission.toString(),
      total: aggregate.quote.total.toString(),
      providerNet: aggregate.quote.providerNet.toString(),
      acceptedAt: aggregate.order.acceptedAt,
      cancelReason: aggregate.order.cancelReason,
      quoteValidUntil: aggregate.quote.validUntil.toISOString(),
    };
    if (isBuyer) {
      const providerId = aggregate.order.providerId;
      const summaries = await this.providerDirectory.getProviderPublicSummaries([providerId]);
      const summary = summaries.get(providerId);
      const trust = (prefetchedTrust ?? (await this.trustFor([providerId]))).get(providerId) ?? {
        verified: false,
        rating: null,
        ratingsCount: 0,
      };
      return {
        ...base,
        provider: summary ? { ...summary, ...trust } : null,
        deliveryAddress: aggregate.order.deliveryAddress,
        deliveryWindow: aggregate.order.deliveryWindow,
      };
    }
    // Provider view: no delivery address or window
    return base;
  }
}
