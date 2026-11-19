import { TrustService } from './trust-service.js';

describe('TrustService', () => {
  it('returns a verified participant trace', async () => {
    const getTrace = jest.fn(async () => []);
    const service = new TrustService({ getTrace });
    await expect(
      service.getOrderTrace({ sub: 'buyer', role: 'buyer' }, 'order-1'),
    ).resolves.toEqual({
      orderId: 'order-1',
      integrity: { valid: true, eventCount: 0, firstHash: null, lastHash: null },
      events: [],
    });
    expect(getTrace).toHaveBeenCalledWith({ sub: 'buyer', role: 'buyer' }, 'order-1');
  });

  it('maps an absent order to a domain not-found error', async () => {
    const service = new TrustService({ getTrace: async () => null });
    await expect(
      service.getOrderTrace({ sub: 'buyer', role: 'buyer' }, 'missing'),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
