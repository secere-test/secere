/** @license SPDX-License-Identifier: MIT */

/**
 * SQLite repo driver for the Secere Capacitor Android app.
 *
 * The database is a real SQLite file in app-private storage —
 * `/data/data/dev.secere.app/databases/secere.sqlite`, created by the
 * `SecereSqlite` plugin in
 * `android/app/src/main/java/dev/secere/app/SecereSqlitePlugin.java`. That makes
 * the archive one inspectable file that Android Auto Backup carries across
 * devices, instead of WebView IndexedDB.
 *
 * Values cross the Capacitor bridge as JSON, which cannot represent binary
 * data: `Uint8Array` parameters are sent as `{ __blob: <base64> }`, and blob
 * columns come back the same way, so media bytes survive the round trip
 * unchanged. Plugin methods run on Capacitor's `CapacitorPlugins` background
 * thread, so none of this touches the UI thread.
 *
 * The plugin has no web implementation: calling it outside the Android shell
 * rejects, which is how the resolver detects the platform and falls back to the
 * WASM driver.
 */

import { registerPlugin } from '@capacitor/core';
import type { Bound, Driver, Stmt } from '../core/persistence-store';
import { fromBase64, toBase64 } from './base64';

/** A column value as the bridge serialises it back to JS. */
type NativeRow = Record<string, unknown>;
/** A value as the bridge can carry it: JSON-safe, with our base64 blob marker. */
type JsonParam = string | number | null | { __blob: string };

interface SecereSqlitePlugin {
  exec(options: { sql: string }): Promise<void>;
  run(options: { sql: string; params: JsonParam[] }): Promise<{ changes: number }>;
  query(options: { sql: string; params: JsonParam[] }): Promise<{ rows: NativeRow[] }>;
}

const SecereSqlite = registerPlugin<SecereSqlitePlugin>('SecereSqlite');

const BLOB_KEY = '__blob';

function isBlobMarker(value: unknown): value is { [BLOB_KEY]: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)[BLOB_KEY] === 'string'
  );
}

function encodeParams(values: unknown[]): JsonParam[] {
  return values.map((value) => {
    if (value === null || value === undefined) return null;
    if (value instanceof Uint8Array) return { [BLOB_KEY]: toBase64(value) };
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number' || typeof value === 'string') return value;
    if (typeof value === 'bigint') return Number(value);
    throw new Error(`Cannot pass a ${typeof value} value across the SQLite bridge`);
  });
}

function decodeRow<T>(row: NativeRow): T {
  const decoded: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    decoded[column] = isBlobMarker(value) ? fromBase64(value[BLOB_KEY]) : value;
  }
  return decoded as T;
}

function makeStatement(sql: string): Stmt {
  let params: unknown[] = [];
  const bound: Bound = {
    run: async () => {
      const result = await SecereSqlite.run({ sql, params: encodeParams(params) });
      return { changes: result.changes };
    },
    all: async <T>() => {
      const result = await SecereSqlite.query({ sql, params: encodeParams(params) });
      return { results: result.rows.map((row) => decodeRow<T>(row)) };
    },
  };
  return {
    bind(...values: unknown[]): Bound {
      params = values;
      return bound;
    },
    all: bound.all,
  };
}

export const capacitorDriver: Driver = {
  async init(): Promise<void> {
    // Round-trip a trivial statement: it opens/creates the file on the native
    // side and proves the plugin is registered in this shell.
    await SecereSqlite.exec({ sql: 'select 1' });
  },
  async exec(sql: string): Promise<void> {
    await SecereSqlite.exec({ sql });
  },
  async prepare(sql: string): Promise<Stmt> {
    return makeStatement(sql);
  },
};
