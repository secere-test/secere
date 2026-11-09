/* eslint-disable @typescript-eslint/no-explicit-any */

import type { MediaBlobStore, TreeData, TreeMeta } from './types';
import { emptyTree } from './types';

export const AppKey = 'secere-state-v1';
export const StorageBackend = 'local';
export const StorageBackendFile = 'secere.sqlite';
export type { TreeMeta };

export async function loadSaved(): Promise<MediaBlobStore> {
  const loaded = await repo.load();
  return loaded.blobs;
}

export function saveState(tree: TreeData, blobs: MediaBlobStore): void {
  void repo.save(tree, blobs).catch(() => {/* best-effort */});
}

export interface Driver {
  /**
   * Optional boot hook: open (or create) the underlying database and verify it
   * answers. The resolver calls it once before the UI reads the repo, so a
   * missing or broken backend surfaces as a rejected promise instead of a
   * failed first query.
   */
  init?(): Promise<void>;
  exec(sql: string): Promise<void>;
  /**
   * Compiling a statement is asynchronous on every backend that matters
   * (wa-sqlite's async build, and the Android plugin's bridge round-trip), so
   * the interface is async here rather than forcing a sync shim that cannot
   * work for native SQLite.
   */
  prepare(sql: string): Promise<Stmt>;
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
        media: Array<{ sha256: string; mime: string; bytes: number[] }>;
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

let repo: SecereRepo = new LocalStorageRepo();
export { repo };

// Rewire the repo singleton to a different driver. This is the boot-time
// hook the app entry calls; it keeps the same `SecereRepo` shape the rest of
// the app uses so we do not need to pass the repo through React state.
export function replaceRepoDriver(driver: Driver): void {
  repo = createRepo(driver);
}

// Test hook: create the repo locally without touching the singleton. This is
// used by the dom-free projection test so the persistence tests stay off the DOM.
export function createTestRepo(driver: Driver): SecereRepo {
  return createRepo(driver);
}

// Boot path: the app entry calls replaceRepoDriver(driver) so this
// singleton can be swapped for the resolved per-target driver before the UI
// first reads it. The browser build bootstraps the wa-sqlite driver
// (IndexedDB-backed), the Android build the native plugin driver, and desktop
// wires its own plugin at its boot point.
// Media bytes are stored as a BLOB keyed by SHA-256; the tree is a single JSON
// row; the schema is create table if not exists on first access.
class SqliteRepo implements SecereRepo {
  constructor(private db: Driver) {}

  async load(): Promise<{ tree: TreeData; blobs: MediaBlobStore }> {
    await this.db.exec(
      `create table if not exists secere_tree(key text primary key, data text);
       create table if not exists secere_media(sha256 text primary key, mime text, bytes blob);`,
    );
    const treeStmt = await this.db.prepare('select data from secere_tree where key = ?');
    const t = await treeStmt.bind('tree').all<{ data: string }>();
    const tree = t.results.length ? JSON.parse(t.results[0].data) : emptyTree('Secere');

    const mediaStmt = await this.db.prepare('select * from secere_media');
    const m = await mediaStmt.all<{ sha256: string; mime: string; bytes: Uint8Array }>();
    const blobs = new Map<string, { bytes: Uint8Array; mime: string }>();
    for (const r of m.results) {
      blobs.set(r.sha256, { bytes: r.bytes, mime: r.mime });
    }
    return { tree, blobs };
  }

  async save(tree: TreeData, blobs: MediaBlobStore): Promise<void> {
    await this.db.exec('delete from secere_media;');
    const treeStmt = await this.db.prepare('insert or replace into secere_tree(key,data) values(?,?)');
    await treeStmt.bind('tree', JSON.stringify(tree)).run();
    const mediaStmt = await this.db.prepare('insert into secere_media(sha256,mime,bytes) values(?,?,?)');
    for (const [sha, b] of blobs.entries()) {
      await mediaStmt.bind(sha, b.mime, b.bytes).run();
    }
  }
}

// ---- Test mocks (dom-free) ----

interface MockDriverRow {
  key?: string;
  data?: string;
  sha256?: string;
  mime?: string;
  bytes?: Uint8Array | unknown;
}

class MockDriver {
  readonly tables = new Map<string, MockDriverRow[]>();

