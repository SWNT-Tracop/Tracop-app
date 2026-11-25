export type TextExposure = { readonly path: string; readonly value: string };

/**
 * Walks a parsed value (response body, sync payload, log entry) and reports every string field
 * that contains one of the given texts (case-insensitive), with its path. It inspects values
 * structurally, the way findCoordinateExposure does for coordinates.
 */
export function findTextExposure(value: unknown, texts: readonly string[]): TextExposure[] {
  const needles = texts.map((text) => text.toLocaleLowerCase('es-CO'));
  const exposures: TextExposure[] = [];
  const visit = (current: unknown, path: string): void => {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (typeof current === 'string') {
      const lower = current.toLocaleLowerCase('es-CO');
      if (needles.some((needle) => lower.includes(needle)))
        exposures.push({ path, value: current });
      return;
    }
    if (typeof current !== 'object' || current === null) return;
    for (const [key, child] of Object.entries(current)) visit(child, path ? `${path}.${key}` : key);
  };
  visit(value, '');
  return exposures;
}
