import { describe, expect, it } from 'vitest';
import { en } from './en';
import { de } from './de';
import { fr } from './fr';
import { tr } from './tr';
import {
  count,
  DEFAULT_LOCALE,
  formatDate,
  formatLifespan,
  interpolate,
  isLocale,
  loadLocale,
  LOCALES,
  LOCALE_NAMES,
  LOCALE_TAGS,
  matchLocale,
  message,
  savedLocale,
  saveLocale,
  type Locale,
} from '.';
import type { Person } from '../types';

const CATALOGS: Record<Locale, Record<string, string>> = { en, fr, de, tr };

function person(events: Person['events']): Person {
  return {
    id: 'I1',
    names: [{ id: 'n1', given: 'Michael', surname: 'Keane', type: 'birth' }],
    sex: 'M',
    events,
    notes: [],
    mediaIds: [],
    citations: [],
    tags: [],
    custom: {},
    privacy: 'public',
  };
}

const born1835 = person([
  { id: 'e1', type: 'BIRT', date: { raw: '1935', qualifier: 'exact', from: '1935', to: '1935' }, certainty: 'certain' },
  { id: 'e2', type: 'DEAT', date: { raw: '1978', qualifier: 'exact', from: '1978', to: '1978' }, certainty: 'certain' },
]);

describe('catalogues', () => {
  it('has the same keys everywhere, with no blanks', () => {
    const englishKeys = Object.keys(en).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(CATALOGS[locale]).sort(), locale).toEqual(englishKeys);
      const empty = Object.entries(CATALOGS[locale])
        .filter(([, value]) => !value.trim())
        .map(([key]) => key);
      expect(empty, `${locale} has empty strings`).toEqual([]);
    }
  });

  it('keeps every placeholder in every translation', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en)) {
      const expected = placeholders(en[key as keyof typeof en]);
      for (const locale of LOCALES) {
        expect(placeholders(CATALOGS[locale][key]), `${locale}:${key}`).toEqual(expected);
      }
    }
  });

  it('never leaves a translation identical to English by accident of copy-paste', () => {
    // Genuinely identical strings exist (100 %, GEDCOM, "Parents", "possible"),
    // so this only guards the long sentences, where an untranslated value would
    // mean the catalogue was never finished.
    const long = Object.entries(en).filter(([key, value]) => value.length > 60 && !key.includes('event.'));
    const untranslated = LOCALES.filter((locale) => locale !== 'en').flatMap((locale) =>
      long.filter(([key]) => CATALOGS[locale][key] === en[key as keyof typeof en]).map(([key]) => `${locale}:${key}`),
    );
    expect(untranslated).toEqual([]);
  });

  it('names every language in that language', () => {
    expect(LOCALE_NAMES).toEqual({ en: 'English', fr: 'Français', de: 'Deutsch', tr: 'Türkçe' });
  });
});

describe('messages', () => {
  it('fills parameters and formats numbers for the language', () => {
    expect(interpolate('born {year} in {place}', { year: '1935', place: 'Kerry' }, 'en')).toBe('born 1935 in Kerry');
    // A year is a label: it must never come out as "1,935".
    expect(interpolate('{year}', { year: 1935 }, 'en')).toBe('1935');
    // A count is a quantity, and count() groups it the way the language does.
    expect(count('en', 'count.people', 1200)).toBe('1,200 people');
    expect(count('tr', 'count.people', 1200)).toBe('1.200 kişi');
  });

  it('leaves an unknown placeholder alone rather than printing undefined', () => {
    expect(message('en', 'notice.saveFailed', {})).toBe('Save failed: {message}');
  });

  it('falls back to English when a key is missing', () => {
    expect(message('fr', 'not.a.key')).toBe('not.a.key');
  });

  it('accepts a bare key as well as a message object', () => {
    expect(message('de', 'view.record')).toBe('Eintrag');
    expect(message('en', { key: 'view.record' })).toBe('Record');
  });
});

