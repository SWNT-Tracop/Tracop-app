export function findJsonScalarPaths(value: unknown, expected: string | number): string[] {
  const matches: string[] = [];

  const visit = (current: unknown, path: string): void => {
    if (current === expected) {
      matches.push(path);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
    } else if (typeof current === 'object' && current !== null) {
      for (const [key, child] of Object.entries(current)) {
        visit(child, path ? `${path}.${key}` : key);
      }
    }
  };

  visit(value, '$');
  return matches;
}

export function parseJsonLines(output: string): unknown[] {
  return output.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}
