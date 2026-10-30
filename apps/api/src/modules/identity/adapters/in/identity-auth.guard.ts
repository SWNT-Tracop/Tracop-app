import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { APP_CLOCK } from '../../../../shared/infra/tokens.js';
import type { Clock } from '../../../../shared/kernel/clock.js';
import type {
  AccessTokenClaims,
  SessionRepository,
  TokenServicePort,
  UserRepository,
} from '../../ports/identity-ports.js';
import { SESSION_REPOSITORY, TOKEN_SERVICE, USER_REPOSITORY } from '../../ports/tokens.js';
import { PUBLIC_ROUTE, REQUIRED_ROLES } from './auth-metadata.js';

export interface AuthenticatedRequest extends Request {
  identity?: AccessTokenClaims;
}

@Injectable()
export class IdentityAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenServicePort,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(APP_CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Autenticación requerida.');
    const claims = await this.tokens.verifyAccessToken(header.slice(7), this.clock.now());
    if (!claims) throw new UnauthorizedException('Credenciales inválidas.');
    const session = await this.sessions.findById(claims.sid);
    if (!session || session.userId !== claims.sub || session.deviceId !== claims.did)
      throw new UnauthorizedException('Sesión inválida.');
    if (
      session.revokedAt ||
      session.rotatedAt ||
      session.expiresAt.getTime() <= this.clock.now().getTime()
    )
      throw new UnauthorizedException('Sesión inválida.');
    const user = await this.users.findById(claims.sub);
    if (!user || user.status !== 'active') throw new UnauthorizedException('Sesión inválida.');

    const allowedRoles = this.reflector.getAllAndOverride<readonly string[]>(REQUIRED_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowedRoles && !allowedRoles.includes(user.role))
      throw new ForbiddenException('No tienes permiso para este recurso.');
    request.identity = claims;
    return true;
  }
}

export const ownsResource = (claims: AccessTokenClaims, ownerId: string): boolean =>
  claims.sub === ownerId;
