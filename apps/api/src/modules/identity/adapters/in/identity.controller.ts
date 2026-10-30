import { Body, Controller, Get, Inject, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  refreshSessionSchema,
  registerUserSchema,
  requestOtpSchema,
  updateMeSchema,
  verifyOtpSchema,
} from '@tracop/contracts';
import type { IdentityApplicationService } from '../../application/identity-application-service.js';
import { IDENTITY_APPLICATION } from '../../ports/tokens.js';
import { IdentityAuthGuard, type AuthenticatedRequest } from './identity-auth.guard.js';
import { Public, Roles } from './auth-metadata.js';
import type { UserRole } from '../../domain/user.js';
import { DomainError } from '../../../../shared/kernel/domain-error.js';

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: DomainError }): T => {
  if (!result.ok) throw result.error;
  return result.value;
};

const clientIp = (request: Request): string =>
  request.ip ?? request.socket.remoteAddress ?? 'unknown';

@ApiTags('identity')
@Controller()
@UseGuards(IdentityAuthGuard)
export class IdentityController {
  constructor(
    @Inject(IDENTITY_APPLICATION) private readonly identity: IdentityApplicationService,
  ) {}

  @Public()
  @Post('auth/register')
  @ApiOperation({ summary: 'Iniciar registro por teléfono' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['phone', 'role', 'fullName', 'deviceId', 'platform', 'consent'],
      properties: {
        phone: { type: 'string', example: '3001234567' },
        role: {
          type: 'string',
          enum: ['producer', 'supplier', 'buyer', 'carrier', 'operator', 'finance', 'admin'],
        },
        fullName: { type: 'string' },
        locale: { type: 'string' },
        deviceId: { type: 'string', format: 'uuid' },
        platform: { type: 'string', enum: ['ios', 'android', 'web', 'other'] },
        consent: {
          type: 'object',
          required: ['accepted', 'version'],
          properties: {
            accepted: { type: 'boolean', enum: [true] },
            version: { type: 'string', example: 'v0-draft' },
          },
        },
      },
    },
  })
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
  @ApiOperation({ summary: 'Solicitar código de autenticación' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['phone'],
      properties: { phone: { type: 'string', example: '3001234567' } },
    },
  })
  async requestOtp(@Body() body: unknown, @Req() request: Request) {
    const input = requestOtpSchema.parse(body);
    return unwrap(await this.identity.requestOtp(input.phone, clientIp(request)));
  }

  @Public()
  @Post('auth/otp/verify')
  @ApiOperation({ summary: 'Verificar OTP e iniciar sesión' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['phone', 'code', 'deviceId', 'platform'],
      properties: {
        phone: { type: 'string' },
        code: { type: 'string', minLength: 4, maxLength: 10 },
        deviceId: { type: 'string', format: 'uuid' },
        platform: { type: 'string', enum: ['ios', 'android', 'web', 'other'] },
      },
    },
  })
  async verifyOtp(@Body() body: unknown, @Req() request: Request) {
    const input = verifyOtpSchema.parse(body);
    return unwrap(await this.identity.verifyOtp({ ...input, ip: clientIp(request) }));
  }

  @Public()
  @Post('auth/refresh')
  @ApiOperation({ summary: 'Rotar refresh token' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['refreshToken', 'deviceId'],
      properties: {
        refreshToken: { type: 'string' },
        deviceId: { type: 'string', format: 'uuid' },
      },
    },
  })
  async refresh(@Body() body: unknown) {
    const input = refreshSessionSchema.parse(body);
    return unwrap(await this.identity.refreshSession(input.refreshToken, input.deviceId));
  }

  @Post('auth/logout')
  @ApiBearerAuth()
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
  @ApiBody({
    schema: {
      type: 'object',
      properties: { fullName: { type: 'string' }, locale: { type: 'string' } },
      additionalProperties: false,
    },
  })
  async updateMe(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = updateMeSchema.parse(body);
    return unwrap(
      await this.identity.updateMe(request.identity!, {
        ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
      }),
    );
  }
}
