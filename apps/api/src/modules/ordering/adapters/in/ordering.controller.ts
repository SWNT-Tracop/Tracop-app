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

type Actor = { readonly sub: string; readonly role: string };

@ApiTags('ordering')
@ApiBearerAuth()
@Controller('orders')
export class OrderingController {
  constructor(private readonly ordering: OrderingService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear pedido (solo compradores)' })
  @ApiResponse({ status: 201, description: 'Pedido creado o recuperado por idempotencia' })
  @ApiResponse({ status: 400, description: 'Entrada inválida' })
  @ApiResponse({ status: 409, description: 'Conflicto de idempotencia con contenido distinto' })
  async create(@Req() req: { identity: Actor }, @Body() body: unknown) {
    const input = createOrderSchema.parse(body);
    const actor = req.identity;
    const lines = input.lines.map(({ lotId, quantityMilli }) => ({
      lotId,
      quantityMilli: BigInt(quantityMilli),
    }));
    const aggregate = await this.ordering.createOrder(actor, {
      buyerId: actor.sub,
      lines,
      deliveryAddress: input.deliveryAddress,
      deliveryWindow: input.deliveryWindow ?? null,
    });
    return this.serializeOrder(aggregate);
  }

  @Get('mine')
  @ApiOperation({ summary: 'Listar mis pedidos (comprador)' })
  @ApiResponse({ status: 200, type: () => orderPageResponseSchema })
  async listMine(@Req() req: { identity: Actor }, @Query() query: unknown) {
    const { cursor, limit } = orderCursorQuerySchema.parse(query);
    const result = await this.ordering.listMine(req.identity.sub, cursor, limit);
    return { items: result.items.map(this.serializeOrder), nextCursor: result.nextCursor };
  }

  @Get('incoming')
  @ApiOperation({ summary: 'Listar pedidos entrantes (proveedor, solo accepted+)' })
  @ApiResponse({ status: 200, type: () => orderPageResponseSchema })
  async listIncoming(@Req() req: { identity: Actor }, @Query() query: unknown) {
    const { cursor, limit } = orderCursorQuerySchema.parse(query);
    const result = await this.ordering.listIncoming(req.identity.sub, cursor, limit);
    return { items: result.items.map(this.serializeOrder), nextCursor: result.nextCursor };
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Aceptar cotización (comprador)' })
  @ApiResponse({ status: 200, description: 'Cotización aceptada' })
  @ApiResponse({ status: 409, description: 'Versión obsoleta o cotización expirada' })
  async accept(
    @Req() req: { identity: Actor },
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
    return this.serializeOrder(aggregate);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancelar pedido (comprador o proveedor según estado)' })
  @ApiResponse({ status: 200, description: 'Pedido cancelado' })
  @ApiResponse({ status: 403, description: 'No autorizado' })
  @ApiResponse({ status: 409, description: 'Estado no permite cancelación o versión obsoleta' })
  async cancel(
    @Req() req: { identity: Actor },
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
    const cancelInput: { actor: Actor; orderId: string; expectedVersion: number; reason?: string } =
      { actor, orderId: id, expectedVersion: input.expectedVersion };
    if (input.reason !== undefined) cancelInput.reason = input.reason;
    const aggregate = await this.ordering.cancelOrder(cancelInput);
    return this.serializeOrder(aggregate);
  }

  private serializeOrder(aggregate: OrderAggregate) {
    return {
      id: aggregate.order.id,
      status: aggregate.order.status,
      providerId: aggregate.order.providerId,
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
      deliveryAddress: aggregate.order.deliveryAddress,
      deliveryWindow: aggregate.order.deliveryWindow,
      acceptedAt: aggregate.order.acceptedAt,
      cancelReason: aggregate.order.cancelReason,
      quoteValidUntil: aggregate.quote.validUntil.toISOString(),
    };
  }
}
