/**
 * Reference price file, converted by a person from the DANE-SIPSA anexo (the XLSX layout is
 * not verified, so the importer reads this documented CSV instead):
 *
 *   fecha,mercado,producto,presentacion,precio
 *   2026-11-24,Bogotá Corabastos,Papa criolla limpia,bulto 50 kg,95000
 *
 * UTF-8, comma separated, optional double quotes, integer COP. Rows with any problem are
 * rejected by line number; nothing of a bad file is imported.
 */
export const REFERENCE_CSV_HEADER = [
  'fecha',
  'mercado',
  'producto',
  'presentacion',
  'precio',
] as const;
export const MAX_REFERENCE_ROWS = 50_000;
const MAX_TEXT = 120;
const MAX_PRICE = 100_000_000n;

export interface ReferenceRow {
  readonly observedOn: string; // YYYY-MM-DD
  readonly market: string;
  readonly sourceProduct: string;
  readonly presentation: string;
  readonly price: bigint;
}

export type ReferenceParse =
  | { readonly ok: true; readonly rows: readonly ReferenceRow[] }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Splits one CSV line, honouring double quotes ("" is a literal quote). */
export const splitCsvLine = (line: string): string[] => {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      cells.push(current);
      current = '';
    } else current += char;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
};

const validDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/** Normalized text for matching a source product with the staff's mapping. */
export const normalizeSourceText = (value: string): string =>
  value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

export const parseReferenceCsv = (content: string): ReferenceParse => {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = splitCsvLine(lines[0] ?? '').map((cell) => cell.toLowerCase());
  if (header.join(',') !== REFERENCE_CSV_HEADER.join(','))
    return { ok: false, errors: [`línea 1: cabecera esperada ${REFERENCE_CSV_HEADER.join(',')}`] };
  const rows: ReferenceRow[] = [];
  const errors: string[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    const number = index + 1;
    const cells = splitCsvLine(line);
    if (cells.length !== REFERENCE_CSV_HEADER.length) {
      errors.push(`línea ${number}: se esperaban 5 columnas`);
      continue;
    }
    const [observedOn, market, sourceProduct, presentation, price] = cells as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (!validDate(observedOn)) errors.push(`línea ${number}: fecha inválida`);
    else if (
      ![market, sourceProduct, presentation].every(
        (text) => text.length > 0 && text.length <= MAX_TEXT,
      )
    )
      errors.push(`línea ${number}: texto vacío o demasiado largo`);
    else if (!/^\d{1,9}$/.test(price) || BigInt(price) <= 0n || BigInt(price) > MAX_PRICE)
      errors.push(`línea ${number}: precio inválido (entero en COP)`);
    else rows.push({ observedOn, market, sourceProduct, presentation, price: BigInt(price) });
    if (rows.length > MAX_REFERENCE_ROWS)
      return { ok: false, errors: ['archivo demasiado grande'] };
  }
  return errors.length ? { ok: false, errors: errors.slice(0, 20) } : { ok: true, rows };
};
