import { parseGedcomDate } from '../date';
import type { Msg } from '../i18n';
import {
  APP_VERSION,
  SCHEMA_VERSION,
  type Certainty,
  type Citation,
  type Event,
  type GDate,
  type ID,
  type MediaKind,
  type MediaRef,
  type Name,
  type Note,
  type Pedigree,
  type Person,
  type Privacy,
  type Sex,
  type Source,
  type TreeData,
  type Union,
} from '../types';
import { child, children, parseGedcomTree, type GdNode } from './nodes';

export function newId(prefix: string): ID {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      : Math.random().toString(36).slice(2, 12);
  return `${prefix}-${rand}`;
}

/** Event tags we understand. Anything else becomes an EVEN with a label. */
const EVENT_TAGS = new Set([
  'BIRT', 'CHR', 'BAPM', 'BARM', 'BASM', 'BLES', 'BURI', 'CREM', 'DEAT',
  'ADOP', 'CENS', 'CONF', 'EMIG', 'IMMI', 'NATU', 'ORDN', 'PROB', 'RETI',
  'WILL', 'GRAD', 'EDUC', 'OCCU', 'RESI', 'PROP', 'CAST', 'FCOM', 'TOMB',
  'MARR', 'DIV', 'DIVF', 'ENGA', 'MARB', 'MARC', 'MARL', 'MARS', 'ANUL',
  'EVEN',
]);

export { eventLabel } from '../labels';

function idOfXref(xref?: string): ID | undefined {
  return xref ? xref.replace(/@/g, '') : undefined;
}

function privacyOf(node: GdNode | undefined): Privacy {
  const raw = (child(node, '_PRIV')?.value ?? '').toLowerCase();
  if (raw === 'private' || raw === 'confidential') return 'private';
  if (raw === 'family') return 'family';
  return 'public';
}

function certaintyOf(node: GdNode | undefined): Certainty {
  const raw = (child(node, '_CONF')?.value ?? '').toLowerCase();
  if (raw === 'probable' || raw === 'possible' || raw === 'disputed') return raw;
  return 'certain';
}

function readDate(node: GdNode | undefined, tag = 'DATE'): GDate | undefined {
  const dateNode = child(node, tag);
  if (!dateNode || !dateNode.value.trim()) return undefined;
  return parseGedcomDate(dateNode.value);
}

function readCitations(node: GdNode): Citation[] {
  return children(node, 'SOUR').map((sour) => {
    const pointer = idOfXref(sour.value.trim());
    const page = child(sour, 'PAGE')?.value?.trim();
    const text = child(sour, 'TEXT')?.value?.trim();
    return {
      id: newId('cit'),
      sourceId: pointer,
      page,
      text: pointer ? text : sour.value.trim() || text,
      quality: (child(sour, '_QUAL')?.value as Citation['quality']) ?? undefined,
    };
  });
}

function isPointer(value: string): boolean {
  return /^@[^@]+@$/.test(value.trim());
}

function readNotes(node: GdNode): Note[] {
  // A NOTE whose value is a pointer is a reference to a shared NOTE record,
  // not inline text; skip those rather than importing "@N1@" as the body.
  return children(node, 'NOTE')
    .filter((n) => !isPointer(n.value))
    .map((n) => ({
      id: newId('note'),
      body: n.value,
      isPrivate: privacyOf(n) === 'private',
    }));
}

function readEvent(node: GdNode): Event {
  const labelNode = child(node, 'TYPE');
  // The tag line can carry the fact itself ("1 OCCU Creamery manager"). `Y`
  // and `N` are 5.5.1's bare assertions, not text, and a pointer is a link to
  // another record rather than a value.
  const raw = node.value.trim();
  const value = raw && raw !== 'Y' && raw !== 'N' && !isPointer(raw) ? raw : undefined;
  return {
    id: newId('evt'),
    type: node.tag,
    label: labelNode?.value || undefined,
    value,
    date: readDate(node),
    place: child(node, 'PLAC')?.value?.trim() || undefined,
    address: child(node, 'ADDR')?.value?.trim() || undefined,
    certainty: certaintyOf(node),
    note: child(node, 'NOTE')?.value || undefined,
    citations: readCitations(node),
  };
}

function readName(node: GdNode, personId: ID): Name {
  const raw = node.value.trim();
  let given = '';
  let surname = '';

  // GEDCOM personal name form: "Given /Surname/ Suffix"
  const slash = /^(.*?)\/([^/]*)\/(.*)$/.exec(raw);
  if (slash) {
    given = slash[1].trim();
    surname = slash[2].trim();
  } else {
    given = raw;
  }

  const givn = child(node, 'GIVN')?.value;
  const surn = child(node, 'SURN')?.value;
  const nick = child(node, 'NICK')?.value;
  const npfx = child(node, 'NPFX')?.value;
  const nsfx = child(node, 'NSFX')?.value;
  const typeRaw = (child(node, 'TYPE')?.value ?? '').toLowerCase();

  const type: Name['type'] =
    typeRaw.includes('married') ? 'married'
      : typeRaw.includes('aka') || typeRaw.includes('also') ? 'aka'
        : typeRaw.includes('religious') ? 'religious'
          : personId && raw ? 'birth'
            : 'unknown';

  return {
    id: newId('nm'),
    given: (givn ?? given).trim(),
    surname: (surn ?? surname).trim(),
    prefix: npfx,
    suffix: nsfx,
    nickname: nick,
    type,
  };
}

