/* eslint-disable @typescript-eslint/no-explicit-any */
import type { MediaBlobStore, TreeData } from './types';
import { emptyTree } from './types';

export const AppKey = 'secere-state-v1';
export const StorageBackend = 'local';
export const StorageBackendFile = 'secere.sqlite';

export async function loadSaved(): Promise<MediaBlobStore> {
  const loaded = await repo.load();
  return loaded.blobs;
}

export function saveState(tree: TreeData, blobs: MediaBlobStore): void {
  void repo.save(tree, blobs).catch(() => {/* best-effort */});
}export interface Driver {
  exec(sql: string): Promise<void>;
  prepare(sql: string): Stmt;
}

export interface Stmt {
  bind(...values: unknown[]): Bound;
  all<T>(): Promise<{ results: T[] }>;
}

export interface Bound {
  run(): Promise<{ changes: number }>;
  all<T>(): Promise<{ results: T[] }>;
}

export interface SecereRepo {
  load(): Promise<{ tree: TreeData; blobs: MediaBlobStore }>;
  save(tree: TreeData, blobs: MediaBlobStore): Promise<void>;
}

export function createRepo(driver: Driver): SecereRepo {
  return new SqliteRepo(driver);
}

class LocalStorageRepo implements SecereRepo {
  async load(): Promise<{ tree: TreeData; blobs: MediaBlobStore }> {
    const raw = localStorage.getItem(AppKey);
    if (!raw) return { tree: emptyTree('Secere'), blobs: new Map() };
    try {
      const payload = JSON.parse(raw) as {
        tree: TreeData;
        media: Array<{ sha256: string; mime: string; bytes: number }>;
      };
      const blobs = new Map<string, { bytes: Uint8Array; mime: string }>();
      for (const m of payload.media ?? []) {
        blobs.set(m.sha256, { bytes: new Uint8Array(m.bytes), mime: m.mime });
      }
      return { tree: payload.tree, blobs };
    } catch {
      return { tree: emptyTree('Secere'), blobs: new Map() };
    }
  }
  async save(tree: TreeData, blobs: MediaBlobStore): Promise<void> {
    try {
      const media = [...blobs.entries()].map(([sha, b]) => ({
        sha256: sha,
        mime: b.mime,
        bytes: Array.from(b.bytes),
      }));
      localStorage.setItem(AppKey, JSON.stringify({ tree, media }));
    } catch {
      // Storage full or unavailable: tree still renders, media just doesn't
      // persist beyond this session.
    }
  }
}

class SqliteRepo implements SecereRepo {
  constructor(private db: Driver) {}

  async load(): Promise<{ tree: TreeData; blobs: MediaBlobStore }> {
    await this.db.exec(
      `create table if not exists secere_tree(key text primary key, data text);
       create table if not exists secere_media(sha256 text primary key, mime text, bytes blob);`,
    );
    const t = await this.db
      .prepare("select data from secere_tree where key = ?")
      .bind('tree')
      .all<{ data: string }>();
    const tree = t.results.length ? JSON.parse(t.results[0].data) : emptyTree('Secere');

    const m = await this.db
      .prepare('select * from secere_media')
      .all<{ sha256: string; mime: string; bytes: number }>();
    const blobs = new Map<string, { bytes: Uint8Array; mime: string }>();
    for (const r of m.results) {
      blobs.set(r.sha256, { bytes: new Uint8Array(r.bytes), mime: r.mime });
    }
    return { tree, blobs };
  }

  async save(tree: TreeData, blobs: MediaBlobStore): Promise<void> {
    await this.db.exec('delete from secere_media;');
    await this.db
      .prepare("insert or replace into secere_tree(key,data) values(?,?)")
      .bind('tree', JSON.stringify(tree))
      .run();
    for (const [sha, b] of blobs.entries()) {
      await this.db
        .prepare('insert into secere_media(sha256,mime,bytes) values(?,?,?)')
        .bind(sha, b.mime, b.bytes)
        .run();
    }
  }
}

export const repo: SecereRepo = new LocalStorageRepo();
// Swap this singleton for createRepo(driver) when a real SQLite driver is
// available. The app already calls repo.load() / repo.save() everywhere, so
// the swap is mechanical across the browser, Tauri desktop, and Android shells.
// Media bytes are stored as a BLOB keyed by SHA-256; the tree is a single JSON
// row; the schema is create table if not exists on first access.
