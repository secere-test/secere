/**
 * Duplicate detection and record merging.
 *
 * Importing a cousin's file brings the same ancestors back under fresh ids, so
 * id matching alone leaves the tree with two of everybody. This module scores
 * *pairs* on the evidence a genealogist would actually check — names, birth and
 * death years, sex, shared parents, birth place — and then merges two records
 * into one without leaving a dangling link behind.
 *
 * Both halves are pure. The UI decides what to show, and which record wins.
 */

import { buildIndex } from './subset';
import type { Msg } from './i18n';
import type { Event, GDate, ID, Person, TreeData, Union } from './types';
import { birthYear, deathYear, eventOf, yearOf } from './types';

export interface DuplicateCandidate {
  a: Person;
  b: Person;
  /** 0..1. Never presented as a probability, only as ordering evidence. */
  score: number;
  /** Why this pair scored: keys, so the list reads in the user's language. */
  reasons: Msg[];
}

export interface DuplicateOptions {
  /** Below this, a pair is not worth the reader's attention. */
  minScore?: number;
  limit?: number;
}

/** Lowercase, unaccented, punctuation-free — "Ní Bhriain" and "Ni Bhriain" match. */
export function normaliseName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Levenshtein distance, two rows deep. Names are short, so this is plenty. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, previous[j] + 1, current[j - 1] + 1);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * How much two name parts look alike, 0..1. A couple of typos still counts;
 * a genuinely different name does not, so "Keane"/"Kean" scores but
 * "Keane"/"Brennan" is zero, and the score never rewards long names for length.
 */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const longest = Math.max(a.length, b.length);
  const allowed = longest <= 4 ? 1 : longest <= 8 ? 2 : Math.floor(longest / 3);
  const distance = editDistance(a, b);
  if (distance > allowed) return 0;
  return 1 - distance / longest;
}

interface NameMatch {
  score: number;
  exact: boolean;
}

/**
 * Best match across every name on both records, so a married name on one side
 * and a birth name on the other still lines up.
 */
function matchNames(a: Person, b: Person): NameMatch {
  let best: NameMatch = { score: 0, exact: false };

  for (const na of a.names) {
    const surnameA = normaliseName(na.surname);
    const givenA = normaliseName(na.given);

    for (const nb of b.names) {
      const surnameB = normaliseName(nb.surname);
      const givenB = normaliseName(nb.given);
      const surname = similarity(surnameA, surnameB);
      const given = similarity(givenA, givenB);

      // Given name matters as much as surname: two Keanes are not duplicates,
      // and neither are two Michaels.
      const score = surname > 0 && given > 0 ? 0.55 * surname + 0.45 * given : 0.5 * Math.max(surname, given);
      const exact = surnameA === surnameB && givenA === givenB && Boolean(givenA || surnameA);

      if (score > best.score || (exact && !best.exact)) best = { score, exact };
    }
  }

  return best;
}

/** True when the two people appear as partners of the same family. */
function partnersTogether(tree: TreeData, aId: ID, bId: ID): boolean {
  return tree.unions.some((u) => u.partnerIds.includes(aId) && u.partnerIds.includes(bId));
}

/** True when either person is a parent of the other. */
function parentAndChild(tree: TreeData, aId: ID, bId: ID): boolean {
  return tree.unions.some(
    (u) =>
      (u.partnerIds.includes(aId) && u.childIds.includes(bId)) ||
      (u.partnerIds.includes(bId) && u.childIds.includes(aId)),
  );
}

/**
 * Scores one pair. The weights are a reading of the evidence, not a science:
 * a shared exact name plus a shared birth year is strong, a name that differs by
 * a letter needs the dates to agree, and two birth years a generation apart
 * settles it the other way no matter how alike the names are.
 */
