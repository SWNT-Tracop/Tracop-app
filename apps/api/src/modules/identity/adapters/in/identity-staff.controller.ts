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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard, type AuthPrincipal } from '../../../../shared/auth/index.js';
import {
  changeUserRoleSchema,
  staffAccountReasonSchema,
  staffUserLookupQuerySchema,
  staffUserViewSchema,
} from '@tracop/contracts';
import { ApiErrorResponses, ApiZodBody, ApiZodResponse } from '../../../../shared/infra/openapi.js';
import type { IdentityStaffService } from '../../application/identity-staff-service.js';
import { IDENTITY_STAFF } from '../../ports/tokens.js';

@ApiTags('identity')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('staff/users')
export class IdentityStaffController {
  constructor(@Inject(IDENTITY_STAFF) private readonly staff: IdentityStaffService) {}

  @Post(':userId/channels/:channel/unlink')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Desvincular el canal de mensajería de un usuario (operator, admin)',
    description:
      'Para un teléfono perdido o un chat cambiado: el bot deja de escribir a ese chat y la persona ' +
      'puede volver a vincularse compartiendo su contacto. Auditado; el registro no guarda el teléfono.',
  })
  @ApiErrorResponses(400, 401, 403, 404)
  async unlink(
    @Req() req: { readonly identity: AuthPrincipal },
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('channel') channel: string,
  ) {
    await this.staff.unlinkChannel(req.identity, userId, channel);
  }

  @Get()
  @ApiOperation({
    summary: 'Buscar una cuenta por teléfono (admin)',
    description:
      'Devuelve el rol, el estado, el nombre y los 4 últimos dígitos; nunca el teléfono completo.',
  })
  @ApiQuery({
    name: 'phone',
    required: true,
    schema: { type: 'string', maxLength: 32 },
    example: '3000000011',
  })
  @ApiZodResponse(200, staffUserViewSchema, {
    id: '01900000-0000-7000-8000-000000000001',
    role: 'buyer',
    status: 'active',
    fullName: 'Comprador sintético',
    phoneLast4: '0011',
  })
  @ApiErrorResponses(400, 401, 403, 404)
  async find(@Req() req: { readonly identity: AuthPrincipal }, @Query() query: unknown) {
    const { phone } = staffUserLookupQuerySchema.parse(query);
    return this.staff.findByPhone(req.identity, phone);
  }

  @Post(':userId/role')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cambiar el rol de una cuenta del mercado (admin)',
    description:
      'Solo entre productor, proveedor, comprador y transportista; nunca roles del personal, ni la propia cuenta ni la de otro admin. ' +
      'Cierra las sesiones de la persona y queda en la auditoría con el motivo.',
  })
  @ApiZodBody(changeUserRoleSchema, {
    role: 'producer',
    reason: 'Prueba del jurado como productor',
  })
  @ApiZodResponse(200, staffUserViewSchema, {
    id: '01900000-0000-7000-8000-000000000001',
    role: 'producer',
    status: 'active',
    fullName: 'Comprador sintético',
    phoneLast4: '0011',
  })
  @ApiErrorResponses(400, 401, 403, 404, 409)
  async changeRole(
    @Req() req: { readonly identity: AuthPrincipal },
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: unknown,
  ) {
    return this.staff.changeRole(req.identity, userId, changeUserRoleSchema.parse(body));
  }

  @Post(':userId/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Suspender una cuenta (admin)',
    description:
      'Bloquea al instante el ingreso, la renovación y cada petición; los datos se conservan. Auditado con el motivo.',
  })
  @ApiZodBody(staffAccountReasonSchema, { reason: 'Cuenta de prueba de la sustentación' })
  @ApiZodResponse(200, staffUserViewSchema, {
    id: '01900000-0000-7000-8000-000000000001',
    role: 'buyer',
    status: 'suspended',
    fullName: 'Comprador sintético',
    phoneLast4: '0011',
  })
  @ApiErrorResponses(400, 401, 403, 404, 409)
  async suspend(
    @Req() req: { readonly identity: AuthPrincipal },
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: unknown,
  ) {
    return this.staff.suspend(req.identity, userId, staffAccountReasonSchema.parse(body));
  }

  @Post(':userId/reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivar una cuenta suspendida (admin)' })
  @ApiZodBody(staffAccountReasonSchema, { reason: 'Fin de la suspensión' })
  @ApiZodResponse(200, staffUserViewSchema, {
    id: '01900000-0000-7000-8000-000000000001',
    role: 'buyer',
    status: 'active',
    fullName: 'Comprador sintético',
    phoneLast4: '0011',
  })
  @ApiErrorResponses(400, 401, 403, 404, 409)
  async reactivate(
    @Req() req: { readonly identity: AuthPrincipal },
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: unknown,
  ) {
    return this.staff.reactivate(req.identity, userId, staffAccountReasonSchema.parse(body));
  }
}
