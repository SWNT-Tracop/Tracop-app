import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthGuard, type AuthPrincipal } from '../../../../shared/auth/index.js';
import { TrustService } from '../../application/trust-service.js';

@ApiTags('trust')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('trust')
export class TrustController {
  constructor(private readonly trust: TrustService) {}

  @Get('orders/:id/trace')
  @ApiOperation({ summary: 'Verificar la trazabilidad de un pedido' })
  @ApiResponse({ status: 200, description: 'Cadena de eventos y resultado de integridad.' })
  @ApiResponse({ status: 401, description: 'No autenticado' })
  @ApiResponse({ status: 404, description: 'Pedido no encontrado' })
  async getOrderTrace(
    @Req() req: { identity: AuthPrincipal },
    @Param('id', new ParseUUIDPipe({ version: '7' })) orderId: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.trust.getOrderTrace(req.identity, orderId);
    return {
      orderId: result.orderId,
      integrity: result.integrity,
      events: result.events.map((event) => ({
        id: event.id,
        type: event.type,
        actorId: event.actorId,
        occurredAt: event.occurredAt.toISOString(),
        payload: event.payload,
        prevHash: event.prevHash,
        hash: event.hash,
      })),
    };
  }
}
