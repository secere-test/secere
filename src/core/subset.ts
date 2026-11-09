/**
 * The slice engine.
 *
 * Three concerns, deliberately kept separate:
 *
 *   1. SELECT  - which people the user asked for (traversal depths, manual
 *                picks, attribute filters).
 *   2. CLOSE   - make the result a valid graph, not just a bag of people:
 *                what happens at the boundary (prune / stub / include).
 *   3. REDACT  - strip what must not leave the device (living people, private
 *                notes, private citations).
 *
 * Serialization is a separate file (bundle.ts). Keeping select/close/redact
 * pure and testable is what makes "export exactly this range" trustworthy
 * rather than best-effort.
 */

import { overlapsYears } from './date';
import { message, type Msg } from './i18n';
import {
  birthYear,
  deathYear,
  isLiving,
  type ID,
  type MediaRef,
  type Person,
  type Privacy,
  type Sex,
  type TreeData,
  type Union,
} from './types';

export type BoundaryPolicy = 'prune' | 'stub' | 'include';
export type MediaMode = 'none' | 'thumbs' | 'full';
export type LivingFilter = 'any' | 'living' | 'deceased';

export interface SubsetFilters {
  /** Case-insensitive substring match on given or surname. */
  nameIncludes?: string;
  surname?: string;
  sex?: Sex[];
  /** Year window applied to birth (and optionally death) events. */
  bornFrom?: number;
  bornTo?: number;
  diedFrom?: number;
  diedTo?: number;
  living?: LivingFilter;
  /** Substring match against any event place. */
  placeIncludes?: string;
  tags?: string[];
  hasMedia?: boolean;
  /** Exclude records whose privacy is not in this list. */
  allowPrivacy?: Privacy[];
}

export interface SubsetCriteria {
  /** Walk out from these people. Empty means "filter the whole tree". */
  roots: ID[];
  ancestors: number;
  descendants: number;
  includeSpouses: boolean;
  /** Extra steps sideways through siblings/cousins. */
  collateral: number;
  filters: SubsetFilters;
  /** Explicitly picked people, added on top of the traversal. */
  manualIds: ID[];
  boundary: BoundaryPolicy;
  redactLiving: boolean;
  stripPrivate: boolean;
  media: MediaMode;
}

export function defaultCriteria(roots: ID[] = []): SubsetCriteria {
  return {
    roots,
    ancestors: 3,
    descendants: 3,
    includeSpouses: true,
    collateral: 0,
    filters: {},
    manualIds: [],
    // Complete nuclear families by default: half-empty marriages confuse
    // recipients far more than one extra person does.
    boundary: 'include',
    redactLiving: true,
    stripPrivate: true,
    media: 'none',
  };
}

export interface Index {
  personById: Map<ID, Person>;
  unionById: Map<ID, Union>;
  /** Unions where this person is a partner. */
  unionsByPartner: Map<ID, ID[]>;
  /** Unions where this person is a child. */
  unionsByChild: Map<ID, ID[]>;
  mediaById: Map<ID, MediaRef>;
}

export function buildIndex(tree: TreeData): Index {
  const personById = new Map(tree.persons.map((p) => [p.id, p]));
  const unionById = new Map(tree.unions.map((u) => [u.id, u]));
  const unionsByPartner = new Map<ID, ID[]>();
  const unionsByChild = new Map<ID, ID[]>();
  const mediaById = new Map(tree.media.map((m) => [m.id, m]));

  for (const union of tree.unions) {
    for (const id of union.partnerIds) {
      const list = unionsByPartner.get(id) ?? [];
      list.push(union.id);
      unionsByPartner.set(id, list);
    }
    for (const id of union.childIds) {
      const list = unionsByChild.get(id) ?? [];
      list.push(union.id);
      unionsByChild.set(id, list);
    }
  }

  return { personById, unionById, unionsByPartner, unionsByChild, mediaById };
}

function parentsOf(index: Index, personId: ID): ID[] {
  const out: ID[] = [];
  for (const unionId of index.unionsByChild.get(personId) ?? []) {
    const union = index.unionById.get(unionId);
    if (union) out.push(...union.partnerIds);
  }
  return out;
}

function childrenOf(index: Index, personId: ID): ID[] {
  const out: ID[] = [];
  for (const unionId of index.unionsByPartner.get(personId) ?? []) {
    const union = index.unionById.get(unionId);
    if (union) out.push(...union.childIds);
  }
  return out;
}

