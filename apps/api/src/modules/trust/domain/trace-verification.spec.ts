import { hashOrderEvent } from '../../ordering/index.js';
import { verifyTrace } from './trace-verification.js';

const event = (id: string, type: string, previous: string | null) => {
  const occurredAt = new Date('2026-11-19T12:00:00.000Z');
  const payload = { status: type };
  const hash = hashOrderEvent(previous, {
    orderId: 'order-1',
    sequence: id === 'event-1' ? 1 : 2,
    type,
    actorId: 'actor-1',
    occurredAt,
    payload,
  });
  return {
    id,
    orderId: 'order-1',
    sequence: id === 'event-1' ? 1 : 2,
    type,
    actorId: 'actor-1',
    occurredAt,
    payload: { ...payload, prevHash: previous, hash },
    prevHash: previous,
    hash,
  };
};

describe('verifyTrace', () => {
  it('accepts a complete hash chain and reports its boundaries', () => {
    const first = event('event-1', 'OrderRequested', null);
    const second = event('event-2', 'OrderQuoted', first.hash);

    expect(verifyTrace([first, second])).toEqual({
      valid: true,
      eventCount: 2,
      firstHash: first.hash,
      lastHash: second.hash,
    });
  });

  it('rejects a tampered payload or broken predecessor link', () => {
    const first = event('event-1', 'OrderRequested', null);
    const second = event('event-2', 'OrderQuoted', first.hash);
    expect(
      verifyTrace([{ ...second, payload: { ...second.payload, status: 'Tampered' } }, first]),
    ).toMatchObject({
      valid: false,
    });
  });
});