export function scorePair(a: Person, b: Person, sameParents: boolean): DuplicateCandidate {
  const names = matchNames(a, b);
  const reasons: Msg[] = [];
  let score = names.score * 0.62;

  if (names.exact) reasons.push({ key: 'dup.identicalName' });
  else if (names.score >= 0.6) reasons.push({ key: 'dup.spelling' });

  const birthA = birthYear(a);
  const birthB = birthYear(b);
  if (birthA && birthB) {
    const gap = Math.abs(birthA - birthB);
    if (gap === 0) {
      score += 0.24;
      reasons.push({ key: 'dup.sameBirthYear', params: { year: birthA } });
    } else if (gap <= 5) {
      score += gap <= 2 ? 0.14 : 0.02;
      reasons.push({ key: 'dup.birthYears', params: { a: birthA, b: birthB } });
    } else {
      score -= 0.45;
      reasons.push({ key: 'dup.birthYearsGap', params: { a: birthA, b: birthB, gap } });
    }
  } else {
    // No dates on one side is missing evidence, not contrary evidence.
    score += 0.06;
  }

  const deathA = deathYear(a);
  const deathB = deathYear(b);
  if (deathA && deathB) {
    const gap = Math.abs(deathA - deathB);
    if (gap === 0) {
      score += 0.06;
      reasons.push({ key: 'dup.sameDeathYear', params: { year: deathA } });
    } else if (gap <= 2) {
      score += 0.03;
    } else {
      score -= 0.12;
      reasons.push({ key: 'dup.deathYears', params: { a: deathA, b: deathB } });
    }
  }

  if (a.sex !== 'U' && b.sex !== 'U') {
    if (a.sex === b.sex) score += 0.05;
    else {
      score -= 0.5;
      reasons.push({ key: 'dup.differentSex' });
    }
  }

  if (sameParents) {
    score += 0.1;
    reasons.push({ key: 'dup.sameParents' });
  }

  const placeA = normaliseName(eventOf(a, 'BIRT')?.place ?? '');
  const placeB = normaliseName(eventOf(b, 'BIRT')?.place ?? '');
  if (placeA && placeB && (placeA.includes(placeB) || placeB.includes(placeA))) {
    score += 0.05;
    reasons.push({ key: 'dup.sameBirthPlace' });
  }

  return { a, b, score: Math.max(0, Math.min(1, score)), reasons };
}

/**
 * Candidate duplicate pairs, strongest first.
 *
 * Two people who are already known to be related — partners, or parent and
 * child — are skipped: the tree already says they are different people, and
 * offering to merge them would be worse than missing a duplicate.
 */
export function findDuplicatePairs(tree: TreeData, options: DuplicateOptions = {}): DuplicateCandidate[] {
  const { minScore = 0.65, limit = 25 } = options;
  const index = buildIndex(tree);
  const persons = tree.persons.filter((p) => !p.isStub && !p.redacted);
  const pairs: DuplicateCandidate[] = [];

  for (let i = 0; i < persons.length; i++) {
    for (let j = i + 1; j < persons.length; j++) {
      const a = persons[i];
      const b = persons[j];

      const birthA = birthYear(a);
      const birthB = birthYear(b);
      // Cheap rejection before the string work: two birth years a decade apart
      // cannot be one person.
      if (birthA && birthB && Math.abs(birthA - birthB) > 8) continue;
      if (partnersTogether(tree, a.id, b.id) || parentAndChild(tree, a.id, b.id)) continue;

      const parentsA = new Set((index.unionsByChild.get(a.id) ?? []).flatMap((id) => index.unionById.get(id)?.partnerIds ?? []));
      const parentsB = (index.unionsByChild.get(b.id) ?? []).flatMap((id) => index.unionById.get(id)?.partnerIds ?? []);
      const sameParents = parentsA.size > 0 && parentsB.some((id) => parentsA.has(id));

      const candidate = scorePair(a, b, sameParents);
      if (candidate.score >= minScore) pairs.push(candidate);
    }
  }

  return pairs.sort((x, y) => y.score - x.score).slice(0, limit);
}

export interface MergeSummary {
  tree: TreeData;
  movedEvents: number;
  movedNotes: number;
  movedMedia: number;
  movedChildren: number;
  collapsedUnions: number;
  /** Same event, different dates. Both are kept; this says how often it happened. */
  conflicts: Msg[];
}