function spousesOf(index: Index, personId: ID): ID[] {
  const out: ID[] = [];
  for (const unionId of index.unionsByPartner.get(personId) ?? []) {
    const union = index.unionById.get(unionId);
    if (union) out.push(...union.partnerIds.filter((id) => id !== personId));
  }
  return out;
}

export function ancestorsOf(index: Index, seeds: ID[], generations: number): Set<ID> {
  const found = new Set<ID>();
  let frontier = new Set(seeds);
  for (let depth = 0; depth < generations; depth++) {
    const next = new Set<ID>();
    for (const id of frontier) {
      for (const parent of parentsOf(index, id)) {
        if (!found.has(parent)) {
          found.add(parent);
          next.add(parent);
        }
      }
    }
    if (!next.size) break;
    frontier = next;
  }
  return found;
}

export function descendantsOf(index: Index, seeds: ID[], generations: number): Set<ID> {
  const found = new Set<ID>();
  let frontier = new Set(seeds);
  for (let depth = 0; depth < generations; depth++) {
    const next = new Set<ID>();
    for (const id of frontier) {
      for (const kid of childrenOf(index, id)) {
        if (!found.has(kid)) {
          found.add(kid);
          next.add(kid);
        }
      }
    }
    if (!next.size) break;
    frontier = next;
  }
  return found;
}

/** Walk sideways: siblings, then their spouses and children, k times over. */
function expandCollateral(index: Index, selected: Set<ID>, steps: number): void {
  let frontier = [...selected];
  for (let step = 0; step < steps; step++) {
    const next: ID[] = [];
    for (const id of frontier) {
      for (const unionId of index.unionsByChild.get(id) ?? []) {
        const union = index.unionById.get(unionId);
        if (!union) continue;
        for (const sibling of union.childIds) {
          if (selected.has(sibling)) continue;
          selected.add(sibling);
          next.push(sibling);
        }
      }
      for (const spouse of spousesOf(index, id)) {
        if (selected.has(spouse)) continue;
        selected.add(spouse);
        next.push(spouse);
      }
    }
    frontier = next;
  }
}

export function matchesFilters(person: Person, filters: SubsetFilters): boolean {
  const allowPrivacy = filters.allowPrivacy ?? ['public', 'family'];
  if (!allowPrivacy.includes(person.privacy)) return false;

  if (filters.nameIncludes) {
    const needle = filters.nameIncludes.toLowerCase();
    const hay = person.names.map((n) => `${n.given} ${n.surname} ${n.nickname ?? ''}`.toLowerCase()).join(' ');
    if (!hay.includes(needle)) return false;
  }

  if (filters.surname) {
    const needle = filters.surname.toLowerCase();
    if (!person.names.some((n) => n.surname.toLowerCase().includes(needle))) return false;
  }

  if (filters.sex?.length && !filters.sex.includes(person.sex)) return false;

  const born = birthYear(person);
  if (filters.bornFrom !== undefined && (born === undefined || born < filters.bornFrom)) return false;
  if (filters.bornTo !== undefined && (born === undefined || born > filters.bornTo)) return false;

  const died = deathYear(person);
  if (filters.diedFrom !== undefined && (died === undefined || died < filters.diedFrom)) return false;
  if (filters.diedTo !== undefined && (died === undefined || died > filters.diedTo)) return false;

  if (filters.living && filters.living !== 'any') {
    const living = isLiving(person);
    if (filters.living === 'living' && !living) return false;
    if (filters.living === 'deceased' && living) return false;
  }

  if (filters.placeIncludes) {
    const needle = filters.placeIncludes.toLowerCase();
    const places = person.events.map((e) => e.place ?? '').join(' ').toLowerCase();
    if (!places.includes(needle)) return false;
  }

  if (filters.tags?.length) {
    if (!filters.tags.some((tag) => person.tags.includes(tag))) return false;
  }

  if (filters.hasMedia === true && person.mediaIds.length === 0) return false;
  if (filters.hasMedia === false && person.mediaIds.length > 0) return false;

  // Date windows on specific events use the normalized range, not the raw text.
  if (filters.bornFrom !== undefined || filters.bornTo !== undefined) {
    const birth = person.events.find((e) => e.type === 'BIRT');
    if (birth && !overlapsYears(birth.date, filters.bornFrom, filters.bornTo)) return false;
  }

  return true;
}

