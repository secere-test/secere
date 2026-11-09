/**
 * Language selection.
 *
 * The engine stays language-free: modules that need to say something hand back a
 * `Msg` (a key plus parameters), and only this module turns one into a sentence.
 * That is what lets the same duplicate report, chart note or export warning be
 * read in French without a French function hiding inside the scoring code.
 *
 * Counts go through `Intl.PluralRules`, because English's "1 person / 2 people"
 * rule is not universal: French treats 0 as singular, and Turkish does not
 * inflect the noun for a number at all.
 */

import type { GDate, Person } from '../types';
import { en, type MessageKey } from './en';
import { fr } from './fr';
import { de } from './de';
import { tr } from './tr';

export type { MessageKey };

export type Locale = 'en' | 'fr' | 'de' | 'tr';

export const LOCALES: readonly Locale[] = ['en', 'fr', 'de', 'tr'];

export const DEFAULT_LOCALE: Locale = 'en';

/** Endonyms: a language picker should never make you hunt for your own language. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  fr: 'Français',
  de: 'Deutsch',
  tr: 'Türkçe',
};

/**
 * Region matters for the output, not just the language: `en-GB` gives
 * "2 Feb 1935" where bare `en` gives "Feb 2, 1935".
 */
export const LOCALE_TAGS: Record<Locale, string> = {
  en: 'en-GB',
  fr: 'fr-FR',
  de: 'de-DE',
  tr: 'tr-TR',
};

const CATALOGS: Record<Locale, Record<MessageKey, string>> = { en, fr, de, tr };

export const LOCALE_STORAGE_KEY = 'secere.locale';

/** A translatable message handed out by the engine. */
export interface Msg {
  key: MessageKey;
  params?: Params;
  /**
   * The quantity this message is about. `message()` then picks the plural form
   * in the language it is *rendered* in, so a message built in English still
   * reads correctly after a switch to Turkish.
   */
  count?: number;
}

/**
 * A parameter can itself be a message. That is what lets "Exported “…”: 23
 * people, 8 families, facts only (13 media references) — 41 kB" stay one
 * sentence in four languages instead of being glued together from fragments
 * that each freeze the language at the moment they were built.
 */
export type Params = Record<string, string | number | Msg | Msg[]>;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Maps a BCP-47 tag from the browser or a saved value onto a locale we speak.
 * "de-AT" is German, "fr-CA" is French, "tr" is Turkish.
 */
export function matchLocale(tag: string | null | undefined): Locale | undefined {
  if (!tag) return undefined;
  const base = tag.toLowerCase().split(/[-_]/)[0];
  return isLocale(base) ? base : undefined;
}

const pluralRules = new Map<Locale, Intl.PluralRules>();

function pluralRule(locale: Locale): Intl.PluralRules {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(LOCALE_TAGS[locale]);
    pluralRules.set(locale, rules);
  }
  return rules;
}

const groupFormats = new Map<Locale, Intl.NumberFormat>();
const plainFormats = new Map<Locale, Intl.NumberFormat>();

function formatter(
  cache: Map<Locale, Intl.NumberFormat>,
  locale: Locale,
  group: boolean,
): Intl.NumberFormat {
  let format = cache.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(LOCALE_TAGS[locale], { useGrouping: group });
    cache.set(locale, format);
  }
  return format;
}

/**
 * A quantity, grouped the way the language groups thousands: "1.200 kişi".
 * Only counts use this; a year is a label, and "1 935" is not a year.
 */
export function formatNumber(locale: Locale, value: number): string {
  return formatter(groupFormats, locale, true).format(value);
}

/** A number inside a sentence: locale decimal separator, never grouped. */
export function formatPlainNumber(locale: Locale, value: number): string {
  return formatter(plainFormats, locale, false).format(value);
}

function lookup(locale: Locale, key: string): string | undefined {
  return CATALOGS[locale][key as MessageKey] ?? CATALOGS[DEFAULT_LOCALE][key as MessageKey];
}

/**
 * Replaces `{name}` with its parameter. Numbers are rendered with the locale's
 * decimal separator but *never* grouped: most numbers here are years, and a
 * grouped year would read as a quantity ("1 935"). Grouped counts come from
 * `count()` instead.
 */
export function interpolate(template: string, params: Params = {}, locale: Locale = DEFAULT_LOCALE): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    if (value === undefined) return whole;
    if (typeof value === 'number') return formatPlainNumber(locale, value);
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map((entry) => message(locale, entry)).join(', ');
    return message(locale, value);
  });
}

