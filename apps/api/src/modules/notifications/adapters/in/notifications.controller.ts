import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  inboxEntryResponseSchema,
  inboxPageResponseSchema,
  inboxQuerySchema,
  notificationPreferencesSchema,
} from '@tracop/contracts';
import { AuthGuard, type AuthPrincipal } from '../../../../shared/auth/index.js';
import { ApiErrorResponses, ApiZodBody, ApiZodResponse } from '../../../../shared/infra/openapi.js';
import type { NotificationsService } from '../../application/notifications-service.js';
import { NOTIFICATIONS_SERVICE } from '../../application/notifications-tokens.js';
import type { InboxEntry } from '../../ports/notifications-ports.js';

type AuthenticatedRequest = { readonly identity: AuthPrincipal };

const serializeEntry = (entry: InboxEntry) => ({
  id: entry.id,
  kind: entry.kind,
  title: entry.title,
  body: entry.body,
  createdAt: entry.createdAt.toISOString(),
  readAt: entry.readAt?.toISOString() ?? null,
});

const preferencesExample = {
  channelOrder: ['messaging', 'push', 'sms'],
  quietHours: { start: '22:00', end: '06:00' },
};
const entryExample = {
  id: '018f47a2-8b45-7cc2-9a1e-123456789abc',
  kind: 'delivered',
  title: 'Pedido entregado',
  body: 'Registramos la entrega del pedido #018F47A2. Si hay un problema, repórtalo en la app.',
  createdAt: '2026-11-24T15:00:00.000Z',
  readAt: null,
};

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('me')
export class NotificationsController {
  constructor(
    @Inject(NOTIFICATIONS_SERVICE) private readonly notifications: NotificationsService,
  ) {}

  @Get('notification-preferences')
  @ApiOperation({
    summary: 'Mis preferencias de notificación',
    description:
      'Sin preferencias guardadas: mensajería, push y SMS, sin horario sin molestias. El SMS ' +
      'solo se usa para avisos críticos; push y SMS aún no tienen proveedor.',
  })
  @ApiZodResponse(200, notificationPreferencesSchema, preferencesExample)
  @ApiErrorResponses(401)
  async getPreferences(@Req() req: AuthenticatedRequest) {
    return this.notifications.getPreferences(req.identity.sub);
  }

  @Put('notification-preferences')
  @ApiOperation({
    summary: 'Guardar mis preferencias de notificación',
    description:
      'Horario sin molestias en hora de Colombia (HH:MM, puede cruzar la medianoche); los avisos ' +
      'críticos lo ignoran.',
  })
  @ApiZodBody(notificationPreferencesSchema, preferencesExample)
  @ApiZodResponse(200, notificationPreferencesSchema, preferencesExample)
  @ApiErrorResponses(400, 401)
  async savePreferences(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const input = notificationPreferencesSchema.parse(body);
    return this.notifications.savePreferences(req.identity.sub, input);
  }

  @Get('inbox')
  @ApiOperation({
    summary: 'Mi bandeja de notificaciones (más recientes primero)',
    description: 'También llega por `GET /sync/pull` como entidad `notification`.',
  })
  @ApiZodResponse(200, inboxPageResponseSchema, { items: [entryExample] })
  @ApiErrorResponses(400, 401)
  async inbox(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const { cursor, limit } = inboxQuerySchema.parse(query);
    const page = await this.notifications.listInbox(req.identity.sub, cursor, limit);
    return {
      items: page.items.map(serializeEntry),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  @Post('inbox/:id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marcar una notificación como leída (idempotente)' })
  @ApiZodResponse(200, inboxEntryResponseSchema, {
    ...entryExample,
    readAt: '2026-11-24T15:05:00.000Z',
  })
  @ApiErrorResponses(400, 401, 404)
  async markRead(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return serializeEntry(await this.notifications.markRead(req.identity.sub, id));
  }
}
