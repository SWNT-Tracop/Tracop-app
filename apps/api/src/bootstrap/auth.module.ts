import { Global, Module } from '@nestjs/common';
import { ACCESS_TOKEN_VERIFIER, AuthGuard } from '../shared/auth/index.js';
import { IDENTITY_ACCESS_TOKEN_VERIFIER, IdentityModule } from '../modules/identity/index.js';

// Composition root for authentication: binds the shared guard's verifier port
// to identity's adapter so every module (identity, catalog) uses one guard.
@Global()
@Module({
  imports: [IdentityModule],
  providers: [
    AuthGuard,
    { provide: ACCESS_TOKEN_VERIFIER, useExisting: IDENTITY_ACCESS_TOKEN_VERIFIER },
  ],
  exports: [AuthGuard, ACCESS_TOKEN_VERIFIER],
})
export class AuthModule {}
