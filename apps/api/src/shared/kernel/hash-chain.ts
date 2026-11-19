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

export const hashChain = (previousHash: string | null, payload: unknown): string =>
  createHash('sha256')
    .update(previousHash ?? '')
    .update(canonicalJson(payload))
    .digest('hex');

export const verifyHashChain = <T extends { prevHash: string | null; hash: string }>(
  events: readonly T[],
  payloadOf: (event: T) => unknown,
): boolean => {
  let previous: string | null = null;
  for (const event of events) {
    if (event.prevHash !== previous || hashChain(previous, payloadOf(event)) !== event.hash)
      return false;
    previous = event.hash;
  }
  return true;
};
