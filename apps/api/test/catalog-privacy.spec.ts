import { serializeLotForViewer } from '../src/modules/catalog/adapters/in/lot-response.js';
import type { LotProps } from '../src/modules/catalog/domain/lot.js';

const lot: LotProps = {
  id: '018f47a2-8b45-7cc2-9a1e-123456789abc',
  providerId: 'provider-secret-id',
  productId: 'product',
  quantityMilli: 5_000n,
  unit: 'kg',
  unitPrice: 2500n,
  qualityGrade: null,
  availableFrom: new Date('2026-10-30T12:00:00Z'),
  availableUntil: new Date('2026-10-31T12:00:00Z'),
  locationLat: 5.5123456,
  locationLng: -73.4123456,
  status: 'published',
  version: 2,
};
const publicProvider = { displayName: 'Finca', municipality: 'Tunja', department: 'Boyacá' };

describe('lot response location privacy', () => {
  it('omits exact lot and provider coordinates and private provider identifiers from third-party responses', () => {
    const response = serializeLotForViewer(lot, publicProvider, 'buyer-id', 12.345678);
    expect(response).toEqual(expect.objectContaining({ distanceKm: 12, provider: publicProvider }));
    expect(response).not.toHaveProperty('locationLat');
    expect(response).not.toHaveProperty('locationLng');
    expect(response).not.toHaveProperty('providerId');
    expect(response.provider).not.toHaveProperty('userId');
    expect(response.provider).not.toHaveProperty('lat');
    expect(response.provider).not.toHaveProperty('lng');
    expect(JSON.stringify(response)).not.toContain(String(lot.locationLat));
    expect(JSON.stringify(response)).not.toContain(String(lot.locationLng));
  });

  it('includes lot coordinates only to its owner', () => {
    const response = serializeLotForViewer(lot, publicProvider, lot.providerId);
    expect(response).toHaveProperty('locationLat', lot.locationLat);
    expect(response).toHaveProperty('locationLng', lot.locationLng);
  });

  it('rounds third-party distances to integer kilometres with a minimum of one', () => {
    const near = serializeLotForViewer(lot, publicProvider, 'buyer-id', 0.2);
    expect(near.distanceKm).toBe(1);
    expect(JSON.stringify(near)).not.toContain('0.2');
  });
});
