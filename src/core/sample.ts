/**
 * A small, realistic sample tree: four generations of a Kerry family, with
 * sources, media, an adoption, a second marriage, living people who must be
 * redacted on export, and one private document.
 *
 * The "pixel data" here is generated SVG placeholders standing in for photos,
 * so the media plumbing (content hashes, thumbnails, missing-blob handling) is
 * exercised for real without shipping binary assets.
 */

import { sha256Hex } from './bundle';
import { parseGedcomDate } from './date';
import type {
  Citation,
  Event,
  ID,
  MediaBlobStore,
  MediaKind,
  MediaRef,
  Person,
  Source,
  TreeData,
  Union,
} from './types';
import { APP_VERSION, SCHEMA_VERSION } from './types';

/**
 * Stable id of the bundled sample tree. The app uses it to tell "the sample is
 * loaded" from "the user imported something", including when the sample was
 * restored from storage on a later visit.
 */
export const SAMPLE_TREE_ID = 'tree-keane';

const SOURCES: Source[] = [
  {
    id: 'S1',
    title: 'Civil birth registers, Listowel district',
    author: 'General Register Office, Ireland',
    publication: '1864–1910',
    repository: 'irishgenealogy.ie',
    mediaIds: [],
  },
  {
    id: 'S2',
    title: '1901 Census of Ireland',
    author: 'National Archives of Ireland',
    publication: 'Listowel, Co. Kerry, DED 42/3',
    mediaIds: [],
  },
  {
    id: 'S3',
    title: 'Grave inscription, Listowel churchyard',
    publication: 'Surveyed on site',
    mediaIds: [],
  },
  {
    id: 'S4',
    title: 'Keane family bible',
    note: 'Held by Michael Keane. Births recorded in a single hand up to 1936.',
    mediaIds: [],
  },
];