/** The years a date can mean, as an inclusive range. */
function yearSpan(date?: GDate): [number, number] | null {
  if (!date) return null;
  const from = yearOf(date.from) ?? yearOf(date.to) ?? yearOf(date.raw);
  const to = yearOf(date.to) ?? yearOf(date.from) ?? yearOf(date.raw);
  return from && to ? [Math.min(from, to), Math.max(from, to)] : null;
}

/**
 * Two dates are the same fact when their possible years overlap. "2 FEB 1935"
 * and "1935" agree; "1935" and "1936" do not. Comparing the raw strings would
 * call the first pair a conflict and lose the better date, which is exactly
 * backwards.
 */
function datesAgree(a?: GDate, b?: GDate): boolean {
  if (!a || !b) return true;
  const spanA = yearSpan(a);
  const spanB = yearSpan(b);
  if (!spanA || !spanB) return true;
  return Math.max(spanA[0], spanB[0]) <= Math.min(spanA[1], spanB[1]);
}

/** Longer normalised date = more specific. "1935-02-02" beats "1935". */
function datePrecision(date?: GDate): number {
  return date ? (date.from ?? '').length + (date.to ?? '').length : 0;
}

/**
 * Whether two events are the same fact.
 *
 * Two undated facts of the same type are only the same fact when they say the
 * same thing: a person can hold two occupations, and dropping the second one
 * because it also has no date would quietly lose a fact.
 */
function sameFact(a: Event, b: Event): boolean {
  if (a.type !== b.type) return false;
  // "Occupation: Creamery manager" and "Occupation: Schoolteacher" are two
  // facts, even with no dates between them. An *untitled* event is not a
  // different fact, though: it is the same fact with less written down, and the
  // text below fills it in.
  if (a.value && b.value && a.value !== b.value) return false;
  if (!a.date && !b.date) {
    return (
      (a.label ?? '') === (b.label ?? '') &&
      (a.place ?? '') === (b.place ?? '') &&
      (a.address ?? '') === (b.address ?? '') &&
      (a.note ?? '') === (b.note ?? '')
    );
  }
  return datesAgree(a.date, b.date);
}

function eventLabel(person: Person, type: string): string {
  return person.events.find((e) => e.type === type)?.label ?? type;
}

/**
 * Folds `dropId` into `keepId`.
 *
 * Nothing is discarded silently: names become alternate names, facts that the
 * keeper lacks are copied, two dates for one event are both kept (the incoming
 * one marked disputed), and every union, child link and media reference that
 * pointed at the dropped record now points at the keeper. The dropped record is
 * then removed, which is safe precisely because those links were rewritten first.
 */
