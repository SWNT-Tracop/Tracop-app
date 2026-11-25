import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const sourceRoot = resolve('src');
const syncWriterPath = 'modules/sync/adapters/out/drizzle-sync-repository.ts';
const listTypeScriptFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listTypeScriptFiles(path) : path.endsWith('.ts') ? [path] : [];
  });

describe('sync change-log write boundary', () => {
  it('keeps every production INSERT and the sole sequence lock in the sync repository', () => {
    const files = listTypeScriptFiles(sourceRoot);
    const syncWriter = files.find((file) => relative(sourceRoot, file) === syncWriterPath);
    expect(syncWriter).toBeDefined();
    const writerSource = readFileSync(syncWriter!, 'utf8');
    const productionSources = files.map((file) => ({
      path: relative(sourceRoot, file),
      source: readFileSync(file, 'utf8'),
    }));

    expect(writerSource.match(/INSERT\s+INTO\s+sync\.change_log/gi)).toHaveLength(1);
    expect(
      writerSource.match(/pg_advisory_xact_lock\(\$\{SEQUENCE_LOCK_NAMESPACE\}/g),
    ).toHaveLength(1);
    expect(
      productionSources
        .filter(({ path }) => path !== syncWriterPath)
        .filter(({ source }) =>
          /INSERT\s+INTO\s+sync\.change_log|\.insert\(changeLog\)/i.test(source),
        )
        .map(({ path }) => path),
    ).toEqual([]);
  });
});