function ev(type: string, date?: string, place?: string, extra: Partial<Event> = {}): Event {
  return {
    id: `e-${type}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    date: date ? parseGedcomDate(date) : undefined,
    place,
    certainty: 'certain',
    ...extra,
  };
}

function cite(sourceId: ID, page?: string): Citation {
  return { id: `c-${Math.random().toString(36).slice(2, 8)}`, sourceId, page };
}

interface PersonSpec {
  id: ID;
  sex: 'M' | 'F';
  given: string;
  surname: string;
  events: Event[];
  notes?: Person['notes'];
  tags?: string[];
  mediaIds?: ID[];
  privacy?: Person['privacy'];
  citations?: Citation[];
}

function person(spec: PersonSpec): Person {
  return {
    id: spec.id,
    sex: spec.sex,
    names: [{ id: `n-${spec.id}`, given: spec.given, surname: spec.surname, type: 'birth' }],
    events: spec.events,
    notes: spec.notes ?? [],
    citations: spec.citations ?? [],
    mediaIds: spec.mediaIds ?? [],
    tags: spec.tags ?? [],
    privacy: spec.privacy ?? 'public',
  };
}

function union(id: ID, partners: ID[], children: ID[], events: Event[] = [], extra: Partial<Union> = {}): Union {
  return {
    id,
    partnerIds: partners,
    childIds: children,
    events,
    citations: [],
    notes: [],
    mediaIds: [],
    ...extra,
  };
}

const PEOPLE: Person[] = [
  // Generation 1 ---------------------------------------------------------
  person({
    id: 'I1',
    sex: 'M',
    given: 'Thomas',
    surname: 'Keane',
    events: [
      ev('BIRT', 'ABT 1841', 'Listowel, Co. Kerry, Ireland'),
      ev('OCCU', undefined, 'Listowel, Co. Kerry, Ireland', { value: 'Farmer' }),
      ev('DEAT', '12 MAR 1912', 'Listowel, Co. Kerry, Ireland', { citations: [cite('S3')] }),
      ev('BURI', '15 MAR 1912', 'Listowel churchyard, Co. Kerry, Ireland'),
    ],
    notes: [
      {
        id: 'n1',
        body: 'Farm held at Ballinruddery, 42 acres, inherited from his father. Name recorded as "Kean" in the 1901 census.',
        isPrivate: false,
      },
    ],
    tags: ['kerry'],
    mediaIds: ['M1', 'M4', 'M5'],
  }),
  person({
    id: 'I2',
    sex: 'F',
    given: 'Mary',
    surname: 'Sullivan',
    events: [
      ev('BIRT', '1845', 'Ballylongford, Co. Kerry, Ireland'),
      ev('DEAT', '1901', 'Listowel, Co. Kerry, Ireland'),
    ],
    tags: ['kerry'],
    mediaIds: ['M2'],
  }),

  // Generation 2 ---------------------------------------------------------
  person({
    id: 'I3',
    sex: 'M',
    given: 'Patrick',
    surname: 'Keane',
    events: [
      ev('BIRT', '3 APR 1872', 'Listowel, Co. Kerry, Ireland', { citations: [cite('S1', 'vol. 5, p. 231')] }),
      ev('OCCU', undefined, undefined, { value: 'Clerk, Great Southern Railway' }),
      ev('DEAT', '1954', 'Tralee, Co. Kerry, Ireland'),
    ],
    tags: ['kerry'],
    mediaIds: ['M3', 'M6'],
  }),
  person({
    id: 'I4',
    sex: 'F',
    given: 'Ellen',
    surname: 'Keane',
    events: [ev('BIRT', '1874', 'Listowel, Co. Kerry, Ireland'), ev('DEAT', '1949', 'Cork, Ireland')],
    tags: ['kerry'],
  }),
  person({
    id: 'I5',
    sex: 'M',
    given: 'John',
    surname: 'Keane',
    events: [
      ev('BIRT', '1877', 'Listowel, Co. Kerry, Ireland'),
      ev('DEAT', '1 JUL 1916', 'Thiepval, Somme, France', {
        certainty: 'probable',
        note: 'Listed on the Thiepval Memorial; identity inferred from regiment number.',
      }),
    ],
    tags: ['kerry', 'military'],
  }),
  person({
    id: 'I6',
    sex: 'F',
    given: 'Margaret',
    surname: 'Keane',
    events: [ev('BIRT', '1879', 'Listowel, Co. Kerry, Ireland')],
    tags: ['kerry'],
  }),

  // Generation 2 by marriage ---------------------------------------------
  person({
    id: 'I7',
    sex: 'F',
    given: 'Nora',
    surname: 'Sheehy',
    events: [ev('BIRT', '1878', 'Ballybunion, Co. Kerry, Ireland'), ev('DEAT', '1961', 'Listowel, Co. Kerry, Ireland')],
    mediaIds: ['M7'],
  }),
  person({
    id: 'I8',
    sex: 'F',
    given: 'Bridget',
    surname: 'Nolan',
    events: [ev('BIRT', '1880', 'Athea, Co. Limerick, Ireland')],
  }),

  // Generation 3 ---------------------------------------------------------
  person({
    id: 'I9',
    sex: 'M',
    given: 'James',
    surname: 'Keane',
    events: [
      ev('BIRT', '14 SEP 1905', 'Listowel, Co. Kerry, Ireland'),
      ev('OCCU', undefined, undefined, { value: 'Postman' }),
      ev('DEAT', '1978', 'Listowel, Co. Kerry, Ireland'),
    ],
    mediaIds: ['M8'],
    tags: ['kerry'],
  }),
  person({
    id: 'I10',
    sex: 'F',
    given: 'Catherine',
    surname: 'Keane',
    events: [ev('BIRT', '1908', 'Listowel, Co. Kerry, Ireland'), ev('DEAT', '1992', 'Dublin, Ireland')],
  }),
  person({
    id: 'I11',
    sex: 'F',
    given: 'Alice',
    surname: 'Brennan',
    events: [ev('BIRT', '1910', 'Tralee, Co. Kerry, Ireland'), ev('DEAT', '1990', 'Listowel, Co. Kerry, Ireland')],
  }),
  person({
    id: 'I12',
    sex: 'M',
    given: 'Thomas',
    surname: 'Keane',
    events: [ev('BIRT', '1908', 'Listowel, Co. Kerry, Ireland'), ev('DEAT', '1971', 'London, England')],
    tags: ['emigrant'],
  }),

  // Generation 4 ---------------------------------------------------------
  person({
    id: 'I13',
    sex: 'M',
    given: 'Michael',
    surname: 'Keane',
    events: [
      ev('BIRT', '2 FEB 1935', 'Listowel, Co. Kerry, Ireland'),
      ev('OCCU', undefined, undefined, { value: 'Schoolteacher' }),
    ],
    notes: [
      { id: 'n2', body: 'Holds the family bible (see S4).', isPrivate: false },
      { id: 'n3', body: 'Private: dispute with cousin over the Ballinruddery land.', isPrivate: true },
    ],
    mediaIds: ['M9'],
    tags: ['kerry'],
  }),
  person({
    id: 'I14',
    sex: 'F',
    given: 'Anne',
    surname: 'Keane',
    events: [ev('BIRT', '1938', 'Listowel, Co. Kerry, Ireland')],
    mediaIds: ['M10'],
  }),

  // Generation 4 by marriage ---------------------------------------------
  person({
    id: 'I15',
    sex: 'F',
    given: 'Teresa',
    surname: 'Doyle',
    events: [ev('BIRT', '1940', 'Ballyduff, Co. Kerry, Ireland')],
  }),
  person({
    id: 'I16',
    sex: 'M',
    given: 'Colin',
    surname: 'Hartnett',
    events: [ev('BIRT', '1970', 'Dublin, Ireland')],
    privacy: 'family',
  }),

  // Generation 5 ---------------------------------------------------------
  person({
    id: 'I17',
    sex: 'M',
    given: 'Sean',
    surname: 'Keane',
    events: [ev('BIRT', '1964', 'Dublin, Ireland'), ev('OCCU', undefined, undefined, { value: 'Engineer' })],
    mediaIds: ['M11'],
  }),
  person({
    id: 'I18',
    sex: 'F',
    given: 'Deirdre',
    surname: 'Keane',
    events: [ev('BIRT', '1967', 'Dublin, Ireland')],
  }),
  person({
    id: 'I19',
    sex: 'F',
    given: 'Fiona',
    surname: 'Nolan',
    events: [ev('BIRT', '1968', 'Galway, Ireland')],
  }),
  person({
    id: 'I20',
    sex: 'M',
    given: 'Mark',
    surname: 'Casey',
    events: [ev('BIRT', '1965', 'Cork, Ireland')],
  }),

  // Generation 6 ---------------------------------------------------------
  person({ id: 'I21', sex: 'F', given: 'Aoife', surname: 'Keane', events: [ev('BIRT', '1996', 'Dublin, Ireland')] }),
  person({ id: 'I22', sex: 'M', given: 'Cillian', surname: 'Keane', events: [ev('BIRT', '2000', 'Dublin, Ireland')] }),
  person({ id: 'I23', sex: 'F', given: 'Ruby', surname: 'Casey', events: [ev('BIRT', '2001', 'Cork, Ireland')] }),
];

const UNIONS: Union[] = [
  union('F1', ['I1', 'I2'], ['I3', 'I4', 'I5', 'I6'], [ev('MARR', '1869', 'Listowel, Co. Kerry, Ireland')], {
    mediaIds: ['M12'],
  }),
  union('F2', ['I3', 'I7'], ['I9', 'I10'], [ev('MARR', 'BET 1903 AND 1904', 'Listowel, Co. Kerry, Ireland')], {
    mediaIds: ['M6'],
  }),
  union('F3', ['I5', 'I8'], ['I12'], [ev('MARR', '1906', 'Athea, Co. Limerick, Ireland')]),
  union('F4', ['I9', 'I11'], ['I13', 'I14'], [ev('MARR', '1934', 'Listowel, Co. Kerry, Ireland')]),
  union('F5', ['I13', 'I15'], ['I17', 'I18'], [ev('MARR', '1962', 'Listowel, Co. Kerry, Ireland')]),
  union('F6', ['I17', 'I19'], ['I21', 'I22'], [ev('MARR', '1994', 'Dublin, Ireland')]),
  union('F7', ['I18', 'I20'], ['I23'], [ev('MARR', '1999', 'Cork, Ireland')]),
  // Single known parent, adopted child: the graph model has to allow both.
  union('F8', ['I14'], ['I16'], [], {
    childLinks: { I16: { pedigree: 'adopted', certainty: 'certain' } },
  }),
];

interface MediaSpec {
  id: ID;
  caption: string;
  kind: MediaKind;
  originalBytes: number;
  mime: string;
  hue: number;
  label: string;
  privacy?: MediaRef['privacy'];
}

const MEDIA_SPECS: MediaSpec[] = [
  { id: 'M1', caption: 'Thomas Keane, c. 1900', kind: 'photo', originalBytes: 2_310_144, mime: 'image/jpeg', hue: 28, label: 'TK' },
  { id: 'M2', caption: 'Mary (Sullivan) Keane', kind: 'photo', originalBytes: 1_984_512, mime: 'image/jpeg', hue: 340, label: 'MK' },
  { id: 'M3', caption: 'Patrick Keane in railway uniform', kind: 'photo', originalBytes: 3_145_728, mime: 'image/jpeg', hue: 205, label: 'PK' },
  { id: 'M4', caption: '1901 census return, Listowel', kind: 'document', originalBytes: 5_242_880, mime: 'image/jpeg', hue: 45, label: '1901' },
  { id: 'M5', caption: 'Keane grave, Listowel churchyard', kind: 'headstone', originalBytes: 4_194_304, mime: 'image/jpeg', hue: 120, label: 'KG' },
  { id: 'M6', caption: 'Wedding of Patrick Keane and Nora Sheehy, 1903', kind: 'photo', originalBytes: 2_621_440, mime: 'image/jpeg', hue: 265, label: 'W1903' },
  { id: 'M7', caption: 'Nora (Sheehy) Keane', kind: 'photo', originalBytes: 1_572_864, mime: 'image/jpeg', hue: 15, label: 'NS' },
  { id: 'M8', caption: 'James Keane, 1930s', kind: 'photo', originalBytes: 1_048_576, mime: 'image/jpeg', hue: 190, label: 'JK' },
  { id: 'M9', caption: 'Michael Keane, 1960', kind: 'photo', originalBytes: 2_097_152, mime: 'image/jpeg', hue: 100, label: 'MK2' },
  { id: 'M10', caption: 'Anne Keane, 1965', kind: 'photo', originalBytes: 1_835_008, mime: 'image/jpeg', hue: 310, label: 'AK' },
  { id: 'M11', caption: 'Sean Keane, 2019', kind: 'photo', originalBytes: 4_718_592, mime: 'image/jpeg', hue: 230, label: 'SK' },
  { id: 'M12', caption: 'Keane family gathering, 1911', kind: 'photo', originalBytes: 6_291_456, mime: 'image/jpeg', hue: 60, label: 'F1911' },
  {
    id: 'M13',
    caption: 'Land deed, Ballinruddery (private)',
    kind: 'document',
    originalBytes: 8_388_608,
    mime: 'application/pdf',
    hue: 0,
    label: 'DEED',
    privacy: 'private',
  },
];

function placeholderSvg(label: string, hue: number, width = 240, height = 300): Uint8Array {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="hsl(${hue} 28% 82%)"/><stop offset="1" stop-color="hsl(${hue} 32% 52%)"/>
</linearGradient></defs>
<rect width="${width}" height="${height}" fill="url(#g)"/>
<circle cx="${width / 2}" cy="${height * 0.38}" r="${width * 0.19}" fill="hsl(${hue} 20% 96%)" opacity="0.85"/>
<path d="M${width * 0.18} ${height} q ${width * 0.32} -${height * 0.42} ${width * 0.64} 0 z" fill="hsl(${hue} 20% 96%)" opacity="0.85"/>
<text x="${width / 2}" y="${height * 0.9}" text-anchor="middle" font-family="Georgia,serif" font-size="${width * 0.13}" fill="hsl(${hue} 45% 22%)" opacity="0.9">${label}</text>
</svg>`;
  return new TextEncoder().encode(svg);
}

function placeholderThumbSvg(label: string, hue: number, kind: MediaKind): Uint8Array {
  if (kind === 'document') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="260" viewBox="0 0 200 260">
<rect width="200" height="260" fill="#f6f1e6"/><rect x="0" y="0" width="200" height="18" fill="hsl(${hue} 30% 60%)"/>
${Array.from({ length: 11 }, (_, i) => `<rect x="18" y="${44 + i * 17}" width="${120 + ((i * 37) % 50)}" height="5" rx="2" fill="#c9bda6"/>`).join('')}
<text x="100" y="246" text-anchor="middle" font-family="Georgia,serif" font-size="13" fill="#8a7c62">${label}</text></svg>`;
    return new TextEncoder().encode(svg);
  }
  return placeholderSvg(label, hue, 200, 260);
}

export interface SampleTree {
  tree: TreeData;
  blobs: MediaBlobStore;
}

export async function createSampleTree(): Promise<SampleTree> {
  const blobs: MediaBlobStore = new Map();
  const media: MediaRef[] = [];

  for (const spec of MEDIA_SPECS) {
    const thumb = placeholderThumbSvg(spec.label, spec.hue, spec.kind);
    const thumbSha = await sha256Hex(thumb);
    blobs.set(thumbSha, { bytes: thumb, mime: 'image/svg+xml' });

    // Originals deliberately are *not* in the local store: this is exactly the
    // situation the media-index design exists for (index known, pixels absent).
    const originalSha = await sha256Hex(placeholderSvg(`${spec.label}-full`, spec.hue, 1200, 1500));

    media.push({
      id: spec.id,
      sha256: originalSha,
      mime: spec.mime,
      bytes: spec.originalBytes,
      filename: `${spec.id.toLowerCase()}-${spec.label.toLowerCase()}.${spec.mime === 'application/pdf' ? 'pdf' : 'jpg'}`,
      caption: spec.caption,
      title: spec.caption,
      kind: spec.kind,
      privacy: spec.privacy ?? 'public',
      thumbSha256: thumbSha,
      thumbMime: 'image/svg+xml',
      thumbBytes: thumb.length,
    });
  }

  const now = new Date().toISOString();
  const tree: TreeData = {
    meta: {
      id: SAMPLE_TREE_ID,
      name: 'Keane of Listowel',
      createdAt: now,
      updatedAt: now,
      schemaVersion: SCHEMA_VERSION,
      appVersion: APP_VERSION,
    },
    persons: PEOPLE.map((p) => ({ ...p })),
    unions: UNIONS.map((u) => ({ ...u })),
    sources: SOURCES.map((s) => ({ ...s })),
    media,
  };

  return { tree, blobs };
}
