import { describe, expect, it } from 'vitest';
import { buildBundle, mergeTrees, planBundle, readBundle, relinkMedia, sha256Hex } from './bundle';
import { parseGedcomDate } from './date';
import { readGedcom } from './gedcom/read';
import { writeGedcom } from './gedcom/write';
import { message } from './i18n';
import type { Msg } from './i18n';
import { createSampleTree } from './sample';
import { defaultCriteria, extractSubset } from './subset';
import type { SubsetCriteria } from './subset';

async function sample() {
  return createSampleTree();
}

function criteria(overrides: Partial<SubsetCriteria> = {}): SubsetCriteria {
  return { ...defaultCriteria(), ...overrides };
}

/** Warnings are message keys; the tests read them back as English prose. */
const said = (msgs: Msg[]): string => msgs.map((msg) => message('en', msg)).join(' ');

describe('GEDCOM round trip', () => {
  it('preserves people, families, sources and media through write -> read', async () => {
    const { tree } = await sample();
    const ged = writeGedcom(tree);
    const { tree: back, warnings } = readGedcom(ged);

    expect(warnings.filter((w) => w.key.startsWith('warn.'))).toEqual([]);
    expect(back.persons).toHaveLength(tree.persons.length);
    expect(back.unions).toHaveLength(tree.unions.length);
    expect(back.sources).toHaveLength(tree.sources.length);
    expect(back.media).toHaveLength(tree.media.length);

    const thomas = back.persons.find((p) => p.id === 'I1')!;
    expect(thomas.names[0].given).toBe('Thomas');
    expect(thomas.names[0].surname).toBe('Keane');
    expect(thomas.events.find((e) => e.type === 'BIRT')?.date?.raw).toBe('ABT 1841');
    expect(thomas.events.find((e) => e.type === 'BIRT')?.place).toBe('Listowel, Co. Kerry, Ireland');

    const family = back.unions.find((u) => u.id === 'F1')!;
    expect(family.partnerIds.sort()).toEqual(['I1', 'I2']);
    expect(family.childIds.sort()).toEqual(['I3', 'I4', 'I5', 'I6']);
  });

  it('keeps the applied adoption pedigree', async () => {
    const { tree } = await sample();
    const back = readGedcom(writeGedcom(tree)).tree;
    const union = back.unions.find((u) => u.id === 'F8')!;
    expect(union.childIds).toEqual(['I16']);
    expect(union.childLinks?.I16.pedigree).toBe('adopted');
  });

  it('is stable: a second round trip produces the same file', async () => {
    const { tree } = await sample();
    const first = writeGedcom(tree);
    const second = writeGedcom(readGedcom(first).tree);
    expect(second).toBe(first);
  });

  it('parses continuation lines and date ranges', () => {
    const ged = [
      '0 HEAD',
      '1 CHAR UTF-8',
      '0 @I9@ INDI',
      '1 NAME Nora /Sheehy/',
      '1 NOTE first line',
      '2 CONT second line',
      '2 CONC  appended',
      '1 MARR',
      '2 DATE BET 1903 AND 1904',
      '0 TRLR',
      '',
    ].join('\n');
    const { tree } = readGedcom(ged);
    const nora = tree.persons[0];
    expect(nora.notes[0].body).toBe('first line\nsecond line appended');
    expect(nora.events[0].date?.qualifier).toBe('between');
    expect(nora.events[0].date?.from).toBe('1903');
    expect(nora.events[0].date?.to).toBe('1904');
  });

  it('round trips a date expression verbatim', () => {
    const parsed = parseGedcomDate('BEF 12 MAR 1912');
    expect(parsed.qualifier).toBe('before');
    expect(parsed.to).toBe('1912-03-12');
    expect(parsed.raw).toBe('BEF 12 MAR 1912');
  });
});

