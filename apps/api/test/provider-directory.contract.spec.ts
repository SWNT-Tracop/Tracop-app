import { IdentityProviderDirectoryAdapter } from '../src/bootstrap/catalog-bridge.module.js';
import { ProviderProfileService } from '../src/modules/identity/application/provider-profile-service.js';
import type {
  ProviderProfileRepository,
  UserRepository,
} from '../src/modules/identity/ports/identity-ports.js';

describe('ProviderDirectoryPort contract', () => {
  it('forwards batches through identity and returns only public summary fields', async () => {
    const profiles: ProviderProfileRepository = {
      upsert: async () => undefined,
      findPublicSummaries: async (ids) =>
        new Map(
          ids.map((id) => [
            id,
            {
              displayName: 'Finca de prueba',
              municipality: 'Tunja',
              department: 'Boyacá',
            },
          ]),
        ),
    };
    const users: UserRepository = {
      findById: async () => null,
      findByPhone: async () => null,
      create: async () => undefined,
      update: async () => undefined,
    };
    const service = new ProviderProfileService(profiles, users);
    const directory = new IdentityProviderDirectoryAdapter(service);
    const response = await directory.getProviderPublicSummaries(['provider-1']);
    expect(response.get('provider-1')).toEqual({
      displayName: 'Finca de prueba',
      municipality: 'Tunja',
      department: 'Boyacá',
    });
    expect(Object.keys(response.get('provider-1')!)).toEqual([
      'displayName',
      'municipality',
      'department',
    ]);
    await expect(
      directory.getProviderPublicSummaries(Array.from({ length: 51 }, (_, index) => `p${index}`)),
    ).rejects.toMatchObject({ code: 'too_many_ids' });
  });
});