/** What the user asked for, before boundary repair. */
export function selectPersons(tree: TreeData, criteria: SubsetCriteria): Set<ID> {
  const index = buildIndex(tree);
  const roots = new Set(criteria.roots.filter((id) => index.personById.has(id)));
  const manual = new Set(criteria.manualIds.filter((id) => index.personById.has(id)));
  const hasFilters = Object.values(criteria.filters).some((v) => v !== undefined && !(Array.isArray(v) && v.length === 0));

  if (!roots.size && !manual.size) {
    // No anchor: this is a global query. Filters alone decide the set.
    const out = new Set<ID>();
    for (const person of tree.persons) {
      if (hasFilters ? matchesFilters(person, criteria.filters) : true) out.add(person.id);
    }
    return out;
  }

  const selected = new Set<ID>([...roots, ...manual]);

  if (criteria.ancestors > 0) {
    for (const id of ancestorsOf(index, [...selected], criteria.ancestors)) selected.add(id);
  }
  if (criteria.descendants > 0) {
    for (const id of descendantsOf(index, [...selected], criteria.descendants)) selected.add(id);
  }
  if (criteria.includeSpouses) {
    for (const id of [...selected]) {
      for (const spouse of spousesOf(index, id)) selected.add(spouse);
    }
  }
  if (criteria.collateral > 0) {
    expandCollateral(index, selected, criteria.collateral);
  }

  if (hasFilters) {
    // Filters act as a mask on the walked set. Boundary repair below keeps the
    // graph valid for whoever the mask removed.
    for (const id of [...selected]) {
      const person = index.personById.get(id);
      if (!person) {
        selected.delete(id);
        continue;
      }
      const isAnchor = roots.has(id) || manual.has(id);
      if (!isAnchor && !matchesFilters(person, criteria.filters)) selected.delete(id);
    }
  }

  return selected;
}

export interface SubsetStats {
  persons: number;
  unions: number;
  sources: number;
  mediaRefs: number;
  mediaIncluded: number;
  /** Sum of original file sizes for referenced media (not what is shipped). */
  mediaBytesReferenced: number;
  /** Bytes that would ship under the current media mode. */
  mediaBytesIncluded: number;
  redacted: number;
  stubs: number;
}

export interface SubsetResult {
  tree: TreeData;
  stats: SubsetStats;
  warnings: Msg[];
  selectedIds: Set<ID>;
  redactedIds: ID[];
  stubIds: ID[];
}

function emptySubsetTree(source: TreeData, name: string): TreeData {
  return {
    meta: {
      ...source.meta,
      id: `${source.meta.id}-slice`,
      name,
      updatedAt: new Date().toISOString(),
    },
    persons: [],
    unions: [],
    sources: [],
    media: [],
  };
}

/**
 * Build the exportable slice: selection, boundary repair, redaction, then a
 * media index filtered to what is actually referenced.
 */
