import { message, type Locale, type MessageKey } from './i18n';

/**
 * Event names come from the catalogue, not from a table here, so a French chart
 * and a Turkish timeline say "Naissance" and "Doğum" for the same BIRT. An
 * unknown tag (a custom `_SHIP` from another tool) falls through to the tag
 * itself, which is the only honest label for it.
 */
export function eventLabel(type: string, locale: Locale = 'en', fallback?: string): string {
  if (fallback) return fallback;
  const key = `event.${type}`;
  return message(locale, isEventKey(key) ? key : type);
}

function isEventKey(key: string): key is MessageKey {
  return key.startsWith('event.') && message('en', key) !== key;
}

export function certaintyLabel(certainty: string, locale: Locale = 'en'): string | undefined {
  if (certainty === 'certain') return undefined;
  const key = `certainty.${certainty}`;
  return message(locale, isCertaintyKey(key) ? key : certainty);
}

function isCertaintyKey(key: string): key is MessageKey {
  return key.startsWith('certainty.') && message('en', key) !== key;
}

export function pedigreeLabel(pedigree: string, locale: Locale = 'en'): string {
  const key = `pedigree.${pedigree}`;
  return message(locale, isPedigreeKey(key) ? key : pedigree);
}

function isPedigreeKey(key: string): key is MessageKey {
  return key.startsWith('pedigree.') && message('en', key) !== key;
}
