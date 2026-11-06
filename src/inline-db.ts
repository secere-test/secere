/** @license SPDX-License-Identifier: MIT */

import { Factory } from 'wa-sqlite';
import type { Stmt } from './core/persistence-store';

export interface WrappedDriver {
  init(): Promise<void>;
  exec(sql: string): Promise<void>;
  prepare(sql: string): Stmt;
}

interface WrappedPrepared {
  step(): boolean;
  getRowsChanged(): number;
  getAsObject(): unknown;
  bind(params: unknown[]): unknown;
}

let wasmReady: any = null;
let db: any = null;
let sqlite: any = null;

async function getWasm(): Promise<any> {
  if (!wasmReady) {
    const mod = await import('wa-sqlite/dist/wa-sqlite.mjs') as { default: (cfg?: any) => Promise<any> };
    const emscriptenModule = await mod.default();
    wasmReady = Factory(emscriptenModule);
  }
  return wasmReady;
}

function makeBound(s: WrappedPrepared): Stmt {
  let bound: Stmt['bind'] | undefined;
  const api: Stmt = {
    bind: (...values: unknown[]) => {
      s.bind(values);
      if (!bound) {
        bound = (...more: unknown[]) => api.bind(...values, ...more) as any;
      }
      return api as any;
    },
    all: async <T>(): Promise<{ results: T[] }> => {
      const rows: T[] = [];
      while (s.step()) rows.push(s.getAsObject() as T);
      return { results: rows };
    },
  };
  return api;
}

export const inlineDriver: WrappedDriver = {
  async init(): Promise<void> {
    if (!db) {
      const factory = await getWasm();
      sqlite = factory;
      db = await sqlite.open_v2(':memory:');
      sqlite.executeBatch(db, [
        `create table if not exists secere_tree(key text primary key, data text);`,
        `create table if not exists secere_media(sha256 text primary key, mime text, bytes blob);`,
      ]);
    }
  },
  async exec(sql: string): Promise<void> {
    await this.init();
    await sqlite.executeBatch(db, [sql]);
  },
  prepare(sql: string): Stmt {
    if (!db) throw new Error('inlineDriver not initialised');
    const sqlPtr = sqlite.str_new(db, sql);
    const prepared = sqlite.prepare_v2(db, sqlPtr) as WrappedPrepared | null;
    sqlite.str_finish(sqlPtr);
    if (!prepared) throw new Error('inlineDriver prepare_v2 returned null');
    return makeBound(prepared);
  },
};
