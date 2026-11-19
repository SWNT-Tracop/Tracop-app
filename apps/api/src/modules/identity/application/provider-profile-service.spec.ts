import { DomainError } from '../../../shared/kernel/domain-error.js';
import type { ProviderProfileRepository, UserRepository } from '../ports/identity-ports.js';
import { ProviderProfileService } from './provider-profile-service.js';

const profile = {
  displayName: 'Finca La Esperanza',
  municipality: 'Tunja',
  department: 'Boyacá',
  lat: 5.5,
  lng: -73.4,
  description: 'Cultivo familiar',
};
const user = (role: string) => ({ id: 'provider-1', role }) as never;

describe('ProviderProfileService', () => {
  const findById = jest.fn();
  const upsert = jest.fn();
  const findPublicSummaries = jest.fn();
  let service: ProviderProfileService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ProviderProfileService(
      { upsert, findPublicSummaries } as unknown as ProviderProfileRepository,
      { findById } as unknown as UserRepository,
    );
  });

  it.each([['producer'], ['supplier']])('persists a valid profile for role %s', async (role) => {
    findById.mockResolvedValue(user(role));
    await expect(service.upsertProviderProfile('provider-1', profile)).resolves.toBeUndefined();
    expect(upsert).toHaveBeenCalledWith({ ...profile, userId: 'provider-1' });
  });

  it.each([null, user('buyer'), user('operator')])(
    'rejects a missing or non-provider account',
    async (account) => {
      findById.mockResolvedValue(account);
      await expect(service.upsertProviderProfile('provider-1', profile)).rejects.toMatchObject<
        Partial<DomainError>
      >({ code: 'forbidden' });
      expect(upsert).not.toHaveBeenCalled();
    },
  );

  it('does not persist an invalid profile', async () => {
    findById.mockResolvedValue(user('producer'));
    await expect(
      service.upsertProviderProfile('provider-1', { ...profile, lat: 20 }),
    ).rejects.toThrow('dentro de Colombia');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('returns an empty result for no ids without querying storage', async () => {
    await expect(service.getProviderPublicSummaries([])).resolves.toEqual(new Map());
    expect(findPublicSummaries).not.toHaveBeenCalled();
  });

  it('limits summary reads to fifty ids', async () => {
    await expect(
      service.getProviderPublicSummaries(Array.from({ length: 51 }, (_, index) => String(index))),
    ).rejects.toMatchObject({ code: 'too_many_ids' });
    expect(findPublicSummaries).not.toHaveBeenCalled();
  });

  it('delegates summary reads within the limit', async () => {
    const expected = new Map([['provider-1', { displayName: 'Finca La Esperanza' }]]);
    findPublicSummaries.mockResolvedValue(expected);
    await expect(service.getProviderPublicSummaries(['provider-1'])).resolves.toBe(expected);
    expect(findPublicSummaries).toHaveBeenCalledWith(['provider-1']);
  });
});
