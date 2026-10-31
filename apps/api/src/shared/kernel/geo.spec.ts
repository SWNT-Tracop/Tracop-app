import { COLOMBIA_BOUNDS, isWithinColombia } from './geo.js';

describe('Colombia bounding box', () => {
  it('has strictly increasing bounds on both axes', () => {
    expect(COLOMBIA_BOUNDS.minLat).toBeLessThan(COLOMBIA_BOUNDS.maxLat);
    expect(COLOMBIA_BOUNDS.minLng).toBeLessThan(COLOMBIA_BOUNDS.maxLng);
  });

  it('includes its edges and rejects coordinates outside the box', () => {
    expect(isWithinColombia(COLOMBIA_BOUNDS.minLat, COLOMBIA_BOUNDS.minLng)).toBe(true);
    expect(isWithinColombia(COLOMBIA_BOUNDS.maxLat, COLOMBIA_BOUNDS.maxLng)).toBe(true);
    expect(isWithinColombia(COLOMBIA_BOUNDS.minLat - 0.01, -74)).toBe(false);
    expect(isWithinColombia(14, -74)).toBe(false);
  });
});
