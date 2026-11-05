import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

const collectTypeScriptFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return collectTypeScriptFiles(path);
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    }),
  );
  return nested.flat();
};

describe('catalog/identity module boundaries', () => {
  it('prevents direct imports between catalog and identity internals', async () => {
    const modulesRoot = resolve(process.cwd(), 'src/modules');
    const catalogRoot = resolve(modulesRoot, 'catalog');
    const identityRoot = resolve(modulesRoot, 'identity');
    const sources = await Promise.all([
      ...[catalogRoot, identityRoot].map((root) => collectTypeScriptFiles(root)),
    ]);
    const violations: string[] = [];
    for (const file of sources.flat()) {
      const sourceRoot = file.startsWith(`${catalogRoot}${sep}`) ? catalogRoot : identityRoot;
      const forbiddenRoot = sourceRoot === catalogRoot ? identityRoot : catalogRoot;
      const content = await readFile(file, 'utf8');
      for (const [, specifier] of content.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
        if (!specifier?.startsWith('.')) continue;
        const target = resolve(dirname(file), specifier);
        if (target === forbiddenRoot || target.startsWith(`${forbiddenRoot}${sep}`)) {
          violations.push(`${relative(modulesRoot, file)} -> ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
