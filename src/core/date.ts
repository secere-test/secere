import type { DateQualifier, GDate } from './types';

const MONTHS = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];

const MONTH_INDEX = new Map(MONTHS.map((m, i) => [m, i + 1]));

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function iso(year: number, month?: number, day?: number): string {
  if (month === undefined) return String(year).padStart(4, '0');
  if (day === undefined) return `${String(year).padStart(4, '0')}-${pad(month)}`;
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

/** Parse a single GEDCOM date expression like "3 APR 1880" or "APR 1880". */
function parsePoint(text: string): string | undefined {
  const t = text.trim().toUpperCase().replace(/\s+/g, ' ');
  let m = /^(\d{1,2}) ([A-Z]{3}) (\d{3,4})$/.exec(t);
  if (m) {
    const month = MONTH_INDEX.get(m[2]);
    if (!month) return undefined;
    return iso(Number(m[3]), month, Number(m[1]));
  }
  m = /^([A-Z]{3}) (\d{3,4})$/.exec(t);
  if (m) {
    const month = MONTH_INDEX.get(m[1]);
    if (!month) return undefined;
    return iso(Number(m[2]), month);
  }
  m = /^(\d{3,4})$/.exec(t);
  if (m) return iso(Number(m[1]));
  // Free text such as "spring 1900" or a calendar prefix we do not model yet.
  m = /(\d{3,4})/.exec(t);
  if (m) return iso(Number(m[1]));
  return undefined;
}

/**
 * Parse GEDCOM date phrases into the (raw, qualifier, range) triple.
 * The raw string is preserved verbatim so exports stay faithful.
 */
export function parseGedcomDate(raw: string): GDate {
  const rawTrim = raw.trim();
  if (!rawTrim) return { raw, qualifier: 'unknown' };

  const upper = rawTrim.toUpperCase();

  const bet = /^BET(?:WEEN)?\.? (.+) AND (.+)$/.exec(upper);
  if (bet) {
    const from = parsePoint(bet[1]);
    const to = parsePoint(bet[2]);
    return { raw: rawTrim, qualifier: 'between', from: from ?? to, to: to ?? from };
  }

  if (/^FROM (.+) TO (.+)$/.test(upper)) {
    const m = /^FROM (.+) TO (.+)$/.exec(upper)!;
    const from = parsePoint(m[1]);
    const to = parsePoint(m[2]);
    return { raw: rawTrim, qualifier: 'between', from, to };
  }

  const prefixes: Array<[RegExp, DateQualifier]> = [
    [/^(?:ABT|ABOUT|CIRCA|CA)\.? /, 'about'],
    [/^EST\.? /, 'estimated'],
    [/^CAL\.? /, 'calculated'],
    [/^BEF\.? /, 'before'],
    [/^AFT\.? /, 'after'],
    [/^INT\.? /, 'unknown'],
  ];

  for (const [re, qualifier] of prefixes) {
    const m = re.exec(upper);
    if (m) {
      const rest = upper.slice(m[0].length);
      const point = parsePoint(rest);
      if (qualifier === 'before') return { raw: rawTrim, qualifier, to: point };
      if (qualifier === 'after') return { raw: rawTrim, qualifier, from: point };
      return { raw: rawTrim, qualifier, from: point, to: point };
    }
  }

  const point = parsePoint(upper);
  if (point) return { raw: rawTrim, qualifier: 'exact', from: point, to: point };
  return { raw: rawTrim, qualifier: 'unknown' };
}

/** Render a GDate back to a GEDCOM 5.5.1 date string. */
export function formatGedcomDate(date: GDate): string {
  // Prefer the author's original phrasing when we have it; it carries nuance
  // (calendars, "before the war") that a normalized range would flatten.
  if (date.raw && date.raw.trim()) return date.raw.trim();

  const toPoint = (value?: string): string => {
    if (!value) return '';
    const [y, m, d] = value.split('-');
    if (m && d) return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
    if (m) return `${MONTHS[Number(m) - 1]} ${y}`;
    return y;
  };

  switch (date.qualifier) {
    case 'between':
      if (date.from && date.to) return `BET ${toPoint(date.from)} AND ${toPoint(date.to)}`;
      return toPoint(date.from ?? date.to);
    case 'before':
      return `BEF ${toPoint(date.to ?? date.from)}`.trim();
    case 'after':
      return `AFT ${toPoint(date.from ?? date.to)}`.trim();
    case 'about':
      return `ABT ${toPoint(date.from)}`.trim();
    case 'estimated':
      return `EST ${toPoint(date.from)}`.trim();
    case 'calculated':
      return `CAL ${toPoint(date.from)}`.trim();
    case 'exact':
      return toPoint(date.from);
    default:
      return '';
  }
}

/** Human display, e.g. "about 1852", "3 Apr 1880 – 12 Jun 1881". */
export function formatDateDisplay(date?: GDate): string {
  if (!date) return '';
  const pretty = (value?: string): string => {
    if (!value) return '';
    const [y, m, d] = value.split('-');
    if (m && d) return `${Number(d)} ${MONTHS[Number(m) - 1][0]}${MONTHS[Number(m) - 1].slice(1, 3).toLowerCase()} ${y}`;
    if (m) return `${MONTHS[Number(m) - 1][0]}${MONTHS[Number(m) - 1].slice(1, 3).toLowerCase()} ${y}`;
    return y;
  };
  switch (date.qualifier) {
    case 'between':
      return `${pretty(date.from)} – ${pretty(date.to)}`;
    case 'before':
      return `before ${pretty(date.to ?? date.from)}`;
    case 'after':
      return `after ${pretty(date.from ?? date.to)}`;
    case 'about':
      return `about ${pretty(date.from)}`;
    case 'estimated':
      return `est. ${pretty(date.from)}`;
    case 'calculated':
      return `calc. ${pretty(date.from)}`;
    case 'exact':
      return pretty(date.from);
    default:
      return date.raw || '';
  }
}

/** Does a date range overlap the [fromYear, toYear] window (inclusive)? */
export function overlapsYears(date: GDate | undefined, fromYear?: number, toYear?: number): boolean {
  if (!date) return fromYear === undefined && toYear === undefined;
  const lo = yearOfIso(date.from) ?? yearOfIso(date.to);
  const hi = yearOfIso(date.to) ?? yearOfIso(date.from);
  if (lo === undefined || hi === undefined) return fromYear === undefined && toYear === undefined;
  if (fromYear !== undefined && hi < fromYear) return false;
  if (toYear !== undefined && lo > toYear) return false;
  return true;
}

function yearOfIso(value?: string): number | undefined {
  if (!value) return undefined;
  const m = /^(\d{3,4})/.exec(value);
  return m ? Number(m[1]) : undefined;
}
