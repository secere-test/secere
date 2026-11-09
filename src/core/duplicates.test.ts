import { describe, expect, it } from 'vitest';
import { editDistance, findDuplicatePairs, mergePersons, normaliseName, scorePair } from './duplicates';
import { message } from './i18n';
import type { Msg } from './i18n';
import type { Event, ID, Person, Sex, TreeData, Union } from './types';

/** Reasons and conflicts are message keys; read them back as English prose. */
const said = (msgs: Msg[]): string => msgs.map((msg) => message('en', msg)).join(' ');

function person(
  id: ID,
  given: string,
  surname: string,
  opts: { sex?: Sex; born?: string; died?: string; place?: string } = {},
): Person {
  const events: Event[] = [];
  if (opts.born) {
    events.push({
      id: `E-${id}-b`,
      type: 'BIRT',
      date: { raw: opts.born, qualifier: 'exact', from: opts.born, to: opts.born },
      place: opts.place,
      certainty: 'certain',
    });
  }
  if (opts.died) {
    events.push({
      id: `E-${id}-d`,
      type: 'DEAT',
      date: { raw: opts.died, qualifier: 'exact', from: opts.died, to: opts.died },
      certainty: 'certain',
    });
  }
  return {
    id,
    sex: opts.sex ?? 'U',
    names: [{ id: `N-${id}`, given, surname, type: 'birth' }],
    events,
    notes: [],
    citations: [],
    mediaIds: [],
    tags: [],
    privacy: 'public',
  };
}

function union(id: ID, partnerIds: ID[], childIds: ID[] = []): Union {
  return { id, partnerIds, events: [], childIds, citations: [], notes: [], mediaIds: [] };
}

function treeOf(persons: Person[], unions: Union[] = []): TreeData {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    meta: { id: 'tree-test', name: 'Test', createdAt: now, updatedAt: now, schemaVersion: 1, appVersion: '0.3.0' },
    persons,
    unions,
    sources: [],
    media: [],
  };
}

function dangling(tree: TreeData): string[] {
  const ids = new Set(tree.persons.map((p) => p.id));
  const bad: string[] = [];
  for (const u of tree.unions) {
    for (const id of [...u.partnerIds, ...u.childIds]) if (!ids.has(id)) bad.push(`${u.id}:${id}`);
  }
  return bad;
}

describe('name normalisation', () => {
  it('folds accents, case and punctuation', () => {
    expect(normaliseName('Ní Bhriain')).toBe('ni bhriain');
    expect(normaliseName("O'Connor")).toBe('o connor');
    expect(normaliseName('  Mary   Ann ')).toBe('mary ann');
  });

  it('measures typos in characters', () => {
    expect(editDistance('keane', 'keane')).toBe(0);
    expect(editDistance('keane', 'kean')).toBe(1);
    expect(editDistance('cathrine', 'catherine')).toBe(1);
    expect(editDistance('keane', 'brennan')).toBeGreaterThan(3);
  });
});

