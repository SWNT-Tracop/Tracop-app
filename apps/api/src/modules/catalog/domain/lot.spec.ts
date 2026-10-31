import { Lot, type LotProps } from './lot.js';

const now = new Date('2026-10-30T12:00:00.000Z');
const props: LotProps = {
  id: '018f47a2-8b45-7cc2-9a1e-123456789abc',
  providerId: 'provider',
  productId: 'product',
  quantityMilli: 10_000n,
  unit: 'kg',
  unitPrice: 1000n,
  qualityGrade: null,
  availableFrom: now,
  availableUntil: new Date(now.getTime() + 86_400_000),
  locationLat: 5.5,
  locationLng: -73.4,
  status: 'draft',
  version: 1,
};

describe('Lot domain', () => {
  it('validates data and enforces inclusive availability_until at the exact boundary', () => {
    const lot = Lot.create(props, 'kg', now, 90);
    expect(Lot.isVisibleNow({ ...lot.props, status: 'published', availableUntil: now }, now)).toBe(
      true,
    );
    expect(
      Lot.isVisibleNow(
        { ...lot.props, status: 'published', availableUntil: new Date(now.getTime() - 1) },
        now,
      ),
    ).toBe(false);
  });
  it('rejects invalid business values', () => {
    expect(() => Lot.create({ ...props, quantityMilli: 0n }, 'kg', now, 90)).toThrow();
    expect(() => Lot.create({ ...props, unitPrice: 0n }, 'kg', now, 90)).toThrow();
    expect(() => Lot.create(props, 'g', now, 90)).toThrow();
    expect(() =>
      Lot.create(
        { ...props, availableFrom: new Date(now.getTime() + 2 * 86_400_000) },
        'kg',
        now,
        90,
      ),
    ).toThrow();
    expect(() =>
      Lot.create(
        { ...props, availableUntil: new Date(now.getTime() + 91 * 86_400_000) },
        'kg',
        now,
        90,
      ),
    ).toThrow();
    expect(() => Lot.create({ ...props, locationLat: 14 }, 'kg', now, 90)).toThrow();
    expect(() => Lot.create({ ...props, qualityGrade: 'x'.repeat(101) }, 'kg', now, 90)).toThrow();
  });
  it('supports the complete state machine, emits cancellation prior state and rejects invalid transitions', () => {
    const lot = Lot.create(props, 'kg', now, 90);
    lot.transition('published', now);
    expect(lot.drainEvents().map((event) => event.type)).toEqual(['LotPublished']);
    lot.transition('cancelled', now);
    expect(lot.drainEvents()).toEqual([
      expect.objectContaining({ type: 'LotCancelled', previousStatus: 'published' }),
    ]);
    const draft = Lot.create(props, 'kg', now, 90);
    draft.transition('cancelled', now);
    expect(draft.drainEvents()).toEqual([
      expect.objectContaining({ type: 'LotCancelled', previousStatus: 'draft' }),
    ]);
    expect(() => draft.transition('published', now)).toThrow('Transición');
    const expired = Lot.create(props, 'kg', now, 90);
    expired.transition('published', now);
    expired.drainEvents();
    expired.transition('expired', now);
    expect(expired.drainEvents().map((event) => event.type)).toEqual(['LotExpired']);
    const reservable = Lot.create(props, 'kg', now, 90);
    reservable.transition('published', now);
    reservable.transition('reserved', now);
    reservable.transition('sold_out', now);
    expect(() => reservable.transition('cancelled', now)).toThrow();
  });
});