export function extractSubset(tree: TreeData, criteria: SubsetCriteria, sliceName = 'Slice'): SubsetResult {
  const index = buildIndex(tree);
  const warnings: Msg[] = [];
  const selected = selectPersons(tree, criteria);

  // ---- Boundary repair -------------------------------------------------
  const personIds = new Set(selected);

  if (criteria.boundary === 'include') {
    // One hop only: pull in co-partners and co-children of selected people so
    // nuclear families stay intact, but do not transitively swallow the tree.
    const ring = new Set<ID>();
    for (const union of tree.unions) {
      const touches = union.partnerIds.some((id) => personIds.has(id)) || union.childIds.some((id) => personIds.has(id));
      if (!touches) continue;
      for (const id of [...union.partnerIds, ...union.childIds]) {
        if (index.personById.has(id)) ring.add(id);
      }
    }
    for (const id of ring) personIds.add(id);
  }

  const stubIds = new Set<ID>();
  const touchedUnions = tree.unions.filter((u) =>
    u.partnerIds.some((id) => personIds.has(id)) || u.childIds.some((id) => personIds.has(id)),
  );

  if (criteria.boundary === 'stub') {
    for (const union of touchedUnions) {
      for (const id of [...union.partnerIds, ...union.childIds]) {
        if (personIds.has(id)) continue;
        if (!index.personById.has(id)) continue;
        personIds.add(id);
        stubIds.add(id);
      }
    }
  }

  // ---- Redaction -------------------------------------------------------
  const redactedIds: ID[] = [];
  const exportPersons: Person[] = [];

  for (const id of personIds) {
    const person = index.personById.get(id);
    if (!person) continue;

    const allowPrivacy = criteria.filters.allowPrivacy ?? ['public', 'family'];
    const isStub = stubIds.has(id);
    const shouldRedact =
      (criteria.redactLiving && isLiving(person)) || person.privacy === 'private' || !allowPrivacy.includes(person.privacy);

    if (shouldRedact) {
      redactedIds.push(id);
      const surname = person.names[0]?.surname ?? '';
      const redacted: Person = {
        id,
        sex: person.sex,
        names: [{ id: 'redacted', given: '[Living]', surname, type: 'unknown' }],
        events: [],
        notes: [],
        citations: [],
        mediaIds: [],
        tags: [],
        privacy: 'private',
        redacted: true,
      };
      exportPersons.push(redacted);
      continue;
    }

    if (isStub) {
      // A stub is a name-only placeholder so the recipient sees a valid graph
      // instead of a broken link. Nothing else travels.
      exportPersons.push({
        id,
        sex: person.sex,
        names: person.names.map((n) => ({ ...n })),
        events: [],
        notes: [],
        citations: [],
        mediaIds: [],
        tags: [],
        privacy: person.privacy,
        isStub: true,
      });
      continue;
    }

    exportPersons.push({
      ...person,
      notes: criteria.stripPrivate ? person.notes.filter((n) => !n.isPrivate) : person.notes,
      citations: criteria.stripPrivate ? person.citations.filter((c) => !c.text?.startsWith('PRIVATE')) : person.citations,
      events: person.events.map((event) => ({
        ...event,
        citations: criteria.stripPrivate
          ? event.citations?.filter((c) => !c.text?.startsWith('PRIVATE'))
          : event.citations,
      })),
    });
  }

  // ---- Unions, trimmed to the surviving graph --------------------------
  const exportUnions: Union[] = [];
  for (const union of touchedUnions) {
    const partners = union.partnerIds.filter((id) => personIds.has(id));
    const kids = union.childIds.filter((id) => personIds.has(id));

    if (criteria.boundary === 'prune') {
      // Nothing outside the set may be referenced.
      if (!partners.length) continue;
    }

    const links: NonNullable<Union['childLinks']> = {};
    for (const kid of kids) {
      const link = union.childLinks?.[kid];
      if (link) links[kid] = link;
    }

    exportUnions.push({
      ...union,
      partnerIds: partners,
      childIds: kids,
      childLinks: Object.keys(links).length ? links : undefined,
      notes: criteria.stripPrivate ? union.notes.filter((n) => !n.isPrivate) : union.notes,
    });
  }

  if (criteria.boundary === 'stub') {
    for (const union of exportUnions) {
      for (const id of [...union.partnerIds, ...union.childIds]) {
        if (!personIds.has(id))
          warnings.push({ key: 'warn.unionDangling', params: { union: union.id, person: id } });
      }
    }
  }

  // ---- Media, sources --------------------------------------------------
  const referencedMediaIds = new Set<ID>();
  for (const person of exportPersons) person.mediaIds.forEach((id) => referencedMediaIds.add(id));
  for (const union of exportUnions) union.mediaIds.forEach((id) => referencedMediaIds.add(id));

  const allowPrivacy = criteria.filters.allowPrivacy ?? ['public', 'family'];
  const exportMedia: MediaRef[] = [];
  for (const id of referencedMediaIds) {
    const ref = index.mediaById.get(id);
    if (!ref) {
      warnings.push({ key: 'warn.missingMedia', params: { id } });
      continue;
    }
    if (!allowPrivacy.includes(ref.privacy)) continue;
    exportMedia.push(ref);
  }

  const referencedSourceIds = new Set<ID>();
  const collectSources = (citations?: Array<{ sourceId?: ID }>): void => {
    for (const citation of citations ?? []) {
      if (citation.sourceId) referencedSourceIds.add(citation.sourceId);
    }
  };
  for (const person of exportPersons) {
    collectSources(person.citations);
    for (const event of person.events) collectSources(event.citations);
  }
  for (const union of exportUnions) {
    collectSources(union.citations);
    for (const event of union.events) collectSources(event.citations);
  }

  const exportSources = tree.sources.filter((s) => referencedSourceIds.has(s.id));
  for (const source of exportSources) source.mediaIds.forEach((id) => {
    const ref = index.mediaById.get(id);
    if (ref && allowPrivacy.includes(ref.privacy) && !exportMedia.some((m) => m.id === id)) exportMedia.push(ref);
  });

  // Citations whose source did not survive must keep their text, or the
  // evidence trail vanishes silently on re-import.
  const keptSourceIds = new Set(exportSources.map((s) => s.id));
  const downgrade = (citations?: Array<{ sourceId?: ID; text?: string }>): void => {
    for (const citation of citations ?? []) {
      if (citation.sourceId && !keptSourceIds.has(citation.sourceId)) {
        delete citation.sourceId;
        citation.text = citation.text ?? '(source not included in this slice)';
      }
    }
  };
  for (const person of exportPersons) {
    downgrade(person.citations);
    for (const event of person.events) downgrade(event.citations);
  }
  for (const union of exportUnions) {
    downgrade(union.citations);
    for (const event of union.events) downgrade(event.citations);
  }

  // ---- Stats -----------------------------------------------------------
  const mediaBytesReferenced = exportMedia.reduce((sum, m) => sum + m.bytes, 0);
  const mediaBytesIncluded = exportMedia.reduce((sum, m) => {
    if (criteria.media === 'full') return sum + m.bytes;
    if (criteria.media === 'thumbs') return sum + (m.thumbBytes ?? 0);
    return sum;
  }, 0);
  const mediaIncluded = criteria.media === 'none' ? 0 : exportMedia.length;

  const subsetTree = emptySubsetTree(tree, sliceName);
  subsetTree.persons = exportPersons;
  subsetTree.unions = exportUnions;
  subsetTree.sources = exportSources;
  subsetTree.media = exportMedia;

  return {
    tree: subsetTree,
    stats: {
      persons: exportPersons.length,
      unions: exportUnions.length,
      sources: exportSources.length,
      mediaRefs: exportMedia.length,
      mediaIncluded,
      mediaBytesReferenced,
      mediaBytesIncluded,
      redacted: redactedIds.length,
      stubs: stubIds.size,
    },
    warnings,
    selectedIds: selected,
    redactedIds,
    stubIds: [...stubIds],
  };
}