describe('counts', () => {
  it('uses English plural forms', () => {
    expect(count('en', 'count.people', 1)).toBe('1 person');
    expect(count('en', 'count.people', 2)).toBe('2 people');
  });

  it('treats zero as singular in French, as CLDR does', () => {
    expect(count('fr', 'count.people', 0)).toBe('0 personne');
    expect(count('fr', 'count.people', 1)).toBe('1 personne');
    expect(count('fr', 'count.people', 3)).toBe('3 personnes');
  });

  it('declines German nouns', () => {
    expect(count('de', 'count.children', 1)).toBe('1 Kind');
    expect(count('de', 'count.children', 4)).toBe('4 Kinder');
  });

  it('does not inflect Turkish nouns for a number', () => {
    expect(count('tr', 'count.children', 1)).toBe('1 çocuk');
    expect(count('tr', 'count.children', 7)).toBe('7 çocuk');
  });
});

describe('dates', () => {
  it('writes a full date with month names from the language', () => {
    const date = { raw: '2 FEB 1935', qualifier: 'exact' as const, from: '1935-02-02', to: '1935-02-02' };
    expect(formatDate(date, 'en')).toBe('2 Feb 1935');
    expect(formatDate(date, 'fr')).toBe('2 févr. 1935');
    expect(formatDate(date, 'de')).toBe('2. Feb. 1935');
    expect(formatDate(date, 'tr')).toBe('2 Şub 1935');
  });

  it('translates the qualifiers', () => {
    const about = { raw: 'ABT 1852', qualifier: 'about' as const, from: '1852', to: '1852' };
    expect(formatDate(about, 'en')).toBe('about 1852');
    expect(formatDate(about, 'fr')).toBe('vers 1852');
    expect(formatDate(about, 'de')).toBe('um 1852');
    expect(formatDate(about, 'tr')).toBe('yaklaşık 1852');

    const between = { raw: 'BET 1903 AND 1904', qualifier: 'between' as const, from: '1903', to: '1904' };
    expect(formatDate(between, 'en')).toBe('1903 – 1904');
  });

  it('falls back to the author’s own phrase when it cannot be parsed', () => {
    expect(formatDate({ raw: 'spring 1900', qualifier: 'unknown' }, 'fr')).toBe('spring 1900');
    expect(formatDate(undefined, 'de')).toBe('');
  });

  it('abbreviates a lifespan the way each language does', () => {
    expect(formatLifespan(born1835, 'en')).toBe('1935–1978');
    expect(formatLifespan(person([born1835.events[0]]), 'de')).toBe('geb. 1935');
    expect(formatLifespan(person([born1835.events[1]]), 'tr')).toBe('ö. 1978');
    expect(formatLifespan(person([]), 'fr')).toBe('');
  });
});

describe('choosing a language', () => {
  it('maps a browser tag onto a language we speak', () => {
    expect(matchLocale('de-AT')).toBe('de');
    expect(matchLocale('fr-CA')).toBe('fr');
    expect(matchLocale('tr')).toBe('tr');
    expect(matchLocale('en_US')).toBe('en');
    expect(matchLocale('es-ES')).toBeUndefined();
    expect(matchLocale('')).toBeUndefined();
    expect(matchLocale(null)).toBeUndefined();
  });

  it('validates rather than trusting a stored string', () => {
    expect(isLocale('tr')).toBe(true);
    expect(isLocale('TR')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it('remembers the choice, and treats "never chosen" as different from English', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };

    expect(savedLocale(storage)).toBeUndefined();
    expect(loadLocale(storage)).toBe(DEFAULT_LOCALE);

    saveLocale('tr', storage);
    expect(savedLocale(storage)).toBe('tr');
    expect(loadLocale(storage)).toBe('tr');

    store.set('secere.locale', 'klingon');
    expect(savedLocale(storage)).toBeUndefined();
  });

  it('survives storage that throws, which is what private mode does', () => {
    const angry = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(savedLocale(angry)).toBeUndefined();
    expect(loadLocale(angry)).toBe(DEFAULT_LOCALE);
    expect(() => saveLocale('de', angry)).not.toThrow();
  });

  it('has a region tag for each language, so dates read naturally', () => {
    expect(LOCALE_TAGS).toEqual({ en: 'en-GB', fr: 'fr-FR', de: 'de-DE', tr: 'tr-TR' });
    expect(new Set(LOCALES).size).toBe(4);
  });
});