describe('slice selection', () => {
  it('walks ancestors from a root person and prunes collaterals', async () => {
    const { tree } = await sample();
    const result = extractSubset(tree, criteria({
      roots: ['I17'],
      ancestors: 4,
      descendants: 0,
      includeSpouses: false,
      boundary: 'prune',
    }));
    const ids = result.tree.persons.map((p) => p.id);
    expect(ids).toContain('I17');
    expect(ids).toContain('I13');
    expect(ids).toContain('I9');
    expect(ids).toContain('I3');
    expect(ids).toContain('I1');
    expect(ids).not.toContain('I4'); // aunt: not on the ancestor path
  });

  it('stub policy keeps the same topology but only as placeholders', async () => {
    const { tree } = await sample();
    const result = extractSubset(tree, criteria({
      roots: ['I17'],
      ancestors: 3,
      descendants: 0,
      includeSpouses: false,
      boundary: 'stub',
    }));
    const aunt = result.tree.persons.find((p) => p.id === 'I4');
    expect(aunt?.isStub).toBe(true);
    expect(aunt?.events).toHaveLength(0);
  });

  it('walks descendants and stops at the requested depth', async () => {
    const { tree } = await sample();
    const result = extractSubset(tree, criteria({
      roots: ['I1'],
      ancestors: 0,
      descendants: 1,
      includeSpouses: false,
      boundary: 'prune',
    }));
    const ids = result.tree.persons.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['I1', 'I3', 'I4', 'I5', 'I6']));
    expect(ids).not.toContain('I9');
  });

  it('filters a global query by birth year window', async () => {
    const { tree } = await sample();
    const result = extractSubset(tree, criteria({
      roots: [],
      ancestors: 0,
      descendants: 0,
      includeSpouses: false,
      boundary: 'prune',
      redactLiving: false,
      filters: { bornFrom: 1930, bornTo: 1945 },
    }));
    for (const person of result.tree.persons) {
      const birth = person.events.find((e) => e.type === 'BIRT');
      expect(birth?.date?.from?.slice(0, 4)).toMatch(/^19(3[0-9]|4[0-5])$/);
    }
    expect(result.tree.persons.length).toBeGreaterThan(0);
  });

  it('redacts living people by default and leaves the deceased alone', async () => {
    const { tree } = await sample();
    const result = extractSubset(tree, criteria({ roots: ['I1'], ancestors: 0, descendants: 5, includeSpouses: true }));

    const aoife = result.tree.persons.find((p) => p.id === 'I21')!;
    expect(aoife.redacted).toBe(true);
    expect(aoife.names[0].given).toBe('[Living]');
    expect(aoife.events).toHaveLength(0);

    const thomas = result.tree.persons.find((p) => p.id === 'I1')!;
    expect(thomas.redacted).toBeUndefined();
    expect(thomas.names[0].given).toBe('Thomas');
  });

  it('never emits a reference to a person outside a pruned slice', async () => {
    const { tree } = await sample();
    for (const boundary of ['prune', 'stub'] as const) {
      const result = extractSubset(tree, criteria({
        roots: ['I17'],
        ancestors: 2,
        descendants: 0,
        includeSpouses: false,
        collateral: 0,
        boundary,
      }));
      const ids = new Set(result.tree.persons.map((p) => p.id));
      for (const union of result.tree.unions) {
        for (const id of [...union.partnerIds, ...union.childIds]) {
          expect(ids.has(id)).toBe(true);
        }
      }
    }
  });

  it('stubs the boundary instead of dropping the link', async () => {
    const { tree } = await sample();
    const result = extractSubset(tree, criteria({
      roots: ['I13'],
      ancestors: 0,
      descendants: 0,
      includeSpouses: false,
      boundary: 'stub',
    }));
    expect(result.stats.stubs).toBeGreaterThan(0);
    const stub = result.tree.persons.find((p) => p.isStub);
    expect(stub).toBeDefined();
    expect(stub!.events).toHaveLength(0);
  });

  it('keeps nuclear families intact under the include policy', async () => {
    const { tree } = await sample();
    const result = extractSubset(tree, criteria({
      roots: ['I13'],
      ancestors: 0,
      descendants: 0,
      includeSpouses: false,
      boundary: 'include',
    }));
    const ids = result.tree.persons.map((p) => p.id);
    expect(ids).toContain('I15'); // spouse
    expect(ids).toContain('I17'); // child
    expect(ids).not.toContain('I21'); // grandchild: one hop only
  });

  it('drops private media and private notes unless asked otherwise', async () => {
    const { tree } = await sample();
    const result = extractSubset(tree, criteria({ roots: ['I13'], descendants: 0, includeSpouses: true }));
    const michael = result.tree.persons.find((p) => p.id === 'I13')!;
    expect(michael.notes.every((n) => !n.isPrivate)).toBe(true);
    expect(result.tree.media.some((m) => m.id === 'M13')).toBe(false);
  });
});

