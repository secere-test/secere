import { formatGedcomDate } from '../date';
import { APP_VERSION, type Event, type MediaRef, type Person, type TreeData, type Union } from '../types';
import { mediaFileName } from './read';
import { node, relevel, serializeGedcomTree, type GdNode } from './nodes';

export interface WriteGedcomOptions {
  /** Where media files are expected to live relative to the .ged file. */
  mediaPath?: (ref: MediaRef) => string;
  /**
   * Emit top-level OBJE records. Keep true even for media-less exports: the
   * index and the `_SHA256` custom tag are what let a recipient relink files
   * they already have on disk.
   */
  includeMediaRecords?: boolean;
}

function dateNode(prefix: string, value: string): GdNode {
  return node(prefix, value);
}

function eventNodes(events: Event[], level1Tag?: string): GdNode[] {
  return events.map((event) => {
    const tag = level1Tag ?? event.type;
    const kids: GdNode[] = [];
    if (event.date) {
      const formatted = formatGedcomDate(event.date);
      if (formatted) kids.push(dateNode('DATE', formatted));
    }
    if (event.place) kids.push(node('PLAC', event.place));
    if (event.address) kids.push(node('ADDR', event.address));
    if (event.note) kids.push(node('NOTE', event.note));
    if (event.certainty !== 'certain') kids.push(node('_CONF', event.certainty));
    if (event.label) kids.push(node('TYPE', event.label));
    return node(tag, event.value ?? (kids.length ? '' : 'Y'), kids);
  });
}

function citationNodes(tree: TreeData, nodes: GdNode[], parent: { citations?: Array<{ sourceId?: string; page?: string; text?: string; quality?: string }> }): void {
  const sourceIds = new Set(tree.sources.map((s) => s.id));
  for (const citation of parent.citations ?? []) {
    const target = citation.sourceId && sourceIds.has(citation.sourceId) ? `@${citation.sourceId}@` : '';
    const kids: GdNode[] = [];
    if (citation.page) kids.push(node('PAGE', citation.page));
    if (citation.text) kids.push(node('TEXT', citation.text));
    if (citation.quality) kids.push(node('_QUAL', citation.quality));
    nodes.push(node('SOUR', target || citation.text || '', kids));
  }
}

function mediaPointerNodes(mediaIds: string[], mediaIds_set: Set<string>): GdNode[] {
  return mediaIds
    .filter((id) => mediaIds_set.has(id))
    .map((id) => node('OBJE', `@${id}@`));
}

function personNodes(tree: TreeData, person: Person, mediaIds: Set<string>): GdNode[] {
  const kids: GdNode[] = [];

  for (const name of person.names) {
    const display = [name.given, name.surname].filter(Boolean).join(' ');
    const gedcomName = name.surname || name.given
      ? `${name.given}${name.surname ? ` /${name.surname}/` : ''}${name.suffix ? ` ${name.suffix}` : ''}`.trim()
      : display;
    const nameKids: GdNode[] = [];
    if (name.given) nameKids.push(node('GIVN', name.given));
    if (name.surname) nameKids.push(node('SURN', name.surname));
    if (name.prefix) nameKids.push(node('NPFX', name.prefix));
    if (name.suffix) nameKids.push(node('NSFX', name.suffix));
    if (name.nickname) nameKids.push(node('NICK', name.nickname));
    if (name.type !== 'birth' && name.type !== 'unknown') {
      nameKids.push(node('TYPE', name.type === 'aka' ? 'aka' : name.type));
    }
    kids.push(node('NAME', gedcomName, nameKids));
  }

  if (person.sex !== 'U') kids.push(node('SEX', person.sex));

  kids.push(...eventNodes(person.events));
  for (const note of person.notes) {
    const noteNode = node('NOTE', note.body);
    if (note.isPrivate) noteNode.children.push(node('_PRIV', 'private'));
    kids.push(noteNode);
  }
  citationNodes(tree, kids, person);
  kids.push(...mediaPointerNodes(person.mediaIds, mediaIds));
  for (const tag of person.tags) kids.push(node('TAG', tag));
  if (person.privacy !== 'public') kids.push(node('_PRIV', person.privacy));
  for (const [key, value] of Object.entries(person.custom ?? {})) {
    kids.push(node(`_${key.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`, value));
  }

  return [node('INDI', '', kids, person.id)];
}