describe('pair scoring', () => {
  it('rates an exact name with a matching birth year as strong', () => {
    const a = person('A', 'Michael', 'Keane', { sex: 'M', born: '1935' });
    const b = person('B', 'Michael', 'Keane', { sex: 'M', born: '1935', place: 'Listowel' });
    const result = scorePair(a, b, false);

    expect(result.score).toBeGreaterThan(0.85);
    expect(said(result.reasons)).toContain('identical name');
    expect(result.reasons).toEqual(
      expect.arrayContaining([{ key: 'dup.sameBirthYear', params: { year: 1935 } }]),
    );
  });

  it('keeps a spelling variant above the candidate threshold when the dates agree', () => {
    const a = person('A', 'Cathrine', 'Keane', { sex: 'F', born: '1876', died: '1961' });
    const b = person('B', 'Catherine', 'Keane', { sex: 'F', born: '1876', died: '1961' });
    const result = scorePair(a, b, false);

    expect(result.score).toBeGreaterThanOrEqual(0.65);
    expect(said(result.reasons)).toContain('name differs only in spelling');
  });

  it('rules out two people born a generation apart, whatever the name says', () => {
    const a = person('A', 'Mary', 'Keane', { sex: 'F', born: '1876' });
    const b = person('B', 'Mary', 'Keane', { sex: 'F', born: '1908' });
    const result = scorePair(a, b, false);

    expect(result.score).toBeLessThan(0.4);
    expect(result.reasons.map((r) => r.key)).toContain('dup.birthYearsGap');
  });

  it('treats a sex mismatch as a different person', () => {
    const a = person('A', 'Michael', 'Keane', { sex: 'M', born: '1935' });
    const b = person('B', 'Michael', 'Keane', { sex: 'F', born: '1935' });
    expect(scorePair(a, b, false).score).toBeLessThan(0.5);
  });

  it('treats missing dates as absent evidence, not contrary evidence', () => {
    const a = person('A', 'Alice', 'Brennan', { sex: 'F' });
    const b = person('B', 'Alice', 'Brennan', { sex: 'F' });
    expect(scorePair(a, b, false).score).toBeGreaterThan(0.65);
  });

  it('adds weight for shared parents', () => {
    const a = person('A', 'Anne', 'Keane', { sex: 'F', born: '1938' });
    const b = person('B', 'Anne', 'Keane', { sex: 'F', born: '1938' });
    expect(scorePair(a, b, true).score).toBeGreaterThan(scorePair(a, b, false).score);
    expect(said(scorePair(a, b, true).reasons)).toContain('same parents');
  });
});

describe('finding duplicates', () => {
  it('finds the same person imported twice and orders by strength', () => {
    const tree = treeOf([
      person('I13', 'Michael', 'Keane', { sex: 'M', born: '1935' }),
      person('X1', 'Michael', 'Keane', { sex: 'M', born: '1935' }),
      person('X2', 'Cathrine', 'Keane', { sex: 'F', born: '1876', died: '1961' }),
      person('X3', 'Catherine', 'Keane', { sex: 'F', born: '1876', died: '1961' }),
      person('X4', 'Mark', 'Casey', { sex: 'M', born: '1965' }),
    ]);

    const pairs = findDuplicatePairs(tree);
    const keys = pairs.map((pair) => [pair.a.id, pair.b.id].sort().join('+'));

    expect(keys).toEqual(expect.arrayContaining(['I13+X1', 'X2+X3']));
    expect(pairs).toHaveLength(2);
    expect(pairs[0].score).toBeGreaterThanOrEqual(pairs[1].score);
  });

  it('skips people the tree already says are distinct', () => {
    // A father and his son who share a name are not a merge candidate, and
    // neither are two partners.
    const tree = treeOf(
      [
        person('P', 'James', 'Keane', { sex: 'M' }),
        person('C', 'James', 'Keane', { sex: 'M' }),
        person('W', 'Alice', 'Brennan', { sex: 'F' }),
      ],
      [union('U1', ['P', 'W'], ['C']), union('U2', ['P', 'W'], [])],
    );

    const ids = findDuplicatePairs(tree).map((pair) => [pair.a.id, pair.b.id].sort().join('+'));
    expect(ids).not.toContain('C+P');
    expect(ids).not.toContain('P+W');
  });

  it('ignores stubs, the score floor and the limit', () => {
    const stub = { ...person('S', 'Michael', 'Keane', { sex: 'M', born: '1935' }), isStub: true };
    const tree = treeOf([person('I13', 'Michael', 'Keane', { sex: 'M', born: '1935' }), stub]);

    expect(findDuplicatePairs(tree)).toHaveLength(0);
    expect(findDuplicatePairs(tree, { minScore: 0.95 })).toHaveLength(0);
    expect(findDuplicatePairs(treeOf([
      person('A', 'Ann', 'Keane', { sex: 'F' }),
      person('B', 'Ann', 'Keane', { sex: 'F' }),
      person('C', 'Ann', 'Keane', { sex: 'F' }),
    ]), { limit: 1 })).toHaveLength(1);
  });
});

