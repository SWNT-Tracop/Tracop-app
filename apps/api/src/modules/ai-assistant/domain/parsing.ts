/**
 * Deterministic parsing of what a producer writes. The LLM only points at the words
 * («80 mil», «2 bultos», «el viernes»); the numbers, units and dates come from here,
 * so a model mistake cannot invent a price or a unit.
 */

export const LOT_UNITS = [
  'kg',
  'g',
  'lb',
  'und',
  'docena',
  'arroba',
  'quintal',
  'caja',
  'mano',
  'bulto',
] as const;
export type LotUnit = (typeof LOT_UNITS)[number];

/** Upper bound for one unit price in COP; above it the text is almost surely misread. PROVISIONAL. */
export const MAX_UNIT_PRICE_COP = 100_000_000n;
export const MAX_QUANTITY_MILLI = 999_999_999_999n;

const fold = (value: string): string =>
  value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  quince: 15,
  veinte: 20,
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
  cien: 100,
  doscientos: 200,
  trescientos: 300,
  quinientos: 500,
};

/**
 * A decimal written as «2», «2,5», «2.5» or «1.500.000» into an exact count of thousandths.
 * Dots or commas followed by exactly three digits group thousands; otherwise they are decimals.
 */
const decimalToMilli = (raw: string): bigint | null => {
  const text = raw.replace(/\s/g, '');
  if (!/^\d{1,15}([.,]\d+)*$/.test(text)) return null;
  const groups = text.split(/[.,]/);
  const thousands = groups.length > 1 && groups.slice(1).every((group) => group.length === 3);
  if (thousands && groups[0]!.length <= 3) return BigInt(groups.join('')) * 1000n;
  if (groups.length > 2) return null;
  const [whole, fraction = ''] = groups as [string, string?];
  if (fraction.length > 3) return null;
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0') || '0');
};

const wordOrDigitsToMilli = (token: string): bigint | null => {
  if (token === 'medio' || token === 'media') return 500n;
  const word = NUMBER_WORDS[token];
  if (word !== undefined) return BigInt(word) * 1000n;
  return decimalToMilli(token);
};

const MULTIPLIERS: Readonly<Record<string, bigint>> = {
  mil: 1_000n,
  k: 1_000n,
  millon: 1_000_000n,
  millones: 1_000_000n,
  palo: 1_000_000n,
  palos: 1_000_000n,
};

/**
 * An amount in Colombian pesos: «80 mil», «$80.000», «1,5 millones», «ochenta mil», «un millón».
 * Returns null when it is not exactly one whole amount.
 */
export const parseCop = (raw: string): bigint | null => {
  const text = fold(raw)
    .replace(/\$|\bcop\b|\bpesos?\b|\bcolombianos?\b/g, ' ')
    .replace(/(\d)(mil|k|millones|millon|palos?)\b/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  const tokens = text.split(' ');
  if (tokens.length === 1 && tokens[0] === 'mil') return 1_000n;
  if (tokens.length === 1) {
    const milli = decimalToMilli(tokens[0]!);
    return milli !== null && milli % 1000n === 0n ? milli / 1000n : null;
  }
  // «medio millón», «un millón doscientos mil» is out of scope: one number and one multiplier.
  if (tokens.length === 2) {
    const multiplier = MULTIPLIERS[tokens[1]!];
    const milli = wordOrDigitsToMilli(tokens[0]!);
    if (multiplier === undefined || milli === null) return null;
    const value = milli * multiplier;
    return value % 1000n === 0n ? value / 1000n : null;
  }
  return null;
};

/** A positive quantity in thousandths: «2», «2,5», «dos», «media». */
export const parseQuantityMilli = (raw: string): bigint | null => {
  const text = fold(raw);
  const value = wordOrDigitsToMilli(text);
  if (value === null || value <= 0n || value > MAX_QUANTITY_MILLI) return null;
  return value;
};

const UNIT_WORDS: Readonly<Record<string, LotUnit>> = {
  kg: 'kg',
  kgs: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  kilogramo: 'kg',
  kilogramos: 'kg',
  g: 'g',
  gr: 'g',
  gramo: 'g',
  gramos: 'g',
  lb: 'lb',
  libra: 'lb',
  libras: 'lb',
  und: 'und',
  unidad: 'und',
  unidades: 'und',
  docena: 'docena',
  docenas: 'docena',
  arroba: 'arroba',
  arrobas: 'arroba',
  quintal: 'quintal',
  quintales: 'quintal',
  caja: 'caja',
  cajas: 'caja',
  mano: 'mano',
  manos: 'mano',
  bulto: 'bulto',
  bultos: 'bulto',
};

export type UnitParse =
  { readonly kind: 'unit'; readonly unit: LotUnit } | { readonly kind: 'unsupported' };

/**
 * One of the catalog's units, or `unsupported` («carga», «canastilla», «tonelada»…): the bot then
 * asks for a supported unit instead of guessing an equivalence.
 */
export const parseUnit = (raw: string): UnitParse => {
  const unit = UNIT_WORDS[fold(raw).replace(/[.\s]/g, '')];
  return unit ? { kind: 'unit', unit } : { kind: 'unsupported' };
};

export type PriceBasis = 'unit' | 'total';

/**
 * The unit price in COP from a per-unit or a total amount. A total that does not split into a
 * whole number of pesos per unit is refused, so the bot asks for the unit price.
 */
export const unitPriceFrom = (
  amount: bigint,
  basis: PriceBasis,
  quantityMilli: bigint,
): bigint | null => {
  if (amount <= 0n) return null;
  if (basis === 'unit') return amount <= MAX_UNIT_PRICE_COP ? amount : null;
  const scaled = amount * 1000n;
  if (scaled % quantityMilli !== 0n) return null;
  const unitPrice = scaled / quantityMilli;
  return unitPrice > 0n && unitPrice <= MAX_UNIT_PRICE_COP ? unitPrice : null;
};

/** Total in COP for display, computed by code (never by the model); null if not whole pesos. */
export const totalCop = (unitPrice: bigint, quantityMilli: bigint): bigint | null => {
  const scaled = unitPrice * quantityMilli;
  return scaled % 1000n === 0n ? scaled / 1000n : null;
};

/** «$1.500.000»: thousands grouped with dots, by slicing (no regular expression). */
export const formatCop = (amount: bigint): string => {
  const digits = amount.toString();
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3)
    groups.unshift(digits.slice(Math.max(0, end - 3), end));
  return `$${groups.join('.')}`;
};

export const formatQuantity = (quantityMilli: bigint): string => {
  const whole = quantityMilli / 1000n;
  let fraction = (quantityMilli % 1000n).toString().padStart(3, '0');
  while (fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  return fraction ? `${whole},${fraction}` : whole.toString();
};