/** Short human description of a slice, used for filenames and manifests. */
export function describeCriteriaParts(criteria: SubsetCriteria): Msg[] {
  const parts: Msg[] = [];
  if (criteria.roots.length) {
    if (criteria.ancestors)
      parts.push({
        key: criteria.ancestors === 1 ? 'criteria.generationsUp.one' : 'criteria.generationsUp',
        params: { count: criteria.ancestors },
      });
    if (criteria.descendants)
      parts.push({
        key: criteria.descendants === 1 ? 'criteria.generationsDown.one' : 'criteria.generationsDown',
        params: { count: criteria.descendants },
      });
    if (criteria.includeSpouses) parts.push({ key: 'criteria.inclSpouses' });
    if (criteria.collateral) parts.push({ key: 'criteria.collateral', params: { count: criteria.collateral } });
  }
  const f = criteria.filters;
  if (f.nameIncludes) parts.push({ key: 'criteria.nameContains', params: { value: f.nameIncludes } });
  if (f.surname) parts.push({ key: 'criteria.surname', params: { value: f.surname } });
  if (f.bornFrom || f.bornTo)
    parts.push({ key: 'criteria.bornRange', params: { from: f.bornFrom ?? '', to: f.bornTo ?? '' } });
  if (f.diedFrom || f.diedTo)
    parts.push({ key: 'criteria.diedRange', params: { from: f.diedFrom ?? '', to: f.diedTo ?? '' } });
  if (f.placeIncludes) parts.push({ key: 'criteria.place', params: { value: f.placeIncludes } });
  if (f.living === 'living') parts.push({ key: 'criteria.living' });
  if (f.living === 'deceased') parts.push({ key: 'criteria.deceased' });
  if (f.hasMedia !== undefined) parts.push({ key: f.hasMedia ? 'criteria.withMedia' : 'criteria.withoutMedia' });
  if (criteria.manualIds.length) parts.push({ key: 'count.handPicked', params: { count: criteria.manualIds.length } });
  return parts.length ? parts : [{ key: 'criteria.wholeTree' }];
}

/**
 * The same description as a stable file name ingredient. Deliberately English:
 * a file written on a Turkish device and opened on a German one must still be
 * the same file, so this is an identifier rather than interface text.
 */
export function describeCriteria(criteria: SubsetCriteria): string {
  return describeCriteriaParts(criteria)
    .map((part) => message('en', part))
    .join(', ');
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
