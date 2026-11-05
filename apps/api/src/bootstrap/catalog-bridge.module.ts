import { Global, Module } from '@nestjs/common';
import { IdentityModule, ProviderProfileService } from '../modules/identity/index.js';
import { PROVIDER_PROFILE_SERVICE } from '../modules/identity/index.js';
import { PROVIDER_DIRECTORY, type ProviderDirectoryPort } from '../modules/catalog/index.js';

export class IdentityProviderDirectoryAdapter implements ProviderDirectoryPort {
  constructor(private readonly profiles: ProviderProfileService) {}
  getProviderPublicSummaries(ids: readonly string[]) {
    return this.profiles.getProviderPublicSummaries(ids);
  }
}

@Global()
@Module({
  imports: [IdentityModule],
  providers: [
    {
      provide: PROVIDER_DIRECTORY,
      inject: [PROVIDER_PROFILE_SERVICE],
      useFactory: (profiles: ProviderProfileService) =>
        new IdentityProviderDirectoryAdapter(profiles),
    },
  ],
  exports: [PROVIDER_DIRECTORY],
})
export class CatalogBridgeModule {}