export function mergePersons(tree: TreeData, keepId: ID, dropId: ID): MergeSummary {
  if (keepId === dropId) throw new Error('A record cannot be merged with itself');

  const keep = tree.persons.find((p) => p.id === keepId);
  const drop = tree.persons.find((p) => p.id === dropId);
  if (!keep || !drop) throw new Error('Both records must exist before they can be merged');

  const conflicts: Msg[] = [];

  const names = [...keep.names];
  for (const name of drop.names) {
    const duplicate = names.some(
      (n) => normaliseName(n.given) === normaliseName(name.given) && normaliseName(n.surname) === normaliseName(name.surname),
    );
    if (!duplicate) names.push({ ...name, type: name.type === 'birth' ? 'aka' : name.type });
  }

  let movedEvents = 0;
  // Cloned, because the enrichment below writes into these objects and the
  // caller's tree must not be mutated behind React's back.
  const events: Event[] = keep.events.map((event) => ({ ...event, citations: [...(event.citations ?? [])] }));
  for (const event of drop.events) {
    const identical = events.find((e) => sameFact(e, event));
    if (identical) {
      // Same fact twice: keep one, but take any detail the keeper is missing —
      // including the more precise version of the date.
      let enriched = false;
      if (datePrecision(event.date) > datePrecision(identical.date)) {
        identical.date = event.date;
        enriched = true;
      }
      if (!identical.value && event.value) {
        identical.value = event.value;
        enriched = true;
      }
      if (!identical.place && event.place) {
        identical.place = event.place;
        enriched = true;
      }
      if (!identical.address && event.address) {
        identical.address = event.address;
        enriched = true;
      }
      if (!identical.note && event.note) {
        identical.note = event.note;
        enriched = true;
      }
      if (!identical.citations?.length && event.citations?.length) {
        identical.citations = [...event.citations];
        enriched = true;
      }
      if (enriched) movedEvents++;
      continue;
    }
    const other = events.find((e) => e.type === event.type);
    // Only a pair of dated facts can genuinely disagree; an extra undated
    // occupation is new information, not a contradiction.
    if (other?.date && event.date) {
      events.push({ ...event, certainty: 'disputed' });
      conflicts.push({
        key: 'conflict.event',
        params: {
          label: eventLabel(keep, event.type),
          a: other.date.raw,
          b: event.date.raw,
        },
      });
    } else {
      events.push(event);
    }
    movedEvents++;
  }

  let movedNotes = 0;
  const notes = [...keep.notes];
  for (const note of drop.notes) {
    if (notes.some((n) => n.id === note.id || n.body === note.body)) continue;
    notes.push(note);
    movedNotes++;
  }

  const citationKey = (c: { sourceId?: string; page?: string; text?: string }) =>
    `${c.sourceId ?? ''}|${c.page ?? ''}|${c.text ?? ''}`;
  const citations = [...keep.citations];
  for (const citation of drop.citations) {
    if (citations.some((c) => c.id === citation.id || citationKey(c) === citationKey(citation))) continue;
    citations.push(citation);
  }

  let movedMedia = 0;
  const mediaIds = [...keep.mediaIds];
  for (const mediaId of drop.mediaIds) {
    if (mediaIds.includes(mediaId)) continue;
    mediaIds.push(mediaId);
    movedMedia++;
  }

  const tags = [...new Set([...keep.tags, ...drop.tags])];
  const custom = { ...drop.custom, ...keep.custom };
  const merged: Person = {
    ...drop,
    ...keep,
    names,
    events,
    notes,
    citations,
    mediaIds,
    tags,
    custom,
  };

  // Rewrite every reference to the dropped person before removing it.
  const unions: Union[] = tree.unions.map((union) =>
    union.partnerIds.includes(dropId)
      ? { ...union, partnerIds: [...new Set(union.partnerIds.map((id) => (id === dropId ? keepId : id)))] }
      : union,
  );

  // Two families with the same partners are one family. Collapsing them is what
  // stops a merge from producing "Michael & Alice" twice, each with half the
  // children. Unions with no known partners are left alone: they are distinct
  // groups of siblings, not duplicates of each other.
  const byPartners = new Map<string, Union>();
  const collapsed: Union[] = [];
  let movedChildren = 0;
  let collapsedUnions = 0;

  for (const union of unions) {
    const key = union.partnerIds.length ? [...union.partnerIds].sort().join('|') : `\u0000${union.id}`;
    const existing = byPartners.get(key);
    if (!existing) {
      byPartners.set(key, union);
      collapsed.push(union);
      continue;
    }

    collapsedUnions++;
    for (const childId of union.childIds) {
      if (existing.childIds.includes(childId)) continue;
      existing.childIds.push(childId);
      movedChildren++;
    }
    existing.childLinks = { ...(union.childLinks ?? {}), ...(existing.childLinks ?? {}) };
    for (const event of union.events) {
      if (!existing.events.some((e) => e.type === event.type && datesAgree(e.date, event.date))) {
        existing.events.push(event);
      }
    }
    for (const note of union.notes) if (!existing.notes.some((n) => n.body === note.body)) existing.notes.push(note);
    for (const mediaId of union.mediaIds) if (!existing.mediaIds.includes(mediaId)) existing.mediaIds.push(mediaId);
  }

  const persons = tree.persons.filter((p) => p.id !== dropId).map((p) => (p.id === keepId ? merged : p));

  return {
    tree: {
      ...tree,
      persons,
      unions: collapsed,
      meta: { ...tree.meta, updatedAt: new Date().toISOString() },
    },
    movedEvents,
    movedNotes,
    movedMedia,
    movedChildren,
    collapsedUnions,
    conflicts,
  };
}