describe('merging records', () => {
  it('folds one record into the other and leaves no dangling links', () => {
    const tree = treeOf(
      [
        person('I13', 'Michael', 'Keane', { sex: 'M', born: '1935' }),
        person('X1', 'Michael', 'Keane', { sex: 'M', born: '1935', place: 'Listowel' }),
        person('I11', 'Alice', 'Brennan', { sex: 'F', born: '1940' }),
        person('KID', 'Sean', 'Keane', { sex: 'M', born: '1964' }),
      ],
      [union('U1', ['I13', 'I11'], ['KID'])],
    );
    tree.persons[1].mediaIds = ['M1'];
    tree.persons[0].mediaIds = ['M1'];

    const summary = mergePersons(tree, 'I13', 'X1');

    expect(summary.tree.persons.map((p) => p.id).sort()).toEqual(['I11', 'I13', 'KID']);
    expect(summary.movedEvents).toBe(1); // the birth place came across
    expect(summary.movedMedia).toBe(0); // already referenced, not duplicated
    expect(dangling(summary.tree)).toEqual([]);
    expect(summary.tree.persons.find((p) => p.id === 'I13')?.events).toHaveLength(1);
  });

  it('keeps a second name as an alternate name', () => {
    const tree = treeOf([
      person('A', 'Mary', 'Keane', { sex: 'F', born: '1876' }),
      { ...person('B', 'Mary', 'Sullivan', { sex: 'F', born: '1876' }), names: [{ id: 'N-B', given: 'Mary', surname: 'Sullivan', type: 'married' as const }] },
    ]);

    const merged = mergePersons(tree, 'A', 'B').tree.persons[0];
    expect(merged.names).toHaveLength(2);
    expect(merged.names[1].surname).toBe('Sullivan');
    expect(merged.names[1].type).toBe('married');
  });

  it('collapses the two families the duplicate belonged to', () => {
    const tree = treeOf(
      [
        person('I13', 'Michael', 'Keane', { sex: 'M', born: '1935' }),
        person('X1', 'Michael', 'Keane', { sex: 'M', born: '1935' }),
        person('W', 'Alice', 'Brennan', { sex: 'F', born: '1940' }),
        person('K1', 'Sean', 'Keane', { sex: 'M', born: '1964' }),
        person('K2', 'Deirdre', 'Keane', { sex: 'F', born: '1967' }),
      ],
      // The same couple, entered once per record, each with one child.
      [union('U1', ['I13', 'W'], ['K1']), union('U2', ['X1', 'W'], ['K2'])],
    );

    const summary = mergePersons(tree, 'I13', 'X1');

    expect(summary.tree.unions).toHaveLength(1);
    expect(summary.tree.unions[0].partnerIds.sort()).toEqual(['I13', 'W']);
    expect(summary.tree.unions[0].childIds.sort()).toEqual(['K1', 'K2']);
    expect(summary.collapsedUnions).toBe(1);
    expect(summary.movedChildren).toBe(1);
    expect(dangling(summary.tree)).toEqual([]);
  });

  it('does not collapse separate families that have no partners recorded', () => {
    const tree = treeOf(
      [person('A', 'A', 'Keane'), person('B', 'B', 'Keane'), person('C', 'C', 'Keane')],
      [union('U1', [], ['A']), union('U2', [], ['B'])],
    );
    expect(mergePersons(tree, 'A', 'C').tree.unions).toHaveLength(2);
  });

  it('reads "2 FEB 1935" and "1935" as one fact, keeping the precise date', () => {
    const precise = person('A', 'Michael', 'Keane', { sex: 'M', born: '1935' });
    precise.events[0].date = { raw: '2 FEB 1935', qualifier: 'exact', from: '1935-02-02', to: '1935-02-02' };
    const coarse = person('B', 'Michael', 'Keane', { sex: 'M', born: '1935' });

    const summary = mergePersons(treeOf([precise, coarse]), 'A', 'B');
    const events = summary.tree.persons[0].events;

    expect(events).toHaveLength(1);
    expect(summary.conflicts).toEqual([]);
    // The keeper had only a year; the incoming record knows the day.
    expect(events[0].date?.raw).toBe('2 FEB 1935');
  });

  it('keeps two different undated facts of the same type', () => {
    const a = person('A', 'Michael', 'Keane', { sex: 'M', born: '1935' });
    a.events.push({ id: 'E-A-occ', type: 'OCCU', label: 'Schoolteacher', certainty: 'certain' });
    const b = person('B', 'Michael', 'Keane', { sex: 'M', born: '1935' });
    b.events.push({ id: 'E-B-occ', type: 'OCCU', label: 'Creamery manager', certainty: 'certain' });

    const summary = mergePersons(treeOf([a, b]), 'A', 'B');
    const occupations = summary.tree.persons[0].events.filter((e) => e.type === 'OCCU');

    expect(occupations.map((e) => e.label)).toEqual(['Schoolteacher', 'Creamery manager']);
    expect(summary.conflicts).toEqual([]);
  });

  it('keeps both dates when the two records disagree, and says so', () => {
    const tree = treeOf([
      person('A', 'Michael', 'Keane', { sex: 'M', born: '1935' }),
      person('B', 'Michael', 'Keane', { sex: 'M', born: '1936' }),
    ]);

    const summary = mergePersons(tree, 'A', 'B');
    const events = summary.tree.persons[0].events;

    expect(events).toHaveLength(2);
    expect(events[1].certainty).toBe('disputed');
    expect(summary.conflicts).toHaveLength(1);
    expect(said(summary.conflicts)).toContain('1935');
  });

  it('refuses to merge a record with itself or with a record that is gone', () => {
    const tree = treeOf([person('A', 'A', 'Keane')]);
    expect(() => mergePersons(tree, 'A', 'A')).toThrow(/itself/);
    expect(() => mergePersons(tree, 'A', 'NOPE')).toThrow(/must exist/);
  });
});

