import type { Reflector } from '@nestjs/core';
import {
  AuthGuard,
  ownsResource,
  type AuthenticatedRequest,
} from '../../../../shared/auth/index.js';
import type { Clock } from '../../../../shared/kernel/clock.js';
import type {
  SessionRepository,
  TokenServicePort,
  UserRepository,
} from '../../ports/identity-ports.js';
import { IdentityAccessTokenVerifier } from '../out/identity-access-token-verifier.js';

export type { AuthenticatedRequest };
export { ownsResource };

// Compatibility wrapper kept for the existing authorization unit test: HTTP
// routes use the shared AuthGuard, whose verifier is wired by the composition
// root. It builds the same verifier the runtime uses, from identity's ports.
export class IdentityAuthGuard extends AuthGuard {
  constructor(
    reflector: Reflector,
    tokens: TokenServicePort,
    sessions: SessionRepository,
    users: UserRepository,
    clock: Clock,
  ) {
    super(reflector, new IdentityAccessTokenVerifier(tokens, sessions, users, clock));
  }
}
