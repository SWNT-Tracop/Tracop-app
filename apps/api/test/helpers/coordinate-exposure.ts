const COORDINATE_KEY_PATTERN = /lat|lng|lon|latitude|longitude|location|coordinates?/i;
const NUMERIC_STRING_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const COORDINATE_TOLERANCE = 1e-6;

export type CoordinatePair = {
  latitude: number;
  longitude: number;
};

export type CoordinateExposure = {
  path: string;
  kind: 'coordinate-key' | 'coordinate-value';
  value: unknown;
};

export function findCoordinateExposure(
  value: unknown,
  coordinates: readonly CoordinatePair[],
  publicCoordinateKeys: readonly string[] = [],
): CoordinateExposure[] {
  const exposures: CoordinateExposure[] = [];
  const publicKeys = new Set(publicCoordinateKeys.map((key) => key.toLowerCase()));

  const visit = (current: unknown, path: string): void => {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }

    if (typeof current !== 'object' || current === null) {
      if (isCoordinateValue(current, coordinates)) {
        exposures.push({ path, kind: 'coordinate-value', value: current });
      }
      return;
    }

    for (const [key, child] of Object.entries(current)) {
      const childPath = path ? `${path}.${key}` : key;
      if (COORDINATE_KEY_PATTERN.test(key) && !publicKeys.has(key.toLowerCase())) {
        exposures.push({ path: childPath, kind: 'coordinate-key', value: child });
      }
      visit(child, childPath);
    }
  };

  visit(value, '$');
  return exposures;
}

function isCoordinateValue(value: unknown, coordinates: readonly CoordinatePair[]): boolean {
  if (typeof value !== 'number' && typeof value !== 'string') return false;
  if (typeof value === 'string' && !NUMERIC_STRING_PATTERN.test(value.trim())) return false;

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return false;

  return coordinates.some(
    ({ latitude, longitude }) =>
      Math.abs(numericValue - latitude) <= COORDINATE_TOLERANCE ||
      Math.abs(numericValue - longitude) <= COORDINATE_TOLERANCE,
  );
}