function extOf(mime: string, filename?: string): string {
  const fromName = filename ? /\.([A-Za-z0-9]{1,5})$/.exec(filename)?.[1] : undefined;
  if (fromName) return fromName.toLowerCase();
  const fromMime = /^image\/(\w+)$/.exec(mime)?.[1];
  if (fromMime) return fromMime === 'jpeg' ? 'jpg' : fromMime;
  return 'bin';
}

export function mimeFromForm(form?: string, filename?: string): string {
  const f = (form ?? '').toLowerCase();
  if (f === 'jpeg' || f === 'jpg') return 'image/jpeg';
  if (f === 'png' || f === 'gif' || f === 'webp' || f === 'tiff') return `image/${f}`;
  if (f.startsWith('image/')) return f;
  if (f === 'pdf') return 'application/pdf';
  const ext = filename ? /\.([A-Za-z0-9]{1,5})$/.exec(filename)?.[1]?.toLowerCase() : undefined;
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'pdf') return 'application/pdf';
  return 'application/octet-stream';
}

export function mediaFileName(ref: Pick<MediaRef, 'sha256' | 'mime' | 'filename'>): string {
  return `${ref.sha256}.${extOf(ref.mime, ref.filename)}`;
}

function readMediaRecord(node: GdNode): MediaRef {
  const fileNode = child(node, 'FILE');
  const filename = fileNode?.value?.trim();
  const form = child(fileNode ?? node, 'FORM')?.value ?? child(node, 'FORM')?.value;
  const mime = mimeFromForm(form, filename);

  // Prefer an explicit content hash. Without one we fall back to a hash of the
  // path, which is stable per file but cannot deduplicate across machines.
  const sha = (child(node, '_SHA256')?.value ?? '').trim().toLowerCase();
  const placeholder = `nohash-${(filename ?? node.value ?? 'unknown').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`;

  return {
    id: idOfXref(node.xref) ?? newId('med'),
    sha256: sha || placeholder,
    mime,
    bytes: Number(child(node, '_BYTES')?.value ?? 0) || 0,
    filename: filename ? filename.split('/').pop() : undefined,
    caption: child(node, 'TITL')?.value || child(node, 'TEXT')?.value || undefined,
    title: child(node, 'TITL')?.value || undefined,
    date: readDate(node),
    kind: (child(node, '_KIND')?.value as MediaKind) ?? 'photo',
    privacy: privacyOf(node),
    thumbSha256: child(node, '_THUMB')?.value || undefined,
    thumbMime: child(node, '_THUMB_MIME')?.value || undefined,
    thumbBytes: Number(child(node, '_THUMB_BYTES')?.value ?? 0) || undefined,
  };
}

export interface ReadResult {
  tree: TreeData;
  warnings: Msg[];
}

