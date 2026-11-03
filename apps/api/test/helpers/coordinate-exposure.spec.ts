import { findCoordinateExposure } from './coordinate-exposure.js';

const coordinates = [
  { latitude: 5.5, longitude: -73.4 },
  { latitude: 5.52, longitude: -73.41 },
];

describe('findCoordinateExposure', () => {
  it('does not mistake coordinate-like digits inside timestamps for exposed coordinates', () => {
    const response = { availableFrom: '2026-11-03T00:58:05.534Z' };

    expect(findCoordinateExposure(response, coordinates)).toEqual([]);
  });

  it('detects matching numeric and numeric-string coordinates in nested objects and arrays', () => {
    const response = {
      items: [{ provider: { preciseValue: -73.4 } }, { metadata: [{ value: '5.5200004' }] }],
    };

    expect(findCoordinateExposure(response, coordinates)).toEqual([
      { path: '$.items[0].provider.preciseValue', kind: 'coordinate-value', value: -73.4 },
      { path: '$.items[1].metadata[0].value', kind: 'coordinate-value', value: '5.5200004' },
    ]);
  });

  it('detects coordinate-named keys unless explicitly documented as public', () => {
    const response = { provider: { latitude: 5.5 } };

    expect(findCoordinateExposure(response, coordinates)).toEqual([
      { path: '$.provider.latitude', kind: 'coordinate-key', value: 5.5 },
      { path: '$.provider.latitude', kind: 'coordinate-value', value: 5.5 },
    ]);
    expect(findCoordinateExposure(response, coordinates, ['latitude'])).toEqual([
      { path: '$.provider.latitude', kind: 'coordinate-value', value: 5.5 },
    ]);
  });
});
