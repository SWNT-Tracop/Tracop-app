import { Inject, Injectable } from '@nestjs/common';
import type {
  AccessTokenVerifierPort,
  AuthPrincipal,
  TokenVerification,
} from '../../../../shared/auth/index.js';
import type { Clock } from '../../../../shared/kernel/clock.js';
import { APP_CLOCK } from '../../../../shared/infra/tokens.js';
import type {
  SessionRepository,
  TokenServicePort,
  UserRepository,
} from '../../ports/identity-ports.js';
import { SESSION_REPOSITORY, TOKEN_SERVICE, USER_REPOSITORY } from '../../ports/tokens.js';

@Injectable()
export class IdentityAccessTokenVerifier implements AccessTokenVerifierPort {
  constructor(
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenServicePort,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(APP_CLOCK) private readonly clock: Clock,
  ) {}

  async verify(token: string): Promise<TokenVerification> {
    const claims = await this.tokens.verifyAccessToken(token, this.clock.now());
    if (!claims) return { principal: null, reason: 'invalid_token' };
    const session = await this.sessions.findById(claims.sid);
    if (!session || session.userId !== claims.sub || session.deviceId !== claims.did) {
      return { principal: null, reason: 'invalid_session' };
    }
    if (
      session.revokedAt ||
      session.rotatedAt ||
      session.expiresAt.getTime() <= this.clock.now().getTime()
    ) {
      return { principal: null, reason: 'invalid_session' };
    }
    const user = await this.users.findById(claims.sub);
    if (!user || user.status !== 'active') return { principal: null, reason: 'invalid_session' };
    const principal: AuthPrincipal = {
      ...claims,
      role: user.role,
    };
    return { principal };
  }
}
