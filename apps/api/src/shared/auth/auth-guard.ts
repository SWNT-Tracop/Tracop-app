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
import { PUBLIC_ROUTE, REQUIRED_ROLES } from './auth-metadata.js';
import {
  ACCESS_TOKEN_VERIFIER,
  type AccessTokenVerifierPort,
  type AuthPrincipal,
} from './access-token-verifier.js';

export interface AuthenticatedRequest extends Request {
  identity?: AuthPrincipal;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ACCESS_TOKEN_VERIFIER) private readonly verifier: AccessTokenVerifierPort,
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
    const verification = await this.verifier.verify(header.slice(7));
    if (!verification.principal) {
      throw new UnauthorizedException(
        verification.reason === 'invalid_session' ? 'Sesión inválida.' : 'Credenciales inválidas.',
      );
    }

    const allowedRoles = this.reflector.getAllAndOverride<readonly string[]>(REQUIRED_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowedRoles && !allowedRoles.includes(verification.principal.role)) {
      throw new ForbiddenException('No tienes permiso para este recurso.');
    }
    request.identity = verification.principal;
    return true;
  }
}

export const ownsResource = (principal: AuthPrincipal, ownerId: string): boolean =>
  principal.sub === ownerId;