/** Renders a message (or a bare key) in one locale. */
export function message(locale: Locale, msg: Msg | MessageKey | string, params?: Params): string {
  const key = resolvePlural(locale, msg);
  const values: Params = {
    ...(typeof msg === 'string' ? undefined : msg.params),
    ...params,
  };
  if (typeof msg !== 'string' && msg.count !== undefined) {
    // Pre-formatted, so a grouped thousands count survives interpolation.
    values.count = formatNumber(locale, msg.count);
  }
  const template = lookup(locale, key) ?? key;
  return interpolate(template, values, locale);
}

/**
 * `count.facts` becomes `count.facts.one` or `count.facts.other` depending on
 * the language's own rule, falling back to the bare key when the catalogue has
 * no plural forms for it.
 */
function resolvePlural(locale: Locale, msg: Msg | MessageKey | string): string {
  const base = typeof msg === 'string' ? msg : msg.key;
  const amount = typeof msg === 'string' ? undefined : msg.count;
  if (amount === undefined) return base;
  const category = pluralRule(locale).select(amount);
  // Catalogues write the plain key as the "other" form (`count.people`) and add
  // `count.people.one` beside it, so the plain key is the last resort, not the
  // singular.
  for (const candidate of [`${base}.${category}`, `${base}.other`, base]) {
    if (lookup(locale, candidate as MessageKey) !== undefined) return candidate;
  }
  return base;
}

/**
 * Renders a count. `base` names the plural family, e.g. `count.people`, and the
 * catalogue supplies `count.people.one` / `count.people.other` (French also uses
 * `count.people.many`, but only for numbers in the millions).
 */
export function count(locale: Locale, base: string, value: number, params?: Params): string {
  return message(locale, { key: base as MessageKey, count: value, params });
}

/** A long-form date: "2 Feb 1935", "before 1852", "1903 – 1904". */
export function formatDate(date: GDate | undefined, locale: Locale): string {
  if (!date) return '';
  const pretty = (iso?: string): string => {
    if (!iso) return '';
    const [year, month, day] = iso.split('-');
    if (!year) return '';
    if (!month) return year;
    const options: Intl.DateTimeFormatOptions = day
      ? { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }
      : { month: 'short', year: 'numeric', timeZone: 'UTC' };
    const stamp = Date.UTC(Number(year), Number(month) - 1, day ? Number(day) : 1);
    return new Intl.DateTimeFormat(LOCALE_TAGS[locale], options).format(stamp);
  };

  switch (date.qualifier) {
    case 'between':
      return message(locale, 'date.between', { from: pretty(date.from), to: pretty(date.to) });
    case 'before':
      return message(locale, 'date.before', { date: pretty(date.to ?? date.from) });
    case 'after':
      return message(locale, 'date.after', { date: pretty(date.from ?? date.to) });
    case 'about':
      return message(locale, 'date.about', { date: pretty(date.from) });
    case 'estimated':
      return message(locale, 'date.estimated', { date: pretty(date.from) });
    case 'calculated':
      return message(locale, 'date.calculated', { date: pretty(date.from) });
    case 'exact':
      return pretty(date.from);
    default:
      return date.raw || '';
  }
}

/** "1905–1978", "b. 1935", "gest. 1978" — short enough for a chart box. */
export function formatLifespan(person: Person, locale: Locale): string {
  const born = person.events.find((e) => e.type === 'BIRT' || e.type === 'CHR');
  const died = person.events.find((e) => e.type === 'DEAT' || e.type === 'BURI');
  const bornYear = yearOf(born?.date?.from);
  const diedYear = yearOf(died?.date?.from);
  // Years are labels, not quantities: passing them as numbers would let the
  // number formatter write 1935 as "1,935" in English.
  if (bornYear && diedYear)
    return message(locale, 'life.span', { born: String(bornYear), died: String(diedYear) });
  if (bornYear) return message(locale, 'life.born', { year: String(bornYear) });
  if (diedYear) return message(locale, 'life.died', { year: String(diedYear) });
  return '';
}

function yearOf(value?: string): number | undefined {
  if (!value) return undefined;
  const match = /^(\d{3,4})/.exec(value);
  return match ? Number(match[1]) : undefined;
}

/**
 * The choice this device remembers, if any. `undefined` means "never chosen",
 * which is what lets a first visit follow the browser's language; storing the
 * default instead would silently refuse to follow it.
 */
export function savedLocale(storage?: Pick<Storage, 'getItem'> | null): Locale | undefined {
  try {
    const saved = storage?.getItem(LOCALE_STORAGE_KEY) ?? undefined;
    return isLocale(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
}

/** The saved choice, or English. Never throws: storage can be denied. */
export function loadLocale(storage?: Pick<Storage, 'getItem'> | null): Locale {
  return savedLocale(storage) ?? DEFAULT_LOCALE;
}

export function saveLocale(locale: Locale, storage?: Pick<Storage, 'setItem'> | null): void {
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Private mode with storage disabled: the choice holds for this session.
  }
}
