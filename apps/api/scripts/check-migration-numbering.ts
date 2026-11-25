import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export const validateMigrationNames = (filenames: readonly string[]): readonly string[] => {
  const migrations = filenames
    .filter((filename) => /^\d{4}_.*\.sql$/.test(filename))
    .map((filename) => ({
      filename,
      number: Number(filename.slice(0, 4)),
    }));
  const errors: string[] = [];
  const seen = new Map<number, string>();

  for (const migration of migrations) {
    const previous = seen.get(migration.number);
    if (previous) {
      errors.push(`número duplicado ${migration.number}: ${previous}, ${migration.filename}`);
    } else {
      seen.set(migration.number, migration.filename);
    }
  }

  const numbers = [...seen.keys()].sort((left, right) => left - right);
  for (let index = 1; index < numbers.length; index += 1) {
    const previous = numbers[index - 1];
    const current = numbers[index];
    if (previous !== undefined && current !== undefined && current !== previous + 1) {
      for (let missing = previous + 1; missing < current; missing += 1)
        errors.push(`número de migración faltante ${String(missing).padStart(4, '0')}`);
    }
  }
  return errors;
};

export const runMigrationNumberingCheck = async (): Promise<void> => {
  const drizzleDirectory = resolve(process.cwd(), 'drizzle');
  const filenames = await readdir(drizzleDirectory);
  const errors = validateMigrationNames(filenames);
  if (errors.length > 0) throw new Error(`Chequeo de migraciones falló:\n${errors.join('\n')}`);
  console.log('Migraciones: numeración única y sin huecos.');
};

if (process.argv[1]?.endsWith('/check-migration-numbering.ts')) {
  void runMigrationNumberingCheck().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
