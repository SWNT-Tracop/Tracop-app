import { createHash } from 'node:crypto';

export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

export const hashOrderEvent = (previousHash: string | null, event: unknown): string =>
  createHash('sha256')
    .update(previousHash ?? '')
    .update(canonicalJson(event))
    .digest('hex');

export const verifyOrderEventChain = (
  events: readonly {
    readonly prevHash: string | null;
    readonly hash: string;
    readonly payload: unknown;
  }[],
): boolean => {
  let previous: string | null = null;
  for (const event of events) {
    if (event.prevHash !== previous || hashOrderEvent(previous, event.payload) !== event.hash)
      return false;
    previous = event.hash;
  }
  return true;
};