/** Interpret a GEDCOM file into the Rootline model. */
export function readGedcom(text: string, treeName = 'Imported tree'): ReadResult {
  const roots = parseGedcomTree(text);
  const warnings: Msg[] = [];

  const media: MediaRef[] = [];
  const mediaById = new Map<ID, MediaRef>();
  for (const root of roots) {
    if (root.tag === 'OBJE' && root.xref) {
      const ref = readMediaRecord(root);
      media.push(ref);
      mediaById.set(ref.id, ref);
    }
  }

  const sources: Source[] = [];
  for (const root of roots) {
    if (root.tag !== 'SOUR' || !root.xref) continue;
    sources.push({
      id: root.xref,
      title: child(root, 'TITL')?.value || root.value || 'Untitled source',
      author: child(root, 'AUTH')?.value || undefined,
      publication: child(root, 'PUBL')?.value || undefined,
      repository: child(root, 'REPO')?.value || undefined,
      note: child(root, 'NOTE')?.value || undefined,
      mediaIds: children(root, 'OBJE')
        .map((o) => idOfXref(o.value.trim()))
        .filter((v): v is ID => Boolean(v)),
    });
  }

  const persons: Person[] = [];
  const personsById = new Map<ID, Person>();
  /** FAMC is where 5.5.1 puts pedigree, and it points at the family. */
  const famcPedigree: Array<{ personId: ID; unionId: ID; pedigree: Pedigree }> = [];

  for (const root of roots) {
    if (root.tag !== 'INDI' || !root.xref) continue;
    const id = root.xref;

    const names = children(root, 'NAME').map((n) => readName(n, id));

    const events = children(root, 'EVEN')
      .concat(root.children.filter((c) => EVENT_TAGS.has(c.tag) && c.tag !== 'EVEN'))
      .map(readEvent);

    const personMedia = children(root, 'OBJE')
      .map((o) => {
        const pointer = idOfXref(o.value.trim());
        if (pointer) return pointer;
        const inline = readMediaRecord(o);
        media.push(inline);
        mediaById.set(inline.id, inline);
        return inline.id;
      });

    for (const famc of children(root, 'FAMC')) {
      const unionId = idOfXref(famc.value.trim());
      const pedi = (child(famc, 'PEDI')?.value ?? '').toLowerCase();
      if (unionId && pedi) {
        famcPedigree.push({
          personId: id,
          unionId,
          pedigree: (['adopted', 'foster', 'step', 'guardian'].includes(pedi) ? pedi : 'birth') as Pedigree,
        });
      }
    }

    const person: Person = {
      id,
      sex: ((child(root, 'SEX')?.value ?? 'U').toUpperCase() as Sex) || 'U',
      names,
      events,
      notes: readNotes(root),
      citations: readCitations(root),
      mediaIds: personMedia,
      tags: children(root, 'TAG').map((t) => t.value).filter(Boolean),
      privacy: privacyOf(root),
      custom: undefined,
    };
    if (person.sex !== 'M' && person.sex !== 'F') person.sex = 'U';
    persons.push(person);
    personsById.set(id, person);
  }

  const unions: Union[] = [];
  for (const root of roots) {
    if (root.tag !== 'FAM' || !root.xref) continue;
    const id = root.xref;

    // Preserve document order: grouping by tag would silently reorder partners
    // and make every round trip look like a change.
    const PARTNER_TAGS = new Set(['HUSB', 'WIFE', 'PART']);
    const partnerIds = root.children
      .filter((c) => PARTNER_TAGS.has(c.tag))
      .map((n) => idOfXref(n.value.trim()))
      .filter((v): v is ID => Boolean(v));

    const childIds: ID[] = [];
    const childLinks: Union['childLinks'] = {};
    for (const ch of children(root, 'CHIL')) {
      const cid = idOfXref(ch.value.trim());
      if (!cid) continue;
      childIds.push(cid);
      const pedi = (child(ch, 'PEDI')?.value ?? '').toLowerCase();
      if (pedi) {
        childLinks[cid] = {
          pedigree: (['adopted', 'foster', 'step', 'guardian'].includes(pedi) ? pedi : 'birth') as Pedigree,
          certainty: certaintyOf(ch),
        };
      }
    }

    const events = root.children
      .filter((c) => EVENT_TAGS.has(c.tag))
      .map(readEvent);

    const union: Union = {
      id,
      partnerIds: [...new Set(partnerIds)],
      events,
      childIds,
      childLinks: Object.keys(childLinks).length ? childLinks : undefined,
      citations: readCitations(root),
      notes: readNotes(root),
      mediaIds: children(root, 'OBJE')
        .map((o) => idOfXref(o.value.trim()))
        .filter((v): v is ID => Boolean(v)),
    };
    unions.push(union);
  }

  for (const link of famcPedigree) {
    const union = unions.find((u) => u.id === link.unionId);
    if (!union) continue;
    union.childLinks = { ...(union.childLinks ?? {}), [link.personId]: { pedigree: link.pedigree, certainty: 'certain' } };
  }

  // Dangling references are the single most common corruption in real GEDCOM
  // files. Report them instead of silently producing a broken graph.
  const personIds = new Set(persons.map((p) => p.id));
  for (const union of unions) {
    for (const id of union.partnerIds) {
      if (!personIds.has(id))
        warnings.push({ key: 'warn.familyPartner', params: { union: union.id, id } });
    }
    for (const id of union.childIds) {
      if (!personIds.has(id)) warnings.push({ key: 'warn.familyChild', params: { union: union.id, id } });
    }
  }

  const head = roots.find((r) => r.tag === 'HEAD');
  const treeNameFromFile =
    child(head, '_TREE')?.value?.trim() || child(head, 'FILE')?.value?.trim();
  const gedVersion = child(head, 'GEDC') && child(child(head, 'GEDC'), 'VERS')?.value;
  if (gedVersion && !gedVersion.startsWith('5.5')) {
    warnings.push({ key: 'warn.gedcomVersion', params: { version: gedVersion } });
  }

  const now = new Date().toISOString();
  const tree: TreeData = {
    meta: {
      id: newId('tree'),
      name: treeNameFromFile || treeName,
      createdAt: now,
      updatedAt: now,
      schemaVersion: SCHEMA_VERSION,
      appVersion: APP_VERSION,
    },
    persons,
    unions,
    sources,
    media,
  };

  return { tree, warnings };
}
