import { describe, expect, it } from 'vitest';
import { createTestRepo, DriverStub } from './persistence-store';
import { emptyTree } from './types';

describe('SqliteRepo projection', () => {
  it('round-trips an empty tree through a real Driver shape', async () => {
    const repo = createTestRepo(DriverStub);
    const loaded = await repo.load();
    expect(loaded.tree.meta.name).toBe('Secere');
    expect(loaded.blobs.size).toBe(0);
  });

  it('persists and reloads a tree with media blobs', async () => {
    const repo = createTestRepo(DriverStub);
    const tree = emptyTree('Test');
    const blobs = new Map<string, { bytes: Uint8Array; mime: string }>();
    blobs.set('sha1', { bytes: new TextEncoder().encode('blob-a'), mime: 'text/plain' });
    blobs.set('sha2', { bytes: new TextEncoder().encode('blob-b'), mime: 'text/plain' });

    await repo.save(tree, blobs);
    const loaded = await repo.load();

    expect(loaded.tree.meta.name).toBe('Test');
    expect(loaded.tree.persons).toEqual(tree.persons);
    expect(loaded.tree.unions).toEqual(tree.unions);
    expect(loaded.tree.sources).toEqual(tree.sources);
    expect(loaded.tree.media).toEqual(tree.media);
    expect(loaded.blobs.size).toBe(2);
    expect(loaded.blobs.get('sha1')?.bytes).toEqual(new TextEncoder().encode('blob-a'));
    expect(loaded.blobs.get('sha2')?.mime).toBe('text/plain');
  });

  it('replaces media on save so stale blobs are gone', async () => {
    const repo = createTestRepo(DriverStub);
    await repo.save(emptyTree('Secere'), new Map([['old', { bytes: new Uint8Array(0), mime: 'image/jpeg' }]]));
    await repo.save(emptyTree('Secere'), new Map([['new', { bytes: new Uint8Array(1), mime: 'image/png' }]]));
    const loaded = await repo.load();
    expect(loaded.blobs.size).toBe(1);
    expect(loaded.blobs.has('old')).toBe(false);
    expect(loaded.blobs.has('new')).toBe(true);
  });
});