describe('event values', () => {
  // GEDCOM keeps the substance of an attribute on the tag line: `1 OCCU
  // Creamery manager`. Two undated occupations with different text are two
  // facts, and merging must not silently pick one.
  it('keeps both when the two records describe different undated occupations', () => {
    const a = person('A', 'Michael', 'Keane', { sex: 'M', born: '1935' });
    a.events.push({ id: 'E-A', type: 'OCCU', value: 'Schoolteacher', certainty: 'certain' });
    const b = person('B', 'Michael', 'Keane', { sex: 'M', born: '1935' });
    b.events.push({ id: 'E-B', type: 'OCCU', value: 'Creamery manager', certainty: 'certain' });

    const summary = mergePersons(treeOf([a, b]), 'A', 'B');
    const occupations = summary.tree.persons[0].events.filter((e) => e.type === 'OCCU');

    expect(occupations.map((e) => e.value)).toEqual(['Schoolteacher', 'Creamery manager']);
    expect(summary.movedEvents).toBe(1);
  });

  it('takes the text when the keeper is the one without it', () => {
    const a = person('A', 'Michael', 'Keane', { sex: 'M', born: '1935' });
    a.events.push({ id: 'E-A', type: 'OCCU', certainty: 'certain' });
    const b = person('B', 'Michael', 'Keane', { sex: 'M', born: '1935' });
    b.events.push({ id: 'E-B', type: 'OCCU', value: 'Creamery manager', certainty: 'certain' });

    const summary = mergePersons(treeOf([a, b]), 'A', 'B');
    const occupations = summary.tree.persons[0].events.filter((e) => e.type === 'OCCU');

    expect(occupations).toHaveLength(1);
    expect(occupations[0].value).toBe('Creamery manager');
    expect(summary.movedEvents).toBe(1);
  });
});
