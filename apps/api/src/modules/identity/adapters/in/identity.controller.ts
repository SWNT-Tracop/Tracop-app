import { Body, Controller, Get, Inject, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  refreshSessionSchema,
  registerUserSchema,
  requestOtpSchema,
  requestOtpResponseSchema,
  updateMeSchema,
  upsertProviderProfileSchema,
  verifyOtpSchema,
} from '@tracop/contracts';
import type { IdentityApplicationService } from '../../application/identity-application-service.js';
import { IDENTITY_APPLICATION } from '../../ports/tokens.js';
import { AuthGuard, type AuthenticatedRequest } from '../../../../shared/auth/index.js';
import { Public, Roles } from './auth-metadata.js';
import type { UserRole } from '../../domain/user.js';
import { DomainError } from '../../../../shared/kernel/domain-error.js';
import { PROVIDER_PROFILE_SERVICE } from '../../ports/tokens.js';
import type { ProviderProfileService } from '../../application/provider-profile-service.js';
import { ApiErrorResponses, ApiZodBody, ApiZodResponse } from '../../../../shared/infra/openapi.js';
import { z } from 'zod';

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: DomainError }): T => {
  if (!result.ok) throw result.error;
  return result.value;
};

const clientIp = (request: Request): string =>
  request.ip ?? request.socket.remoteAddress ?? 'unknown';

const publicUserResponseSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(['producer', 'supplier', 'buyer', 'carrier', 'operator', 'finance', 'admin']),
  fullName: z.string(),
  phone: z.string(),
  status: z.string(),
  locale: z.string(),
});
const authSessionResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  accessTokenExpiresIn: z.number().int(),
  refreshTokenExpiresAt: z.string().datetime({ offset: true }),
  user: publicUserResponseSchema,
});

@ApiTags('identity')
@Controller()
@UseGuards(AuthGuard)
export class IdentityController {
  constructor(
    @Inject(IDENTITY_APPLICATION) private readonly identity: IdentityApplicationService,
    @Inject(PROVIDER_PROFILE_SERVICE) private readonly providerProfiles: ProviderProfileService,
  ) {}

  @Public()
  @Post('auth/register')
  @ApiOperation({
    summary: 'Iniciar registro por teléfono',
    description:
      'Registra la intención de crear una cuenta y solicita el consentimiento vigente. La respuesta no revela si el teléfono ya existe.',
  })
  @ApiZodBody(registerUserSchema, {
    phone: '3000000000',
    role: 'producer',
    fullName: 'María Ejemplo',
    locale: 'es-CO',
    deviceId: '018f47a2-8b45-7cc2-9a1e-123456789abc',
    platform: 'android',
    consent: { accepted: true, version: 'v0-draft' },
  })
  @ApiZodResponse(201, z.object({ message: z.string() }), {
    message: 'Si el registro puede continuar, recibirás un código.',
  })
  @ApiErrorResponses(400, 403, 409, 429)
  async register(@Body() body: unknown, @Req() request: Request) {
    const input = registerUserSchema.parse(body);
    const { locale, ...registration } = input;
    return unwrap(
      await this.identity.registerUser({
        ...registration,
        ...(locale !== undefined ? { locale } : {}),
        ip: clientIp(request),
      }),
    );
  }

  @Public()
  @Post('auth/otp/request')
  @ApiOperation({
    summary: 'Solicitar código de autenticación',
    description:
      'Solicita un OTP. La respuesta es genérica y puede incluir un enlace de vinculación del bot.',
  })
  @ApiZodBody(requestOtpSchema, { phone: '3000000000' })
  @ApiZodResponse(201, requestOtpResponseSchema, {
    message: 'Si el número puede autenticarse, recibirás un código.',
    botLink: 'https://t.me/tracop_demo_bot?start=link',
  })
  @ApiErrorResponses(400, 429)
  async requestOtp(@Body() body: unknown, @Req() request: Request) {
    const input = requestOtpSchema.parse(body);
    return unwrap(await this.identity.requestOtp(input.phone, clientIp(request)));
  }

  @Public()
  @Post('auth/otp/verify')
  @ApiOperation({
    summary: 'Verificar OTP e iniciar sesión',
    description: 'Valida el código temporal y crea una sesión asociada al dispositivo.',
  })
  @ApiZodBody(verifyOtpSchema, {
    phone: '3000000000',
    code: '123456',
    deviceId: '018f47a2-8b45-7cc2-9a1e-123456789abc',
    platform: 'android',
  })
  @ApiZodResponse(201, authSessionResponseSchema, {
    accessToken: '<access-token-sintético>',
    refreshToken: '<refresh-token-sintético>',
    accessTokenExpiresIn: 900,
    refreshTokenExpiresAt: '2026-11-03T01:00:00.000Z',
    user: {
      id: '018f47a2-8b45-7cc2-9a1e-123456789abd',
      role: 'producer',
      fullName: 'María Ejemplo',
      phone: '+573000000000',
      status: 'active',
      locale: 'es-CO',
    },
  })
  @ApiErrorResponses(400, 401, 403, 429)
  async verifyOtp(@Body() body: unknown, @Req() request: Request) {
    const input = verifyOtpSchema.parse(body);
    return unwrap(await this.identity.verifyOtp({ ...input, ip: clientIp(request) }));
  }

