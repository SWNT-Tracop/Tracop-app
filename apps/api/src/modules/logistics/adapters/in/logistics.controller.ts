import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  cancelTripSchema,
  carrierProfileSchema,
  createCheckinSchema,
  createTripSchema,
  logisticsLimitQuerySchema,
  openIncidentSchema,
  reassignTripSchema,
  recommendTripsQuerySchema,
  tripTransitionSchema,
} from '@tracop/contracts';
import { AuthGuard, Roles, type AuthPrincipal } from '../../../../shared/auth/index.js';
import type { CarrierProps } from '../../domain/carrier.js';
import type { CheckinProps } from '../../domain/checkin.js';
import type { IncidentProps } from '../../domain/incident.js';
import type { TripProps } from '../../domain/trip.js';
import type { TripStopProps } from '../../domain/trip-stop.js';
import { CarrierProfileService } from '../../application/carrier-profile.service.js';
import { CheckinService } from '../../application/checkin.service.js';
import { IncidentService } from '../../application/incident.service.js';
import { TripPlanningService } from '../../application/trip-planning.service.js';

type Request = { readonly identity: AuthPrincipal };

@ApiTags('logistics')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('logistics')
export class LogisticsController {
  constructor(
    @Inject(CarrierProfileService) private readonly carriers: CarrierProfileService,
    @Inject(TripPlanningService) private readonly trips: TripPlanningService,
    @Inject(CheckinService) private readonly checkins: CheckinService,
    @Inject(IncidentService) private readonly incidents: IncidentService,
  ) {}

  @Post('carrier-profile')
  @Roles('carrier')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear o actualizar mi perfil de transportista' })
  @ApiResponse({ status: 400, description: 'Solicitud inválida o no autorizada.' })
  async upsertProfile(@Req() req: Request, @Body() body: unknown) {
    const input = carrierProfileSchema.parse(body);
    return serializeCarrier(
      await this.carriers.upsertMine(req.identity, {
        vehicleType: input.vehicleType,
        capacityKg: input.capacityKg,
        plate: input.plate,
      }),
    );
  }

  @Get('carrier-profile')
  @Roles('carrier')
  @ApiOperation({ summary: 'Consultar mi perfil de transportista' })
  @ApiResponse({ status: 400, description: 'Solicitud inválida o no autorizada.' })
  async myProfile(@Req() req: Request) {
    return serializeCarrier(await this.carriers.getMine(req.identity));
  }

  @Get('carriers')
  @Roles('operator')
  @ApiOperation({ summary: 'Listar transportistas (operador)' })
  @ApiResponse({ status: 400, description: 'Solicitud inválida o no autorizada.' })
  async listCarriers(@Req() req: Request, @Query() query: unknown) {
    const { limit } = logisticsLimitQuerySchema.parse(query);
    return (await this.carriers.list(req.identity, limit)).map(serializeCarrier);
  }

  @Post('trips/recommend')
  @Roles('carrier', 'operator')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Recomendar paradas por zonas textuales (sin coordenadas)' })
  @ApiResponse({ status: 400, description: 'Solicitud inválida o no autorizada.' })
  async recommend(@Req() req: Request, @Query() query: unknown) {
    const { limit } = recommendTripsQuerySchema.parse(query);
    return this.trips.recommend(req.identity, limit);
  }

  @Get('orders/candidates')
  @Roles('carrier', 'operator')
  @ApiOperation({ summary: 'Listar pedidos pagados con datos mínimos para planear viajes' })
  @ApiResponse({
    status: 200,
    description: 'Resumen logístico sin datos personales ni dirección completa.',
  })
  @ApiResponse({ status: 400, description: 'Solicitud inválida o no autorizada.' })
  async listOrderCandidates(@Req() req: Request, @Query() query: unknown) {
    const { limit } = logisticsLimitQuerySchema.parse(query);
    return this.trips.listOrderCandidates(req.identity, limit);
  }

