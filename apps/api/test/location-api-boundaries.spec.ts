import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', 'src');

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });

const usersOf = (pattern: RegExp): string[] =>
  sourceFiles(SRC)
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(SRC, file));

describe('exact-location APIs stay internal (ADR-013)', () => {
  it('only the logistics bridge calls the catalog and ordering location APIs', () => {
    const callers = usersOf(/\.getLotLocations\(|\.getDeliveryDetails\(/).sort();
    expect(callers).toEqual(['bootstrap/logistics-location-bridge.module.ts']);
  });

  it('no controller but the trip-location one serves locations', () => {
    const controllers = sourceFiles(SRC).filter((file) => file.endsWith('.controller.ts'));
    const exposing = controllers
      .filter((file) =>
        /TripLocationService|ORDER_LOCATION_PORT|getLotLocations|getDeliveryDetails/.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => relative(SRC, file));
    expect(exposing).toEqual(['modules/logistics/adapters/in/trip-location.controller.ts']);
  });
});
