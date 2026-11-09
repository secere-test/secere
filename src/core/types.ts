/**
 * Secere data model.
 *
 * Deliberate design choices baked into these types:
 *
 * 1. A family is a *graph*, not a tree. People attach to unions (couples /
 *    single-parent units), and child links carry a pedigree type. Cousin
 *    marriage, adoption, step-relations and multiple marriages are all normal
 *    here, nothing enforces acyclicity or a single path to an ancestor.
 * 2. Every record has a UUID-ish stable id. Ids survive export/import/merge,
 *    which is what makes re-import idempotent.
 * 3. Dates keep the author's original string *and* a normalized range. Filtering
 *    needs the range; citation fidelity needs the original.
 * 4. Uncertainty is first class (Certainty on facts, Pedigree on child links).
 * 5. Media are referenced by SHA-256 content address, never by path. Bytes are
 *    optional at export time; the index always travels.
 */

export type ID = string;

export type Sex = 'M' | 'F' | 'U';

export type Privacy = 'public' | 'family' | 'private';

/** How sure we are about a fact or a parent link. */
export type Certainty = 'certain' | 'probable' | 'possible' | 'disputed';

/** How a child came into a union. GEDCOM's PEDI tag. */
export type Pedigree =
  | 'birth'
  | 'adopted'
  | 'foster'
  | 'step'
  | 'guardian'
  | 'unknown';

export type DateQualifier =
  | 'exact'
  | 'about'
  | 'before'
  | 'after'
  | 'between'
  | 'estimated'
  | 'calculated'
  | 'unknown';

export interface GDate {
  /** The date exactly as the author wrote or imported it, e.g. "ABT 1852". */
  raw: string;
  qualifier: DateQualifier;
  /** Normalized lower bound, partial ISO: "1880", "1880-04", "1880-04-03". */
  from?: string;
  /** Normalized upper bound for ranges; equals `from` for single dates. */
  to?: string;
}

export interface Event {
  id: ID;
  /** GEDCOM tag or custom code: BIRT, DEAT, MARR, RESI, OCCU, CENS, ... */
  type: string;
  /** Human label fallback when `type` is custom. */
  label?: string;
  /**
   * The fact's own text, written on the tag line itself: `1 OCCU Creamery
   * manager`. GEDCOM puts the substance of most attributes here rather than in
   * a sub-tag, so dropping it loses the occupation, education or cause of death.
   */
  value?: string;
  date?: GDate;
  /** Free-text place. A normalized place table with historic validity is v0.2. */
  place?: string;
  /** Street address / detail below the place. */
  address?: string;
  certainty: Certainty;
  note?: string;
  citations?: Citation[];
}

export interface Name {
  id: ID;
  given: string;
  surname: string;
  prefix?: string;
  suffix?: string;
  nickname?: string;
  type: 'birth' | 'married' | 'aka' | 'religious' | 'unknown';
}

export interface Note {
  id: ID;
  body: string;
  isPrivate: boolean;
}

export interface Citation {
  id: ID;
  sourceId?: ID;
  page?: string;
  /**
   * Inline text of the citation. When a source record is not part of an export
   * this survives as plain text so the evidence trail is never silently lost.
   */
  text?: string;
  quality?: 'high' | 'medium' | 'low';
}

export type MediaKind = 'photo' | 'document' | 'headstone' | 'video' | 'audio' | 'other';

/**
 * A media *index* entry. The bytes with this content hash may or may not be
 * present locally, and may or may not be included in any given export.
 */
export interface MediaRef {
  id: ID;
  /** SHA-256 of the original bytes, lowercase hex. The only real identity. */
  sha256: string;
  mime: string;
  /** Size of the original file in bytes. */
  bytes: number;
  /** Original filename, kept as a hint for relinking. Never used to resolve. */
  filename?: string;
  caption?: string;
  title?: string;
  date?: GDate;
  kind: MediaKind;
  privacy: Privacy;
  /** Optional pre-rendered thumbnail (also content addressed). */
  thumbSha256?: string;
  thumbMime?: string;
  thumbBytes?: number;
}

