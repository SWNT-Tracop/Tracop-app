import {
  Controller,
  Get,
  Header,
  Inject,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { locationPackResponseSchema, stopLocationResponseSchema } from '@tracop/contracts';
import { AuthGuard, type AuthPrincipal } from '../../../../shared/auth/index.js';
import { ApiErrorResponses, ApiZodResponse } from '../../../../shared/infra/openapi.js';
import { TripLocationService, type StopLocation } from '../../application/trip-location.service.js';

type AuthenticatedRequest = { readonly identity: AuthPrincipal };

const serializeStop = (stop: StopLocation) => ({
  stopId: stop.stopId,
  kind: stop.kind,
  orderId: stop.orderId,
  ...(stop.points ? { points: stop.points } : {}),
  ...(stop.address !== undefined ? { address: stop.address } : {}),
});

const id = '018f47a2-8b45-7cc2-9a1e-123456789abc';

/**
 * Exact locations (ADR-013). Who may see them is decided by TripLocationService; every request
 * is audited and rate limited, and responses must not be cached anywhere.
 */
@ApiTags('logistics')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('logistics')
export class TripLocationController {
  constructor(@Inject(TripLocationService) private readonly locations: TripLocationService) {}

  @Get('trips/:id/stops/:stopId/location')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Ubicación exacta de una parada (transportista asignado, operator, admin)',
    description:
      'Recogida: coordenadas de los lotes del pedido (`points`, sin duplicados, máximo 20). ' +
      'Entrega: dirección completa (`address`). Solo con el viaje `assigned` o `in_progress` y la ' +
      'parada sin completar; cualquier otro caso responde 404. Auditado (`location.view`) y con ' +
      'límite de tasa. No guardar en caché ni en registros.',
  })
  @ApiZodResponse(200, stopLocationResponseSchema, {
    stopId: id,
    kind: 'pickup',
    orderId: id,
    points: [{ lat: 5.53, lng: -73.36 }],
  })
  @ApiErrorResponses(400, 401, 404, 429)
  async stopLocation(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) tripId: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
  ) {
    return serializeStop(await this.locations.stopLocation(req.identity, tripId, stopId));
  }

  @Get('trips/:id/location-pack')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Ubicaciones de las paradas pendientes, para trabajar sin señal',
    description:
      'Mismas reglas que la ubicación de una parada. `expiresAt` es el menor entre el fin previsto ' +
      'del viaje y `LOGISTICS_LOCATION_MAX_TTL_HOURS` (24 h, PROVISIONAL): la app debe guardarlo ' +
      'cifrado y borrarlo al completar o cancelar el viaje y al llegar `expiresAt`.',
  })
  @ApiZodResponse(200, locationPackResponseSchema, {
    tripId: id,
    expiresAt: '2026-11-26T15:00:00.000Z',
    stops: [{ stopId: id, kind: 'delivery', orderId: id, address: 'Calle 1 # 2-3, Bogotá' }],
  })
  @ApiErrorResponses(400, 401, 404, 429)
  async locationPack(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) tripId: string) {
    const pack = await this.locations.locationPack(req.identity, tripId);
    return {
      tripId: pack.tripId,
      expiresAt: pack.expiresAt.toISOString(),
      stops: pack.stops.map(serializeStop),
    };
  }
}
