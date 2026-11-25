/**
 * Deterministic evaluation set (CI, no model): money, quantities, units, relative dates in
 * America/Bogota and locations in Colombia. It must be 100 % correct with zero critical errors
 * (a price off by an order of magnitude, a wrong unit or a wrong quantity).
 */
import { isWithinColombia } from '../../../shared/kernel/geo.js';
import { availabilityWindow, bogotaDay, parseDay } from './dates.js';
import {
  formatCop,
  formatQuantity,
  parseCop,
  parseQuantityMilli,
  parseUnit,
  totalCop,
  unitPriceFrom,
} from './parsing.js';

// Wednesday 25 November 2026, 10:00 in Bogotá.
const NOW = new Date('2026-11-25T15:00:00.000Z');

const MONEY: readonly (readonly [string, bigint | null])[] = [
  ['80 mil', 80_000n],
  ['80mil', 80_000n],
  ['$80.000', 80_000n],
  ['80.000', 80_000n],
  ['80,000', 80_000n],
  ['$ 80.000 pesos', 80_000n],
  ['80000', 80_000n],
  ['1,5 millones', 1_500_000n],
  ['1.5 millones', 1_500_000n],
  ['un millón', 1_000_000n],
  ['2 millones', 2_000_000n],
  ['1.500.000', 1_500_000n],
  ['ochenta mil', 80_000n],
  ['quinientos mil', 500_000n],
  ['mil', 1_000n],
  ['3.500', 3_500n],
  ['2,5 mil', 2_500n],
  ['80k', 80_000n],
  ['dos palos', 2_000_000n],
  ['80 mil COP', 80_000n],
  ['ochenta', null],
  ['barato', null],
  ['', null],
  ['1,2345 mil', null],
  ['80 mil 500', null],
];

const QUANTITIES: readonly (readonly [string, bigint | null])[] = [
  ['2', 2_000n],
  ['dos', 2_000n],
  ['2,5', 2_500n],
  ['2.5', 2_500n],
  ['media', 500n],
  ['medio', 500n],
  ['doce', 12_000n],
  ['1.000', 1_000_000n],
  ['0', null],
  ['-3', null],
  ['muchos', null],
  ['2,1234', null],
];

const UNITS: readonly (readonly [string, string | null])[] = [
  ['bultos', 'bulto'],
  ['Bulto', 'bulto'],
  ['kilos', 'kg'],
  ['kg', 'kg'],
  ['Kg.', 'kg'],
  ['libras', 'lb'],
  ['arrobas', 'arroba'],
  ['docena', 'docena'],
  ['unidades', 'und'],
  ['cajas', 'caja'],
  ['quintal', 'quintal'],
  ['manos', 'mano'],
  ['gramos', 'g'],
  ['carga', null],
  ['canastillas', null],
  ['toneladas', null],
  ['bolsas', null],
];

const DAYS: readonly (readonly [string, string | 'ambiguous' | 'invalid'])[] = [
  ['hoy', '2026-11-25'],
  ['ya', '2026-11-25'],
  ['desde hoy', '2026-11-25'],
  ['mañana', '2026-11-26'],
  ['pasado mañana', '2026-11-27'],
  ['el viernes', '2026-11-27'],
  ['para el viernes', '2026-11-27'],
  ['viernes', '2026-11-27'],
  ['el sábado', '2026-11-28'],
  ['el lunes', '2026-11-30'],
  ['el martes', '2026-12-01'],
  ['el miércoles', 'ambiguous'], // said on a Wednesday
  ['el próximo miércoles', '2026-12-02'],
  ['el próximo viernes', 'ambiguous'],
  ['en 3 días', '2026-11-28'],
  ['dentro de dos días', '2026-11-27'],
  ['28 de noviembre', '2026-11-28'],
  ['el 3 de diciembre', '2026-12-03'],
  ['28/11', '2026-11-28'],
  ['3/12/2026', '2026-12-03'],
  ['20 de noviembre', 'ambiguous'], // already past this year
  ['31 de noviembre', 'invalid'],
  ['la otra semana', 'ambiguous'],
  ['pronto', 'ambiguous'],
  ['cuando pueda', 'invalid'],
];

