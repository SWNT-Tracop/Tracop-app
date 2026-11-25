import {
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, type AuthPrincipal } from '../../../../shared/auth/index.js';
import { ApiErrorResponses } from '../../../../shared/infra/openapi.js';
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
}
