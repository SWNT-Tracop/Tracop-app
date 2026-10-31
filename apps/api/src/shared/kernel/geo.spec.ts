import { COLOMBIA_BOUNDS, isWithinColombia } from './geo.js';

describe('Colombia bounding box', () => {
  it('has strictly increasing bounds on both axes', () => {
    expect(COLOMBIA_BOUNDS.minLat).toBeLessThan(COLOMBIA_BOUNDS.maxLat);
    expect(COLOMBIA_BOUNDS.minLng).toBeLessThan(COLOMBIA_BOUNDS.maxLng);
  });

  it('includes its edges and rejects coordinates outside the box', () => {
    expect(isWithinColombia(4, -74)).toBe(true);
    expect(isWithinColombia(COLOMBIA_BOUNDS.minLat, COLOMBIA_BOUNDS.minLng)).toBe(true);
    expect(isWithinColombia(COLOMBIA_BOUNDS.maxLat, COLOMBIA_BOUNDS.maxLng)).toBe(true);
    expect(isWithinColombia(COLOMBIA_BOUNDS.minLat, -74)).toBe(true);
    expect(isWithinColombia(COLOMBIA_BOUNDS.maxLat, -74)).toBe(true);
    expect(isWithinColombia(4, COLOMBIA_BOUNDS.minLng)).toBe(true);
    expect(isWithinColombia(4, COLOMBIA_BOUNDS.maxLng)).toBe(true);
    expect(isWithinColombia(4, -60)).toBe(false);
    expect(isWithinColombia(COLOMBIA_BOUNDS.minLat - 0.01, -74)).toBe(false);
    expect(isWithinColombia(COLOMBIA_BOUNDS.maxLat + 0.01, -74)).toBe(false);
    expect(isWithinColombia(4, COLOMBIA_BOUNDS.minLng - 0.01)).toBe(false);
    expect(isWithinColombia(4, COLOMBIA_BOUNDS.maxLng + 0.01)).toBe(false);
  });
});