  @Post('trips')
  @Roles('carrier')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear viaje a partir de pedidos' })
  @ApiResponse({ status: 400, description: 'Solicitud inválida o no autorizada.' })
  async createTrip(@Req() req: Request, @Body() body: unknown) {
    const input = createTripSchema.parse(body);
    return serializeTrip(await this.trips.createTrip(req.identity, input));
  }

  @Get('trips/mine')
  @Roles('carrier')
  @ApiOperation({ summary: 'Listar mis viajes' })
  @ApiResponse({ status: 400, description: 'Solicitud inválida o no autorizada.' })
  async listMine(@Req() req: Request, @Query() query: unknown) {
    const { limit } = logisticsLimitQuerySchema.parse(query);
    return (await this.trips.listMine(req.identity, limit)).map(serializeTrip);
  }

  @Get('trips')
  @Roles('operator')
  @ApiOperation({ summary: 'Listar todos los viajes (operador)' })
  @ApiResponse({ status: 400, description: 'Solicitud inválida o no autorizada.' })
  async listTrips(@Req() req: Request, @Query() query: unknown) {
    const { limit } = logisticsLimitQuerySchema.parse(query);
    return (await this.trips.listAll(req.identity, limit)).map(serializeTrip);
  }

  @Get('trips/:id')
  @Roles('carrier', 'operator')
  @ApiOperation({ summary: 'Consultar viaje' })
  @ApiResponse({ status: 400, description: 'Solicitud inválida o no autorizada.' })
  async getTrip(@Req() req: Request, @Param('id') id: string) {
    return serializeTrip(await this.trips.findById(req.identity, id));
  }

  @Get('trips/:id/stops')
  @Roles('carrier', 'operator')
  @ApiOperation({ summary: 'Listar paradas de un viaje' })
  @ApiResponse({ status: 400, description: 'Solicitud inválida o no autorizada.' })
  async listStops(@Req() req: Request, @Param('id') id: string) {
    return (await this.trips.listStops(req.identity, id)).map(serializeStop);
  }

  @Post('trips/:id/assign')
  @Roles('carrier')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirmar asignación del viaje' })
  @ApiResponse({ status: 400, description: 'Solicitud inválida o no autorizada.' })
  async assign(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const { expectedVersion } = tripTransitionSchema.parse(body);
    return serializeTrip(await this.trips.assign(req.identity, id, expectedVersion));
  }

  @Post('trips/:id/reassign')
  @Roles('operator')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reasignar viaje para resolver conflictos' })
  @ApiResponse({ status: 400, description: 'Solicitud inválida o no autorizada.' })
  async reassign(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const input = reassignTripSchema.parse(body);
    return serializeTrip(
      await this.trips.assign(req.identity, id, input.expectedVersion, input.carrierId),
    );
  }

  @Post('trips/:id/start')
  @Roles('carrier')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Iniciar viaje' })
  @ApiResponse({ status: 400, description: 'Solicitud inválida o no autorizada.' })
  async start(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const { expectedVersion } = tripTransitionSchema.parse(body);
    return serializeTrip(await this.trips.start(req.identity, id, expectedVersion));
  }

  @Post('trips/:id/complete')
  @Roles('carrier')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Completar viaje manualmente' })
  @ApiResponse({ status: 400, description: 'Solicitud inválida o no autorizada.' })
  async complete(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const { expectedVersion } = tripTransitionSchema.parse(body);
    return serializeTrip(await this.trips.complete(req.identity, id, expectedVersion));
  }

  @Post('trips/:id/cancel')
  @Roles('carrier', 'operator')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancelar viaje' })
  @ApiResponse({ status: 400, description: 'Solicitud inválida o no autorizada.' })
  async cancel(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const input = cancelTripSchema.parse(body);
    return serializeTrip(
      await this.trips.cancel(req.identity, id, input.expectedVersion, input.reason),
    );
  }

  @Get('conflicts')
  @Roles('operator')
  @ApiOperation({ summary: 'Pedidos duplicados entre viajes activos' })
  @ApiResponse({ status: 400, description: 'Solicitud inválida o no autorizada.' })
  async conflicts(@Req() req: Request) {
    return { orderIds: await this.trips.resolveConflicts(req.identity) };
  }

