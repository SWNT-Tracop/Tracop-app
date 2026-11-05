import { Roles } from '../src/shared/auth/auth-metadata.js';

describe('shared role decorator type contract', () => {
  it('accepts contract roles and rejects unknown roles at compile time', () => {
    expect(typeof Roles('producer', 'admin')).toBe('function');
    // @ts-expect-error Roles must reject values outside the shared role schema.
    Roles('administrator');
  });
});
