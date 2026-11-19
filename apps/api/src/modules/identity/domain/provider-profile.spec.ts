import { validateProviderProfile } from './provider-profile.js';

const valid = {
  userId: 'provider-id',
  displayName: 'Finca de prueba',
  municipality: 'Tunja',
  department: 'Boyacá',
  lat: 5.5,
  lng: -73.4,
  description: 'Perfil sintético',
};

describe('provider profile validation', () => {
  it('accepts coordinates within the configured Colombia bounding box', () => {
    expect(() => validateProviderProfile(valid)).not.toThrow();
  });

  it('rejects coordinates outside Colombia', () => {
    expect(() => validateProviderProfile({ ...valid, lat: 20 })).toThrow('dentro de Colombia');
  });

  it('rejects invalid public names, localities and oversized descriptions', () => {
    expect(() => validateProviderProfile({ ...valid, displayName: ' ' })).toThrow('nombre público');
    expect(() => validateProviderProfile({ ...valid, municipality: 'x'.repeat(101) })).toThrow(
      'campos inválidos',
    );
    expect(() => validateProviderProfile({ ...valid, department: 'x'.repeat(101) })).toThrow(
      'campos inválidos',
    );
    expect(() => validateProviderProfile({ ...valid, description: 'x'.repeat(1001) })).toThrow(
      'campos inválidos',
    );
  });
});