  async exec(sql: string): Promise<void> {
    for (const stmt of sql.split(';')) {
      const s = stmt.trim();
      if (!s) continue;
      const upper = s.toUpperCase();
      if (upper.startsWith('CREATE TABLE')) {
        const m = s.match(/create table if not exists\s+(\w+)/i);
        if (m && !this.tables.has(m[1])) {
          this.tables.set(m[1], []);
        }
      } else if (upper.startsWith('DELETE')) {
        const m = s.match(/delete\s+from\s+(\w+)/i);
        if (m) this.tables.set(m[1], []);
      }
    }
  }

  async prepare(sql: string): Promise<Stmt> {
    return new MockStmt(this, sql);
  }
}

class MockStmt implements Stmt {
  private params: unknown[] = [];

  constructor(
    private db: MockDriver,
    private sql: string,
  ) {}

  bind(...values: unknown[]): Bound {
    this.params = values;
    return this as unknown as Bound;
  }

  run(): Promise<{ changes: number }> {
    return this.runApply();
  }

  all<T>(): Promise<{ results: T[] }> {
    return this.allApply() as Promise<{ results: T[] }>;
  }

  private runApply(): Promise<{ changes: number }> {
    const rows = this.readRows();
    const upper = this.sql.trim().toUpperCase();

    if (upper.startsWith('SELECT')) {
      if (upper.includes('WHERE KEY = ?')) {
        const key = this.params[0] as string;
        const match = rows.find((r) => (r as MockDriverRow).key === key);
        return Promise.resolve({ changes: match ? 1 : 0 });
      }
      return Promise.resolve({ changes: rows.length });
    }

    if (upper.startsWith('INSERT OR REPLACE') || upper.startsWith('INSERT')) {
      const table = this.tableName();
      const existing = this.db.tables.get(table) ?? [];
      const row = this.toRow();
      const key = (row as MockDriverRow).key;
      if (key) {
        if (upper.startsWith('INSERT OR REPLACE')) {
          const idx = existing.findIndex((r) => (r as MockDriverRow).key === key);
          if (idx >= 0) existing[idx] = row;
          else existing.push(row);
        } else {
          existing.push(row);
        }
      } else {
        existing.push(row);
      }
      this.db.tables.set(table, existing);
      return Promise.resolve({ changes: 1 });
    }

    return Promise.resolve({ changes: 0 });
  }

  private allApply(): Promise<{ results: unknown[] }> {
    const rows = this.readRows();
    const upper = this.sql.trim().toUpperCase();

    if (upper.startsWith('SELECT')) {
      if (upper.includes('WHERE KEY = ?')) {
        const key = this.params[0] as string;
        const match = rows.find((r) => (r as MockDriverRow).key === key);
        return Promise.resolve({ results: match ? [match] : [] });
      }
      return Promise.resolve({ results: rows as unknown[] });
    }

    return Promise.resolve({ results: [] });
  }

  private tableName(): string {
    // INSERT INTO <table> ...
    let m = this.sql.match(/into\s+(\w+)/i);
    if (m) return m[1].toLowerCase();
    // SELECT ... FROM <table> ...
    m = this.sql.match(/from\s+(\w+)/i);
    return (m ? m[1] : 'unknown').toLowerCase();
  }

  private toRow(): MockDriverRow & { key?: string } {
    const p = this.params as (string | Uint8Array)[];
    const upper = this.sql.toUpperCase();
    if (upper.includes('SECERE_TREE(KEY,DATA)')) {
      return { key: p[0] as string, data: p[1] as string };
    }
    if (upper.includes('SECERE_MEDIA(SHA256,MIME,BYTES)')) {
      return {
        sha256: p[0] as string,
        mime: p[1] as string,
        bytes: p[2] as Uint8Array,
      };
    }
    return {};
  }

  private readRows(): MockDriverRow[] {
    const upper = this.sql.trim().toUpperCase();
    if (upper.startsWith('SELECT DATA FROM')) {
      // Return full rows (including key) so the WHERE KEY = ? filter in
      // allApply can still locate the matching row.
      return (this.db.tables.get('secere_tree') ?? []) as MockDriverRow[];
    }
    if (upper.startsWith('SELECT * FROM')) {
      const table = this.tableName();
      return (this.db.tables.get(table) ?? []).map((r) => ({ ...r }));
    }
    return [];
  }
}

export const DriverStub: Driver = new MockDriver() as any;
