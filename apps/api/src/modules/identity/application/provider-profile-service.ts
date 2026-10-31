import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../../shared/kernel/domain-error.js';
import type { ProviderProfileProps, ProviderPublicSummary } from '../domain/provider-profile.js';
import { validateProviderProfile } from '../domain/provider-profile.js';
import type { ProviderProfileRepository, UserRepository } from '../ports/identity-ports.js';
import { PROVIDER_PROFILE_REPOSITORY, USER_REPOSITORY } from '../ports/tokens.js';

@Injectable()
export class ProviderProfileService {
  constructor(
    @Inject(PROVIDER_PROFILE_REPOSITORY) private readonly profiles: ProviderProfileRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
  ) {}

  async upsertProviderProfile(
    userId: string,
    input: Omit<ProviderProfileProps, 'userId'>,
  ): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user || !['producer', 'supplier'].includes(user.role)) {
      throw new DomainError('No tienes permiso para crear este perfil.', 'forbidden');
    }
    const profile = { ...input, userId };
    validateProviderProfile(profile);
    await this.profiles.upsert(profile);
  }

  async getProviderPublicSummaries(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, ProviderPublicSummary>> {
    if (ids.length > 50)
      throw new DomainError('Máximo 50 proveedores por consulta.', 'too_many_ids');
    if (ids.length === 0) return new Map();
    return this.profiles.findPublicSummaries(ids);
  }
}
