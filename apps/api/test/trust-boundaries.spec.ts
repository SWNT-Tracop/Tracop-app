import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', 'src');
const TRUST = join(SRC, 'modules', 'trust');

const files = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });

const importsOf = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]!);

describe('trust module boundaries', () => {
  it('imports no other business module, not even its public index', () => {
    const offending = files(TRUST).flatMap((file) =>
      importsOf(file)
        .filter((path) =>
          /(^|\/)(catalog|ordering|logistics|identity|payments|notifications|messaging|sync|backoffice)(\/|$)/.test(
            path,
          ),
        )
        .map((path) => `${relative(SRC, file)} -> ${path}`),
    );
    expect(offending).toEqual([]);
  });

  it('reaches catalog and ordering only through bootstrap bridges', () => {
    const users = files(SRC)
      .filter((file) => !file.startsWith(TRUST) && !file.endsWith('.spec.ts'))
      .filter((file) => importsOf(file).some((path) => /modules\/trust\//.test(path)))
      .map((file) => relative(SRC, file))
      .sort();
    expect(users).toEqual([
      'bootstrap/app.module.ts',
      'bootstrap/recommendations-bridge.module.ts',
      'bootstrap/trust-bridge.module.ts',
      'bootstrap/worker.module.ts',
    ]);
  });
});
