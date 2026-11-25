import { validateCorsOrigins } from '../scripts/configure-storage-cors.js';

describe('storage CORS script validation', () => {
  it('rejects wildcards and non-HTTPS production origins', () => {
    expect(() => validateCorsOrigins(['https://*.example.test'], 'production')).toThrow(
      'comodines',
    );
    expect(() => validateCorsOrigins(['http://app.example.test'], 'production')).toThrow('HTTPS');
  });

  it('accepts HTTPS and localhost origins by profile', () => {
    expect(() => validateCorsOrigins(['https://app.example.test'], 'production')).not.toThrow();
    expect(() => validateCorsOrigins(['http://localhost:8081'], 'development')).not.toThrow();
  });
});