export interface Person {
  id: ID;
  sex: Sex;
  names: Name[];
  events: Event[];
  notes: Note[];
  citations: Citation[];
  mediaIds: ID[];
  tags: string[];
  /**
   * Override for living detection. If undefined, the engine infers it from
   * death events and birth year.
   */
  living?: boolean;
  privacy: Privacy;
  custom?: Record<string, string>;
  /** Set by the slice engine: a name-only placeholder at the boundary. */
  isStub?: boolean;
  /** Set by the slice engine: details stripped for privacy. */
  redacted?: boolean;
}

export interface Union {
  id: ID;
  /** One or two partners. One is legal (single known parent). */
  partnerIds: ID[];
  events: Event[];
  childIds: ID[];
  childLinks?: Record<ID, { pedigree: Pedigree; certainty: Certainty }>;
  citations: Citation[];
  notes: Note[];
  mediaIds: ID[];
}

export interface Source {
  id: ID;
  title: string;
  author?: string;
  publication?: string;
  repository?: string;
  note?: string;
  mediaIds: ID[];
}

export interface TreeMeta {
  id: ID;
  name: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
  appVersion: string;
}

export interface TreeData {
  meta: TreeMeta;
  persons: Person[];
  unions: Union[];
  sources: Source[];
  media: MediaRef[];
}

export const SCHEMA_VERSION = 1;
export const APP_VERSION = '0.4.0';

/** Local media bytes, keyed by content hash. Disposable cache, not the truth. */
export type MediaBlobStore = Map<string, { bytes: Uint8Array; mime: string }>;

export function emptyTree(name: string): TreeData {
  const now = new Date().toISOString();
  return {
    meta: {
      id: `tree-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      createdAt: now,
      updatedAt: now,
      schemaVersion: SCHEMA_VERSION,
      appVersion: APP_VERSION,
    },
    persons: [],
    unions: [],
    sources: [],
    media: [],
  };
}

export function personName(p: Person): string {
  if (!p.names.length) return 'Unknown';
  const n = p.names[0];
  return [n.prefix, n.given, n.surname, n.suffix].filter(Boolean).join(' ').trim() || 'Unknown';
}

export function lifespan(p: Person): string {
  const born = p.events.find((e) => e.type === 'BIRT' || e.type === 'CHR');
  const died = p.events.find((e) => e.type === 'DEAT' || e.type === 'BURI');
  const by = yearOf(born?.date?.from);
  const dy = yearOf(died?.date?.from);
  if (by && dy) return `${by}–${dy}`;
  if (by) return `b. ${by}`;
  if (dy) return `d. ${dy}`;
  return '';
}

export function sortName(p: Person): string {
  if (!p.names.length) return 'Unknown';
  const n = p.names[0];
  return [n.surname, n.given].filter(Boolean).join(', ');
}

export function eventOf(p: Person, type: string): Event | undefined {
  return p.events.find((e) => e.type === type);
}

export function yearOf(value?: string): number | undefined {
  if (!value) return undefined;
  const m = /^(\d{3,4})/.exec(value);
  return m ? Number(m[1]) : undefined;
}

/** Birth year of a person, from any birth-like event. */
export function birthYear(p: Person): number | undefined {
  const e = p.events.find((ev) => ev.type === 'BIRT' || ev.type === 'CHR' || ev.type === 'BAPM');
  return yearOf(e?.date?.from) ?? yearOf(e?.date?.to);
}

export function deathYear(p: Person): number | undefined {
  const e = p.events.find((ev) => ev.type === 'DEAT' || ev.type === 'BURI' || ev.type === 'CREM');
  return yearOf(e?.date?.from) ?? yearOf(e?.date?.to);
}

/**
 * Living-person heuristic. An explicit flag wins; otherwise anyone with a death
 * fact is deceased, and anyone born more than 110 years ago is presumed
 * deceased. Everyone else is treated as living, which is the privacy-safe
 * default: redaction should fail closed.
 */
export function isLiving(p: Person, currentYear = new Date().getFullYear()): boolean {
  if (p.living !== undefined) return p.living;
  if (p.events.some((e) => e.type === 'DEAT' || e.type === 'BURI' || e.type === 'CREM')) return false;
  const by = birthYear(p);
  if (by !== undefined && currentYear - by > 110) return false;
  return true;
}
