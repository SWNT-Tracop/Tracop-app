import { validateMigrationNames } from '../scripts/check-migration-numbering.js';

describe('migration numbering', () => {
  it('rejects duplicate migration numbers', () => {
    expect(validateMigrationNames(['0011_ordering.sql', '0011_ordering_again.sql'])).toEqual([
      'número duplicado 11: 0011_ordering.sql, 0011_ordering_again.sql',
    ]);
  });

  it('rejects gaps in migration numbers', () => {
    expect(validateMigrationNames(['0011_ordering.sql', '0013_payments.sql'])).toEqual([
      'número de migración faltante 0012',
    ]);
  });

  it('accepts a contiguous migration range', () => {
    expect(validateMigrationNames(['0011_ordering.sql', '0012_catalog.sql'])).toEqual([]);
  });
});