  @Post('stops/:id/checkins')
  @Roles('carrier')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Registrar check-in de recogida o entrega' })
  @ApiResponse({ status: 400, description: 'Solicitud inválida o no autorizada.' })
  async recordCheckin(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const input = createCheckinSchema.parse({ ...(body as object), stopId: id });
    const checkin = await this.checkins.record(
      req.identity,
      {
        id: input.id,
        stopId: input.stopId,
        kind: input.kind,
        clientAt: new Date(input.clientAt),
        ...(input.mediaRef !== undefined ? { mediaRef: input.mediaRef } : {}),
      },
      input.baseVersion,
    );
    return serializeCheckin(checkin);
  }

  @Post('incidents')
  @Roles('carrier', 'operator')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Abrir incidencia de transporte' })
  @ApiResponse({ status: 400, description: 'Solicitud inválida o no autorizada.' })
  async openIncident(@Req() req: Request, @Body() body: unknown) {
    const input = openIncidentSchema.parse(body);
    return serializeIncident(
      await this.incidents.open(req.identity, {
        id: input.id,
        orderId: input.orderId,
        ...(input.tripId !== undefined ? { tripId: input.tripId } : {}),
        type: input.type,
        description: input.description,
      }),
    );
  }

  @Post('incidents/:id/resolve')
  @Roles('carrier', 'operator')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolver incidencia' })
  @ApiResponse({ status: 400, description: 'Solicitud inválida o no autorizada.' })
  async resolveIncident(@Req() req: Request, @Param('id') id: string) {
    return serializeIncident(await this.incidents.resolve(req.identity, id));
  }

  @Get('incidents')
  @Roles('carrier', 'operator')
  @ApiOperation({ summary: 'Listar incidencias' })
  @ApiResponse({ status: 400, description: 'Solicitud inválida o no autorizada.' })
  async listIncidents(@Req() req: Request, @Query() query: unknown) {
    const { limit } = logisticsLimitQuerySchema.parse(query);
    return (await this.incidents.list(req.identity, limit)).map(serializeIncident);
  }
}

const serializeCarrier = (profile: CarrierProps) => ({
  userId: profile.userId,
  vehicleType: profile.vehicleType,
  capacityKg: profile.capacityKg,
  plate: profile.plate,
  createdAt: profile.createdAt.toISOString(),
  updatedAt: profile.updatedAt.toISOString(),
});

const serializeTrip = (trip: TripProps) => ({
  id: trip.id,
  carrierId: trip.carrierId,
  status: trip.status,
  version: trip.version,
  plannedAt: trip.plannedAt.toISOString(),
  createdAt: trip.createdAt.toISOString(),
  updatedAt: trip.updatedAt.toISOString(),
  route: trip.route,
});

const serializeStop = (stop: TripStopProps) => ({
  id: stop.id,
  tripId: stop.tripId,
  orderId: stop.orderId,
  kind: stop.kind,
  sequence: stop.sequence,
  zone: stop.zone,
  scheduledAt: stop.scheduledAt?.toISOString() ?? null,
  completedAt: stop.completedAt?.toISOString() ?? null,
});

const serializeCheckin = (checkin: CheckinProps) => ({
  id: checkin.id,
  stopId: checkin.stopId,
  tripId: checkin.tripId,
  orderId: checkin.orderId,
  kind: checkin.kind,
  clientAt: checkin.clientAt.toISOString(),
  serverAt: checkin.serverAt.toISOString(),
  mediaRef: checkin.mediaRef,
});

const serializeIncident = (incident: IncidentProps) => ({
  id: incident.id,
  orderId: incident.orderId,
  tripId: incident.tripId,
  type: incident.type,
  description: incident.description,
  status: incident.status,
  openedAt: incident.openedAt.toISOString(),
  closedAt: incident.closedAt?.toISOString() ?? null,
});