describe('deterministic evaluation set', () => {
  it.each(MONEY)('reads «%s» as %s COP', (text, expected) => {
    expect(parseCop(text)).toBe(expected);
  });

  it.each(QUANTITIES)('reads quantity «%s» as %s thousandths', (text, expected) => {
    expect(parseQuantityMilli(text)).toBe(expected);
  });

  it.each(UNITS)('maps unit «%s» to %s without inventing equivalences', (text, expected) => {
    const parsed = parseUnit(text);
    expect(parsed.kind === 'unit' ? parsed.unit : null).toBe(expected);
  });

  it.each(DAYS)('resolves «%s» on Wednesday 25 Nov 2026 in Bogotá as %s', (text, expected) => {
    const parsed = parseDay(text, NOW);
    expect(parsed.kind === 'day' ? parsed.date : parsed.kind).toBe(expected);
  });

  it('uses the Bogotá calendar day near midnight UTC', () => {
    // 23:30 Bogotá on the 25th is 04:30 UTC on the 26th.
    const lateEvening = new Date('2026-11-26T04:30:00.000Z');
    expect(bogotaDay(lateEvening)).toBe('2026-11-25');
    expect(parseDay('mañana', lateEvening)).toEqual({ kind: 'day', date: '2026-11-26' });
  });

  it('computes unit prices and totals in code, refusing totals that do not split exactly', () => {
    expect(unitPriceFrom(160_000n, 'total', 2_000n)).toBe(80_000n);
    expect(unitPriceFrom(80_000n, 'unit', 2_000n)).toBe(80_000n);
    expect(unitPriceFrom(100_000n, 'total', 3_000n)).toBeNull();
    expect(unitPriceFrom(500_000_000n, 'unit', 1_000n)).toBeNull(); // order of magnitude guard
    expect(totalCop(80_000n, 2_500n)).toBe(200_000n);
  });

  it('formats pesos and quantities for the confirmation', () => {
    expect([0n, 999n, 1_000n, 80_000n, 1_500_000n, 100_000_000n].map(formatCop)).toEqual([
      '$0',
      '$999',
      '$1.000',
      '$80.000',
      '$1.500.000',
      '$100.000.000',
    ]);
    expect([2_000n, 2_500n, 2_050n, 1n, 500n].map(formatQuantity)).toEqual([
      '2',
      '2,5',
      '2,05',
      '0,001',
      '0,5',
    ]);
  });

  it('keeps availability within the horizon and in order', () => {
    expect(availabilityWindow('2026-11-27', '2026-11-26', NOW, 90).kind).toBe('until_before_from');
    expect(availabilityWindow('2026-11-27', '2027-06-01', NOW, 90).kind).toBe('beyond_horizon');
    const window = availabilityWindow('2026-11-25', '2026-11-28', NOW, 90);
    expect(window).toEqual({
      kind: 'ok',
      from: NOW, // today starts now, not at midnight in the past
      until: new Date('2026-11-29T04:59:59.999Z'),
    });
  });

  it('accepts locations only inside Colombia', () => {
    expect(isWithinColombia(5.53, -73.36)).toBe(true); // Tunja
    expect(isWithinColombia(4.71, -74.07)).toBe(true); // Bogotá
    expect(isWithinColombia(40.41, -3.7)).toBe(false); // Madrid
    expect(isWithinColombia(-12.04, -77.04)).toBe(false); // Lima
  });

  it('reports 100 % on the whole set', () => {
    const results = [
      ...MONEY.map(([text, expected]) => parseCop(text) === expected),
      ...QUANTITIES.map(([text, expected]) => parseQuantityMilli(text) === expected),
      ...UNITS.map(([text, expected]) => {
        const parsed = parseUnit(text);
        return (parsed.kind === 'unit' ? parsed.unit : null) === expected;
      }),
      ...DAYS.map(([text, expected]) => {
        const parsed = parseDay(text, NOW);
        return (parsed.kind === 'day' ? parsed.date : parsed.kind) === expected;
      }),
    ];
    const accuracy = results.filter(Boolean).length / results.length;
    expect({ cases: results.length, accuracy }).toEqual({ cases: results.length, accuracy: 1 });
    expect(results.length).toBeGreaterThanOrEqual(70);
  });
});
