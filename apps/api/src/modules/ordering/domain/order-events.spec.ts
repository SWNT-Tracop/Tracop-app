import { hashOrderEvent, verifyOrderEventChain } from './order-events.js';

describe('order event hash chain', () => {
  it('verifies canonical chained events and detects payload manipulation', () => {
    const firstPayload = { type: 'OrderRequested', orderId: 'one' };
    const firstHash = hashOrderEvent(null, firstPayload);
    const secondPayload = { type: 'OrderQuoted', orderId: 'one' };
    const secondHash = hashOrderEvent(firstHash, secondPayload);
    const chain = [
      { prevHash: null, hash: firstHash, payload: firstPayload },
      { prevHash: firstHash, hash: secondHash, payload: secondPayload },
    ];
    expect(verifyOrderEventChain(chain)).toBe(true);
    expect(
      verifyOrderEventChain([{ ...chain[0]!, payload: { type: 'OrderCancelled' } }, chain[1]!]),
    ).toBe(false);
  });
});
