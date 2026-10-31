import { ProviderProfileService } from '../src/modules/identity/application/provider-profile-service.js';
import type {
  ProviderProfileRepository,
  UserRepository,
} from '../src/modules/identity/ports/identity-ports.js';
import type { UserProps } from '../src/modules/identity/domain/user.js';

describe('provider profile application', () => {
  const user = { id: 'p1', role: 'producer' } as UserProps;
  const profiles: ProviderProfileRepository = {
    upsert: jest.fn(async () => undefined),
    findPublicSummaries: jest.fn(
      async () =>
        new Map([['p1', { displayName: 'Finca', municipality: 'Tunja', department: 'Boyacá' }]]),
    ),
  };
  const users: UserRepository = {
    findById: async () => user,
    findByPhone: async () => null,
    create: async () => undefined,
    update: async () => undefined,
  };
  const service = new ProviderProfileService(profiles, users);

  it('upserts an authorized provider profile', async () => {
    await service.upsertProviderProfile('p1', {
      displayName: 'Finca',
      municipality: 'Tunja',
      department: 'Boyacá',
      lat: 5.5,
      lng: -73.4,
      description: '',
    });
    expect(profiles.upsert).toHaveBeenCalledWith(expect.objectContaining({ userId: 'p1' }));
  });

  it('returns only public fields and enforces a 50-id limit', async () => {
    const summary = await service.getProviderPublicSummaries(['p1']);
    expect(summary.get('p1')).toEqual({
      displayName: 'Finca',
      municipality: 'Tunja',
      department: 'Boyacá',
    });
    await expect(
      service.getProviderPublicSummaries(Array.from({ length: 51 }, (_, i) => String(i))),
    ).rejects.toMatchObject({ code: 'too_many_ids' });
  });
});
