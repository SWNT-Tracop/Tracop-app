import type { ParameterKey } from '../kernel/parameter-keys.js';

export { PARAMETER_KEYS, type ParameterKey } from '../kernel/parameter-keys.js';

/**
 * Reads a run-time business parameter. Each key has a typed default from the environment; a
 * value stored by the staff overrides it from then on (forward only).
 */
export interface ParameterReader {
  get(key: ParameterKey): Promise<bigint>;
}

export const PARAMETER_READER = Symbol('PARAMETER_READER');
