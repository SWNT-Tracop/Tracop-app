/**
 * Relative availability dates («hoy», «mañana», «el viernes», «28 de noviembre») resolved
 * against the server clock in America/Bogota. Colombia has no daylight saving time, so the
 * offset is fixed at UTC−5. Anything that could mean two days is `ambiguous` and the bot asks.
 */

const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type DayParse =
  | { readonly kind: 'day'; readonly date: string } // YYYY-MM-DD in Bogotá
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'invalid' };

const fold = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[¿?¡!.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The calendar day in Bogotá of an instant, as YYYY-MM-DD. */
export const bogotaDay = (instant: Date): string =>
  new Date(instant.getTime() - BOGOTA_OFFSET_MS).toISOString().slice(0, 10);

const addDays = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);

const weekdayOf = (day: string): number => new Date(`${day}T00:00:00.000Z`).getUTCDay();

/** The first instant of a Bogotá day, in UTC. */
export const startOfBogotaDay = (day: string): Date =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + BOGOTA_OFFSET_MS);

/** The last millisecond of a Bogotá day, in UTC. */
export const endOfBogotaDay = (day: string): Date =>
  new Date(startOfBogotaDay(day).getTime() + DAY_MS - 1);

const WEEKDAYS: Readonly<Record<string, number>> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
};

const MONTHS: Readonly<Record<string, number>> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

const SMALL_NUMBERS: Readonly<Record<string, number>> = {
  un: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  quince: 15,
};

const validDay = (year: number, month: number, dayOfMonth: number): string | null => {
  const candidate = new Date(Date.UTC(year, month - 1, dayOfMonth));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== dayOfMonth
  )
    return null;
  return candidate.toISOString().slice(0, 10);
};

/** A calendar date without year belongs to this year; a past one is ambiguous, not next year. */
const explicitDay = (today: string, month: number, dayOfMonth: number, year?: number): DayParse => {
  const resolved = validDay(year ?? Number(today.slice(0, 4)), month, dayOfMonth);
  if (!resolved) return { kind: 'invalid' };
  if (resolved < today) return { kind: 'ambiguous' };
  return { kind: 'day', date: resolved };
};

export const parseDay = (raw: string, now: Date): DayParse => {
  const today = bogotaDay(now);
  const text = fold(raw)
    .replace(/^(desde|a partir de|para|el|la|este|esta|hasta)\s+/g, '')
    .replace(/^(el|la)\s+/, '');
  if (!text) return { kind: 'invalid' };
  if (['hoy', 'ya', 'ahora', 'de una', 'ahorita', 'hoy mismo'].includes(text))
    return { kind: 'day', date: today };
  if (text === 'manana' || text === 'manana temprano')
    return { kind: 'day', date: addDays(today, 1) };
  if (text === 'pasado manana') return { kind: 'day', date: addDays(today, 2) };

  const inDays = /^(?:en|dentro de)\s+(\d{1,2}|[a-z]+)\s+dias?$/.exec(text);
  if (inDays) {
    const count = /^\d+$/.test(inDays[1]!) ? Number(inDays[1]) : SMALL_NUMBERS[inDays[1]!];
    return count === undefined ? { kind: 'invalid' } : { kind: 'day', date: addDays(today, count) };
  }

  const weekday = /^(proximo\s+|siguiente\s+)?([a-z]+)(\s+que viene)?$/.exec(text);
  if (weekday && WEEKDAYS[weekday[2]!] !== undefined) {
    const target = WEEKDAYS[weekday[2]!]!;
    const ahead = (target - weekdayOf(today) + 7) % 7;
    const explicitNext = Boolean(weekday[1] || weekday[3]);
    // «el viernes» said on a Friday could be today or a week later.
    if (ahead === 0)
      return explicitNext ? { kind: 'day', date: addDays(today, 7) } : { kind: 'ambiguous' };
    // «el próximo viernes» on a Wednesday: this Friday or the next? Ask.
    if (explicitNext) return { kind: 'ambiguous' };
    return { kind: 'day', date: addDays(today, ahead) };
  }

  const named = /^(\d{1,2}) de ([a-z]+)(?: de (\d{4}))?$/.exec(text);
  if (named) {
    const month = MONTHS[named[2]!];
    if (month === undefined) return { kind: 'invalid' };
    return explicitDay(today, month, Number(named[1]), named[3] ? Number(named[3]) : undefined);
  }
  const numeric = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(text);
  if (numeric) {
    return explicitDay(
      today,
      Number(numeric[2]),
      Number(numeric[1]),
      numeric[3] ? Number(numeric[3]) : undefined,
    );
  }
  if (/semana|pronto|luego|despues|mes|quincena/.test(text)) return { kind: 'ambiguous' };
  return { kind: 'invalid' };
};

export type AvailabilityCheck =
  | { readonly kind: 'ok'; readonly from: Date; readonly until: Date }
  | { readonly kind: 'until_before_from' }
  | { readonly kind: 'beyond_horizon' };

/**
 * Availability from the start of `fromDay` (or now, if that is today) to the end of `untilDay`,
 * within the catalog's horizon.
 */
export const availabilityWindow = (
  fromDay: string,
  untilDay: string,
  now: Date,
  horizonDays: number,
): AvailabilityCheck => {
  if (untilDay < fromDay) return { kind: 'until_before_from' };
  const start = startOfBogotaDay(fromDay);
  const from = start < now ? now : start;
  const until = endOfBogotaDay(untilDay);
  if (until.getTime() > now.getTime() + horizonDays * DAY_MS) return { kind: 'beyond_horizon' };
  return { kind: 'ok', from, until };
};

/** «viernes 28 de noviembre» for confirmations. */
export const formatDay = (day: string): string => {
  const names = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const months = [
    'enero',
    'febrero',
    'marzo',
    'abril',
    'mayo',
    'junio',
    'julio',
    'agosto',
    'septiembre',
    'octubre',
    'noviembre',
    'diciembre',
  ];
  const date = new Date(`${day}T00:00:00.000Z`);
  return `${names[date.getUTCDay()]} ${date.getUTCDate()} de ${months[date.getUTCMonth()]}`;
};
