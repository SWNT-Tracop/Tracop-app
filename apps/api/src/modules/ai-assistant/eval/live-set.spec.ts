import { LIVE_SET } from './live-set.js';

describe('live evaluation set', () => {
  it('has at least 40 synthetic phrases covering every kind, adversarial ones included', () => {
    expect(LIVE_SET.length).toBeGreaterThanOrEqual(40);
    const kinds = new Map<string, number>();
    for (const item of LIVE_SET) kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1);
    expect([...kinds.keys()].sort()).toEqual([
      'adversarial',
      'ambiguous',
      'basic',
      'dates',
      'money',
      'units',
    ]);
    expect(kinds.get('adversarial')).toBeGreaterThanOrEqual(5);
    expect(new Set(LIVE_SET.map(({ text }) => text)).size).toBe(LIVE_SET.length);
  });
});