  @Public()
  @Post('auth/refresh')
  @ApiOperation({
    summary: 'Rotar refresh token',
    description:
      'Intercambia el refresh token por credenciales de sesión rotadas. El token solo se envía en el cuerpo y nunca debe registrarse.',
  })
  @ApiZodBody(refreshSessionSchema, {
    refreshToken: 'synthetic-refresh-token-value-00000000000000000000',
    deviceId: '018f47a2-8b45-7cc2-9a1e-123456789abc',
  })
  @ApiZodResponse(201, authSessionResponseSchema, {
    accessToken: '<access-token-sintético>',
    refreshToken: '<refresh-token-sintético>',
    accessTokenExpiresIn: 900,
    refreshTokenExpiresAt: '2026-11-03T01:00:00.000Z',
    user: {
      id: '018f47a2-8b45-7cc2-9a1e-123456789abd',
      role: 'producer',
      fullName: 'María Ejemplo',
      phone: '+573000000000',
      status: 'active',
      locale: 'es-CO',
    },
  })
  @ApiErrorResponses(400, 401, 429)
  async refresh(@Body() body: unknown) {
    const input = refreshSessionSchema.parse(body);
    return unwrap(await this.identity.refreshSession(input.refreshToken, input.deviceId));
  }

  @Post('auth/logout')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Cerrar la sesión actual',
    description: 'Revoca la sesión autenticada.',
  })
  @ApiZodResponse(201, z.object({ message: z.string() }), { message: 'Sesión cerrada.' })
  @ApiErrorResponses(401, 403)
  @Roles(
    ...([
      'producer',
      'supplier',
      'buyer',
      'carrier',
      'operator',
      'finance',
      'admin',
    ] satisfies UserRole[]),
  )
  async logout(@Req() request: AuthenticatedRequest) {
    return unwrap(await this.identity.logout(request.identity!));
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Consultar el perfil autenticado',
    description: 'Devuelve los datos públicos básicos de la cuenta actual.',
  })
  @ApiZodResponse(200, publicUserResponseSchema, {
    id: '018f47a2-8b45-7cc2-9a1e-123456789abd',
    role: 'buyer',
    fullName: 'Comprador Ejemplo',
    phone: '+573000000000',
    status: 'active',
    locale: 'es-CO',
  })
  @ApiErrorResponses(401, 403, 404)
  @Roles(
    ...([
      'producer',
      'supplier',
      'buyer',
      'carrier',
      'operator',
      'finance',
      'admin',
    ] satisfies UserRole[]),
  )
  async getMe(@Req() request: AuthenticatedRequest) {
    return unwrap(await this.identity.getMe(request.identity!));
  }

  @Patch('me')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Actualizar el perfil propio',
    description: 'Actualiza nombre y/o idioma de la cuenta autenticada.',
  })
  @Roles(
    ...([
      'producer',
      'supplier',
      'buyer',
      'carrier',
      'operator',
      'finance',
      'admin',
    ] satisfies UserRole[]),
  )
  @ApiZodBody(updateMeSchema, { fullName: 'María Ejemplo', locale: 'es-CO' })
  @ApiErrorResponses(400, 401, 403, 404)
  async updateMe(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = updateMeSchema.parse(body);
    return unwrap(
      await this.identity.updateMe(request.identity!, {
        ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
      }),
    );
  }

  @Put('me/provider-profile')
  @ApiBearerAuth()
  @Roles('producer', 'supplier')
  @ApiOperation({
    summary: 'Crear o actualizar perfil de proveedor',
    description:
      'Guarda el perfil público mínimo. Las coordenadas de ubicación exacta no se publican a compradores.',
  })
  @ApiZodBody(upsertProviderProfileSchema, {
    displayName: 'Finca La Esperanza',
    municipality: 'Tunja',
    department: 'Boyacá',
    lat: 5.5353,
    lng: -73.3678,
    description: 'Productor de hortalizas.',
  })
  @ApiZodResponse(200, z.object({ status: z.literal('saved') }), { status: 'saved' })
  @ApiErrorResponses(400, 401, 403)
  async upsertProviderProfile(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = upsertProviderProfileSchema.parse(body);
    await this.providerProfiles.upsertProviderProfile(request.identity!.sub, input);
    return { status: 'saved' as const };
  }
}