describe('bundles and media', () => {
  it('exports facts only: full media index, zero image bytes', async () => {
    const { tree, blobs } = await sample();
    const plan = planBundle(tree, criteria({ roots: ['I1'], descendants: 4, media: 'none' }), blobs);
    const built = await buildBundle(plan, blobs);

    expect(built.manifest.media.referenced).toBeGreaterThan(0);
    expect(built.manifest.media.included).toBe(0);
    expect(built.manifest.media.complete).toBe(false);
    expect(built.manifest.files.map((f) => f.path)).toEqual(['data.json']);

    const reopened = await readBundle(built.zip);
    expect(reopened.tree.media.length).toBe(plan.slice.media.length);
    expect(reopened.mediaIncluded).toBe(0);
    expect(reopened.mediaMissing).toBe(reopened.tree.media.length);
    expect(said(reopened.warnings)).toContain('image files not shipped');
  });

  it('a facts-only bundle is small and its manifest explains the gap', async () => {
    const { tree, blobs } = await sample();
    const plan = planBundle(tree, criteria({ roots: ['I1'], descendants: 5, media: 'none' }), blobs);
    const built = await buildBundle(plan, blobs);
    // The whole 23-person tree with media references, compressed, is tiny.
    expect(built.zip.length).toBeLessThan(200_000);
    expect(built.manifest.media.bytesReferenced).toBeGreaterThan(10_000_000);
  });

  it('thumbnails mode ships one file per unique thumbnail and dedupes by hash', async () => {
    const { tree, blobs } = await sample();
    const plan = planBundle(tree, criteria({ roots: ['I1'], descendants: 5, media: 'thumbs' }), blobs);
    const built = await buildBundle(plan, blobs);

    const mediaFiles = built.manifest.files.filter((f) => f.path.startsWith('thumbs/'));
    expect(mediaFiles.length).toBe(plan.slice.media.length);
    expect(new Set(mediaFiles.map((f) => f.sha256)).size).toBe(mediaFiles.length);
    // Thumbs are kilobytes, not megabytes.
    expect(built.manifest.media.bytesIncluded).toBeLessThan(built.manifest.media.bytesReferenced / 100);

    const reopened = await readBundle(built.zip);
    expect(reopened.mediaIncluded).toBeGreaterThan(0);
    expect(reopened.mediaMissing).toBe(0);
  });

  it('detects a tampered media file by checksum', async () => {
    const JSZip = (await import('jszip')).default;
    const { tree, blobs } = await sample();
    const plan = planBundle(tree, criteria({ roots: ['I1'], descendants: 2, media: 'thumbs' }), blobs);
    const built = await buildBundle(plan, blobs);

    const zip = await JSZip.loadAsync(built.zip);
    const firstMedia = built.manifest.files.find((f) => f.path.startsWith('thumbs/'))!.path;
    zip.file(firstMedia, new TextEncoder().encode('<svg>tampered</svg>'));

    const reopened = await readBundle(await zip.generateAsync({ type: 'uint8array' }));
    expect(said(reopened.warnings)).toContain('failed its checksum');
  });

  it('relinks media by content hash from files the user already has', async () => {
    const { tree } = await sample();
    const ref = tree.media[0];
    const bytes = new TextEncoder().encode('pretend this is the original photo');
    const hash = await sha256Hex(bytes);
    const treeWithHash = {
      ...tree,
      media: [{ ...ref, sha256: hash }],
    };

    const result = await relinkMedia(treeWithHash, [{ name: 'IMG_0042.JPG', bytes }], new Map());
    expect(result.relinked).toBe(1);
    expect(result.blobs.has(hash)).toBe(true);
    expect(result.unmatched).toEqual([]);
  });

  it('is idempotent when the same bundle is imported twice', async () => {
    const { tree, blobs } = await sample();
    const plan = planBundle(tree, criteria({ roots: ['I13'], descendants: 2, media: 'thumbs' }), blobs);
    const built = await buildBundle(plan, blobs);
    const first = await readBundle(built.zip);

    const merged = mergeTrees(tree, first.tree);
    expect(merged.report.addedPersons).toBe(0);
    expect(merged.report.addedUnions).toBe(0);
    expect(merged.tree.persons).toHaveLength(tree.persons.length);

    const empty = { ...tree, persons: [], unions: [], sources: [], media: [] };
    const grown = mergeTrees(empty, first.tree);
    expect(grown.report.addedPersons).toBe(plan.slice.persons.length);
    expect(grown.tree.persons).toHaveLength(plan.slice.persons.length);
  });
});

describe('GEDCOM event values', () => {
  // Most of a GEDCOM fact lives on the tag line itself: `1 OCCU Creamery
  // manager`. Dropping it imported the occupation without the occupation.
  const read = () =>
    readGedcom(
      [
        '0 HEAD',
        '1 CHAR UTF-8',
        '0 @I1@ INDI',
        '1 NAME Michael /Keane/',
        '1 SEX M',
        '1 OCCU Creamery manager',
        '1 RESI',
        '2 PLAC Dublin',
        '0 TRLR',
        '',
      ].join('\n'),
    );

  it('keeps the text written on the event line', () => {
    const { tree } = read();
    const occupation = tree.persons[0].events.find((e) => e.type === 'OCCU');

    expect(occupation?.value).toBe('Creamery manager');
  });

  it('does not mistake a bare assertion for text', () => {
    const { tree } = read();
    const residence = tree.persons[0].events.find((e) => e.type === 'RESI');

    expect(residence?.value).toBeUndefined();
  });

  it('writes the value back on the tag line, so a round trip is byte-identical', () => {
    const { tree } = read();
    const ged = writeGedcom(tree);

    expect(ged).toContain('1 OCCU Creamery manager');
    expect(writeGedcom(readGedcom(ged).tree)).toBe(ged);
  });
});
