import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  count,
  DEFAULT_LOCALE,
  formatDate,
  formatLifespan,
  LOCALE_NAMES,
  LOCALE_TAGS,
  LOCALES,
  matchLocale,
  message,
  saveLocale,
  savedLocale,
  type Locale,
  type Params,
  type Msg,
} from '../core/i18n';
import { certaintyLabel, eventLabel, pedigreeLabel } from '../core/labels';
import type { GDate, Person } from '../core/types';

export { LOCALE_NAMES, LOCALES, type Locale };

export interface I18n {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /** A message in the current language. */
  t: (msg: Msg | string, params?: Params) => string;
  /** A count, with this language's plural rule. */
  n: (base: string, value: number, params?: Params) => string;
  /** A date with translated qualifiers and this language's month names. */
  date: (date?: GDate) => string;
  /** "1905–1978", "b. 1935" in the current language. */
  life: (person: Person) => string;
  /** A GEDCOM event name, e.g. Naissance for BIRT in French. */
  eventName: (type: string, fallback?: string) => string;
  /** How a child came into a family: birth, adopted, step, ... */
  pedigree: (value: string) => string;
  /** How sure a fact is; an empty string for the default "certain". */
  certainty: (value: string) => string;
}

const I18nContext = createContext<I18n | null>(null);

/** Storage access can itself throw when cookies are blocked, not just reads. */
function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * First visit: follow the browser. After that: whatever the reader picked, even
 * if it differs from the browser — the choice is theirs, not the OS's.
 */
function initialLocale(): Locale {
  const saved = savedLocale(storage());
  if (saved) return saved;
  const languages = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language];
  for (const tag of languages) {
    const matched = matchLocale(tag);
    if (matched) return matched;
  }
  return DEFAULT_LOCALE;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    // Screen readers and hyphenation follow this, so it has to move with the
    // switch rather than being fixed at build time.
    document.documentElement.lang = LOCALE_TAGS[locale];
    document.documentElement.dataset.locale = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    saveLocale(next, storage());
  }, []);

  const value = useMemo<I18n>(
    () => ({
      locale,
      setLocale,
      t: (msg, params) => message(locale, msg, params),
      n: (base, amount, params) => count(locale, base, amount, params),
      date: (date) => formatDate(date, locale),
      life: (person) => formatLifespan(person, locale),
      eventName: (type, fallback) => eventLabel(type, locale, fallback),
      pedigree: (value) => pedigreeLabel(value, locale),
      certainty: (value) => certaintyLabel(value, locale) ?? '',
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n used outside I18nProvider');
  return value;
}
