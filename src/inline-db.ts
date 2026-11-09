/** @license SPDX-License-Identifier: MIT */

/**
 * Browser driver: SQLite compiled to WebAssembly (wa-sqlite).
 *
 * The database file lives in IndexedDB through wa-sqlite's batch-atomic VFS, so
 * reloading the page re-opens the rows that were saved instead of starting from
 * an empty `:memory:` database. When IndexedDB or Web Locks are unavailable
 * (private windows, storage disabled by policy) the driver falls back to an
 * in-memory database: the app keeps working for that session and only
 * persistence across reloads is lost.
 *
 * The async (Asyncify) build is required because the VFS awaits IndexedDB
 * while SQLite is inside a file operation. Statements are compiled per
 * execution with `statements()`, which finalizes them when the loop ends, so no
 * prepared statement outlives its query.
 */

import { Factory, SQLITE_ROW } from 'wa-sqlite';
import { IDBBatchAtomicVFS } from 'wa-sqlite/src/examples/IDBBatchAtomicVFS.js';
// `?url` makes the bundler emit (and serve) the binary as an asset. Without it
// the emscripten module resolves the .wasm relative to the bundled JS and the
// dev server's SPA fallback answers with index.html, which fails to instantiate.
import wasmUrl from 'wa-sqlite/dist/wa-sqlite-async.wasm?url';
import type { Bound, Stmt } from './core/persistence-store';

export interface WrappedDriver {
  init(): Promise<void>;
  exec(sql: string): Promise<void>;
  prepare(sql: string): Promise<Stmt>;
}

const DB_FILE = 'secere.sqlite';
const IDB_NAME = 'secere-vfs';

const SCHEMA = `create table if not exists secere_tree(key text primary key, data text);
create table if not exists secere_media(sha256 text primary key, mime text, bytes blob);`;

// The Emscripten module and the API `Factory()` wraps it in are untyped here:
// wa-sqlite's types describe the sync build's return values, while the async
// build returns promises for the same calls.
let sqlite: any = null;
let db: number | null = null;
let opening: Promise<void> | null = null;

async function getApi(): Promise<any> {
  if (sqlite) return sqlite;
  const mod = (await import('wa-sqlite/dist/wa-sqlite-async.mjs')) as unknown as {
    default: (config?: object) => Promise<any>;
  };
  sqlite = Factory(await mod.default({ locateFile: () => wasmUrl }));
  return sqlite;
}

async function openDatabase(): Promise<void> {
  const api = await getApi();
  let handle: number | null = null;

  if (typeof indexedDB !== 'undefined' && typeof navigator !== 'undefined' && navigator.locks) {
    try {
      const vfs = new IDBBatchAtomicVFS(IDB_NAME);
      api.vfs_register(vfs, false);
      handle = await api.open_v2(DB_FILE, undefined, vfs.name);
    } catch (error) {
      handle = null;
      console.warn('[secere] IndexedDB storage unavailable; using an in-memory database', error);
    }
  }

  if (handle === null) handle = await api.open_v2(':memory:');

  // Publish the handle only once the schema exists, so a failure above leaves
  // `open()` able to try again instead of handing out a half-initialised db.
  await api.exec(handle, SCHEMA);
  db = handle;
}

async function open(): Promise<void> {
  if (db !== null) return;
  if (!opening) {
    opening = openDatabase().catch((error: unknown) => {
      opening = null;
      throw error;
    });
  }
  await opening;
}

function readRow(api: any, stmt: number): Record<string, unknown> {
  const columns: string[] = api.column_names(stmt);
  const values: unknown[] = api.row(stmt);
  const row: Record<string, unknown> = {};
  columns.forEach((column, index) => {
    row[column] = values[index];
  });
  return row;
}

async function select<T>(sql: string, params: unknown[]): Promise<T[]> {
  await open();
  const api = sqlite;
  const handle = db;
  const rows: T[] = [];
  for await (const stmt of api.statements(handle, sql)) {
    api.bind_collection(stmt, params);
    while ((await api.step(stmt)) === SQLITE_ROW) {
      rows.push(readRow(api, stmt) as T);
    }
  }
  return rows;
}

async function mutate(sql: string, params: unknown[]): Promise<number> {
  await open();
  const api = sqlite;
  const handle = db;
  let changes = 0;
  for await (const stmt of api.statements(handle, sql)) {
    api.bind_collection(stmt, params);
    // Drain the statement so it runs to completion before we read changes().
    while ((await api.step(stmt)) === SQLITE_ROW) {
      // writes return no rows
    }
    changes += api.changes(handle);
  }
  return changes;
}

function makeStatement(sql: string): Stmt {
  let params: unknown[] = [];
  const bound: Bound = {
    run: async () => ({ changes: await mutate(sql, params) }),
    all: async <T>() => ({ results: await select<T>(sql, params) }),
  };
  return {
    bind(...values: unknown[]): Bound {
      params = values;
      return bound;
    },
    all: async <T>() => ({ results: await select<T>(sql, params) }),
  };
}

export const inlineDriver: WrappedDriver = {
  async init(): Promise<void> {
    await open();
  },
  async exec(sql: string): Promise<void> {
    await open();
    await sqlite.exec(db, sql);
  },
  async prepare(sql: string): Promise<Stmt> {
    return makeStatement(sql);
  },
};