function unionNodes(tree: TreeData, union: Union, mediaIds: Set<string>): GdNode[] {
  const kids: GdNode[] = [];
  // GEDCOM has no neutral partner tag in 5.5.1; HUSB/WIFE are the slots every
  // tool understands, so a same-sex couple is written as two HUSB or two WIFE
  // entries and marked with a custom tag for round-tripping.
  const partners = union.partnerIds;
  const sexes = partners.map((id) => tree.persons.find((p) => p.id === id)?.sex);
  if (partners.length === 2 && sexes[0] === sexes[1] && sexes[0]) {
    for (const id of partners) kids.push(node('HUSB', `@${id}@`));
    kids.push(node('_PARTNER_SEX', sexes[0]));
  } else {
    partners.forEach((id, index) => {
      kids.push(node(sexes[index] === 'F' ? 'WIFE' : 'HUSB', `@${id}@`));
    });
  }

  for (const childId of union.childIds) {
    const link = union.childLinks?.[childId];
    const childNode = node('CHIL', `@${childId}@`);
    if (link && link.pedigree !== 'birth') childNode.children.push(node('PEDI', link.pedigree));
    kids.push(childNode);
  }

  kids.push(...eventNodes(union.events));
  for (const note of union.notes) kids.push(node('NOTE', note.body));
  citationNodes(tree, kids, union);
  kids.push(...mediaPointerNodes(union.mediaIds, mediaIds));

  return [node('FAM', '', kids, union.id)];
}

function mediaRecordNodes(tree: TreeData, options: Required<WriteGedcomOptions>): GdNode[] {
  return tree.media.map((ref) => {
    const path = options.mediaPath(ref) || `media/${mediaFileName(ref)}`;
    const fileKids: GdNode[] = [];
    const form = ref.filename ? /\.([A-Za-z0-9]{1,5})$/.exec(ref.filename)?.[1] : undefined;
    if (form) fileKids.push(node('FORM', form.toLowerCase()));
    else if (ref.mime.startsWith('image/')) fileKids.push(node('FORM', ref.mime.slice(6)));

    const kids: GdNode[] = [node('FILE', path, fileKids)];
    if (ref.caption) kids.push(node('TITL', ref.caption));
    if (ref.date) kids.push(node('DATE', formatGedcomDate(ref.date)));
    if (ref.bytes) kids.push(node('_BYTES', String(ref.bytes)));
    if (ref.thumbSha256) kids.push(node('_THUMB', ref.thumbSha256));
    if (ref.thumbMime) kids.push(node('_THUMB_MIME', ref.thumbMime));
    if (ref.thumbBytes) kids.push(node('_THUMB_BYTES', String(ref.thumbBytes)));
    if (ref.privacy !== 'public') kids.push(node('_PRIV', ref.privacy));
    if (ref.kind !== 'photo') kids.push(node('_KIND', ref.kind));
    kids.push(node('_SHA256', ref.sha256));
    return node('OBJE', '', kids, ref.id);
  });
}

export function writeGedcom(tree: TreeData, options: WriteGedcomOptions = {}): string {
  const opts: Required<WriteGedcomOptions> = {
    mediaPath: options.mediaPath ?? ((ref) => `media/${mediaFileName(ref)}`),
    includeMediaRecords: options.includeMediaRecords ?? true,
  };

  const referencedMedia = new Set<string>();
  for (const p of tree.persons) p.mediaIds.forEach((id) => referencedMedia.add(id));
  for (const u of tree.unions) u.mediaIds.forEach((id) => referencedMedia.add(id));
  for (const s of tree.sources) s.mediaIds.forEach((id) => referencedMedia.add(id));
  const mediaIds = new Set(tree.media.filter((m) => referencedMedia.has(m.id)).map((m) => m.id));

  const head: GdNode = node('HEAD', '', [
    node('SOUR', 'SECERE', [node('VERS', APP_VERSION), node('NAME', 'Secere')]),
    node('DATE', new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase().replace(/,/g, '')),
    node('GEDC', '', [node('VERS', '5.5.1'), node('FORM', 'LINEAGE-LINKED')]),
    node('CHAR', 'UTF-8'),
    node('LANG', 'en'),
    node('_TREE', tree.meta.name || 'Secere export'),
  ]);

  const records: GdNode[] = [head];
  const sorted = [...tree.persons].sort((a, b) => a.id.localeCompare(b.id));
  for (const person of sorted) records.push(...personNodes(tree, person, mediaIds));
  for (const union of tree.unions) records.push(...unionNodes(tree, union, mediaIds));

  for (const source of tree.sources) {
    const kids: GdNode[] = [];
    if (source.author) kids.push(node('AUTH', source.author));
    if (source.publication) kids.push(node('PUBL', source.publication));
    if (source.repository) kids.push(node('REPO', source.repository));
    if (source.note) kids.push(node('NOTE', source.note));
    for (const id of source.mediaIds) {
      if (mediaIds.has(id)) kids.push(node('OBJE', `@${id}@`));
    }
    records.push(node('SOUR', source.title, kids, source.id));
  }

  if (opts.includeMediaRecords) {
    records.push(...mediaRecordNodes(tree, opts));
  }

  return serializeGedcomTree(relevel(records, 0));
}
