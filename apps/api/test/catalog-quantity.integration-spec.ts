import pg from 'pg';
import { describePostgres } from './postgres-suite.js';

describePostgres('catalog numeric(12,3) quantity migration', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterAll(async () => pool.end());

  it('stores and returns numeric(12,3) values exactly at both precision bounds', async () => {
    const type = await pool.query<{
      data_type: string;
      numeric_precision: number;
      numeric_scale: number;
    }>(
      `SELECT data_type, numeric_precision, numeric_scale FROM information_schema.columns
       WHERE table_schema = 'catalog' AND table_name = 'lots' AND column_name = 'quantity'`,
    );
    expect(type.rows[0]).toEqual({
      data_type: 'numeric',
      numeric_precision: 12,
      numeric_scale: 3,
    });
    const values = await pool.query<{ quantity: string }>(
      `SELECT value::numeric(12,3)::text AS quantity FROM unnest(ARRAY['0.001', '999999999.999']) AS value`,
    );
    expect(values.rows.map(({ quantity }) => quantity)).toEqual(['0.001', '999999999.999']);
  });
});
