import { alertMatches, newAlert, roundCoordinate } from './alerts.js';
import { percentile, sortValues, suggestPrice, type Observation } from './pricing.js';
import { normalizeSourceText, parseReferenceCsv, splitCsvLine } from './reference-csv.js';
import { isAfter, rank, type CandidateFacts, type ScoringContext } from './scoring.js';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const values = (...items: number[]) => sortValues(items.map(BigInt));

describe('percentiles (R-7, integer, half up)', () => {
  it.each([
    [[100], 25, 100n],
    [[100], 75, 100n],
    [[100, 200], 25, 125n],
    [[100, 200], 50, 150n],
    [[100, 200], 75, 175n],
    [[100, 200, 300], 25, 150n],
    [[100, 200, 300], 50, 200n],
    [[100, 200, 300, 400], 25, 175n],
    [[100, 200, 300, 400], 75, 325n],
    [[1, 2], 25, 1n], // 1.25 → 1
    [[1, 3], 25, 2n], // 1.5 → 2 (half up)
    [[90_000, 90_000, 90_000], 25, 90_000n],
    [[5, 1, 3], 50, 3n], // unsorted input is sorted first
  ])('%j at P%i is %s', (input, q, expected) => {
    expect(percentile(values(...(input as number[])), q as number)).toBe(expected);
  });

  it('refuses empty data and out-of-range percentiles', () => {
    expect(() => percentile([], 50)).toThrow();
    expect(() => percentile(values(1), 101)).toThrow();
    expect(() => percentile(values(1), 12.5)).toThrow();
  });
});

describe('price suggestion', () => {
  const rules = { minSample: 3, minOwnObservations: 3, minOwnProviders: 2 };
  const reference = (...prices: number[]) =>
    prices.map((price, index) => ({
      price: BigInt(price),
      observedAt: day(`2026-11-${10 + index}`),
    }));
  const own = (...entries: [number, string][]): Observation[] =>
    entries.map(([price, provider], index) => ({
      unitPrice: BigInt(price),
      observedAt: day(`2026-11-${20 + index}`),
      providerKey: provider,
    }));

  it('needs at least three values (k ≥ 3)', () => {
    expect(suggestPrice([], [], rules)).toEqual({ status: 'insufficient_data' });
    expect(suggestPrice(reference(90_000, 95_000), [], rules)).toEqual({
      status: 'insufficient_data',
    });
  });

  it('uses the reference alone with fewer than three own observations', () => {
    const result = suggestPrice(
      reference(80_000, 90_000, 100_000),
      own([200_000, 'a'], [210_000, 'b']),
      rules,
    );
    expect(result).toEqual({
      status: 'ok',
      low: 85_000n,
      median: 90_000n,
      high: 95_000n,
      sources: [{ name: 'DANE-SIPSA', count: 3, observedAt: day('2026-11-12') }],
    });
  });

  it('ignores own observations from a single provider', () => {
    const result = suggestPrice(
      reference(80_000, 90_000, 100_000),
      own([1, 'a'], [1, 'a'], [1, 'a']),
      rules,
    );
    expect(result).toMatchObject({ low: 85_000n, sources: [{ name: 'DANE-SIPSA' }] });
  });

  it('combines both sources when there are enough own observations from two providers', () => {
    const result = suggestPrice(
      reference(80_000, 90_000, 100_000),
      own([70_000, 'a'], [75_000, 'b'], [110_000, 'a']),
      rules,
    );
    expect(result).toEqual({
      status: 'ok',
      low: 76_250n, // sorted 70, 75, 80, 90, 100, 110 (thousands): P25 at 1.25 → 75 + 0.25 × 5
      median: 85_000n,
      high: 97_500n,
      sources: [
        { name: 'DANE-SIPSA', count: 3, observedAt: day('2026-11-12') },
        { name: 'TRACOP', count: 3, observedAt: day('2026-11-22') },
      ],
    });
  });

  it('works with own observations alone once they qualify', () => {
    expect(suggestPrice([], own([10, 'a'], [20, 'b'], [30, 'c']), rules)).toMatchObject({
      status: 'ok',
      low: 15n,
      high: 25n,
      sources: [{ name: 'TRACOP', count: 3 }],
    });
  });
});

describe('lot ranking', () => {
  const now = new Date('2026-11-25T15:00:00.000Z');
  const context: ScoringContext = {
    purchasedProductIds: new Set(['p-papa']),
    now,
    nearbyKm: 50,
    freshHours: 48,
    weights: { reorder: 30, nearby: 20, good_price: 25, verified_provider: 15, fresh: 10 },
  };
  const lot = (id: string, overrides: Partial<CandidateFacts> = {}): CandidateFacts => ({
    lotId: id,
    productId: 'p-other',
    unitPrice: 100n,
    availableFrom: new Date('2026-11-01T00:00:00.000Z'),
    distanceKm: null,
    providerVerified: false,
    referenceMedian: null,
    ...overrides,
  });
  const candidates = [
    lot('00000000-0000-7000-8000-000000000004', { productId: 'p-papa' }),
    lot('00000000-0000-7000-8000-000000000002', { distanceKm: 10, providerVerified: true }),
    lot('00000000-0000-7000-8000-000000000003', { distanceKm: 51, referenceMedian: 100n }),
    lot('00000000-0000-7000-8000-000000000001', { referenceMedian: 90n }), // no reason
    lot('00000000-0000-7000-8000-000000000005', {
      productId: 'p-papa',
      availableFrom: new Date('2026-11-25T00:00:00.000Z'),
    }),
  ];

  it('scores by the weights of the reasons that hold, highest first, ties by id', () => {
    expect(rank(candidates, context)).toEqual([
      { lotId: '00000000-0000-7000-8000-000000000005', score: 40, reasons: ['reorder', 'fresh'] },
      {
        lotId: '00000000-0000-7000-8000-000000000002',
        score: 35,
        reasons: ['nearby', 'verified_provider'],
      },
      { lotId: '00000000-0000-7000-8000-000000000004', score: 30, reasons: ['reorder'] },
      { lotId: '00000000-0000-7000-8000-000000000003', score: 25, reasons: ['good_price'] },
    ]);
  });

  it('is deterministic whatever the input order', () => {
    const expected = rank(candidates, context);
    for (const shuffled of [
      [...candidates].reverse(),
      [candidates[2]!, candidates[0]!, candidates[4]!, candidates[1]!, candidates[3]!],
    ])
      expect(rank(shuffled, context)).toEqual(expected);
    const tied = [
      lot('00000000-0000-7000-8000-00000000000b', { productId: 'p-papa' }),
      lot('00000000-0000-7000-8000-00000000000a', { productId: 'p-papa' }),
    ];
    expect(rank(tied, context).map(({ lotId }) => lotId)).toEqual([
      '00000000-0000-7000-8000-00000000000a',
      '00000000-0000-7000-8000-00000000000b',
    ]);
  });

  it('continues strictly after a cursor position', () => {
    const ranked = rank(candidates, context);
    const after = ranked[1]!;
    expect(ranked.filter((item) => isAfter(item, after)).map(({ lotId }) => lotId)).toEqual(
      ranked.slice(2).map(({ lotId }) => lotId),
    );
  });
});

describe('price alerts', () => {
  const now = new Date('2026-11-25T15:00:00.000Z');
  const base = {
    id: 'a1',
    buyerId: 'buyer',
    productId: 'p',
    maxPrice: 90_000n,
    radiusKm: 50,
    lat: 4.65432,
    lng: -74.10567,
    now,
  };

  it('keeps only a rounded centre and validates the inputs', () => {
    expect(newAlert(base)).toMatchObject({ centerLat: 4.65, centerLng: -74.11 });
    expect(roundCoordinate(5.535)).toBe(5.54);
    for (const [change, code] of [
      [{ maxPrice: 0n }, 'invalid_price'],
      [{ radiusKm: 0 }, 'invalid_radius'],
      [{ radiusKm: 301 }, 'invalid_radius'],
      [{ lat: 40.4, lng: -3.7 }, 'invalid_coordinates'],
    ] as const)
      expect(() => newAlert({ ...base, ...change })).toThrow(expect.objectContaining({ code }));
  });

  it('matches the same product, under the price, inside the radius, never the buyer’s own lot', () => {
    const alert = newAlert(base); // centre in Bogotá
    const lot = {
      lotId: 'l',
      providerId: 'seller',
      productId: 'p',
      unitPrice: 90_000n,
      lat: 4.6,
      lng: -74.08,
    };
    expect(alertMatches(alert, lot)).toBe(true);
    expect(alertMatches(alert, { ...lot, unitPrice: 90_001n })).toBe(false);
    expect(alertMatches(alert, { ...lot, productId: 'q' })).toBe(false);
    expect(alertMatches(alert, { ...lot, lat: 5.53, lng: -73.36 })).toBe(false); // Tunja, ~120 km
    expect(alertMatches(alert, { ...lot, providerId: 'buyer' })).toBe(false);
  });
});

describe('reference CSV', () => {
  const header = 'fecha,mercado,producto,presentacion,precio';

  it('parses quoted cells and a BOM, normalizing source names for mappings', () => {
    const parsed = parseReferenceCsv(
      `\uFEFF${header}\r\n2026-11-24,"Bogotá, Corabastos",Papa criolla limpia,bulto 50 kg,95000\n\n`,
    );
    expect(parsed).toEqual({
      ok: true,
      rows: [
        {
          observedOn: '2026-11-24',
          market: 'Bogotá, Corabastos',
          sourceProduct: 'Papa criolla limpia',
          presentation: 'bulto 50 kg',
          price: 95_000n,
        },
      ],
    });
    expect(splitCsvLine('a,"b ""c""",d')).toEqual(['a', 'b "c"', 'd']);
    expect(normalizeSourceText('  Papá  CRIOLLA ')).toBe('papa criolla');
  });

  it('rejects the whole file on any bad row, naming the lines', () => {
    expect(parseReferenceCsv('date,market\n')).toEqual({
      ok: false,
      errors: ['línea 1: cabecera esperada fecha,mercado,producto,presentacion,precio'],
    });
    expect(
      parseReferenceCsv(
        `${header}\n2026-02-30,M,P,bulto,1\n2026-11-24,M,P,bulto,9.5\n2026-11-24,,P,bulto,1\n2026-11-24,M,P\n2026-11-24,M,P,bulto,95000`,
      ),
    ).toEqual({
      ok: false,
      errors: [
        'línea 2: fecha inválida',
        'línea 3: precio inválido (entero en COP)',
        'línea 4: texto vacío o demasiado largo',
        'línea 5: se esperaban 5 columnas',
      ],
    });
  });
});
