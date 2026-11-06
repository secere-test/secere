/** @license SPDX-License-Identifier: MIT */

import { Factory } from 'wa-sqlite';
import type { Stmt } from './core/persistence-store';

let wasmReady: any = null;
let db: any = null;

async function getWasm(): Promise<any> {
  if (!wasmReady) {
    const mod = await import('wa-sqlite/dist/wa-sqlite.mjs') as { default: (cfg?: any) => Promise<any> };
    const emscriptenModule = await mod.default();
    wasmReady = Factory(emscriptenModule);
  }
  return wasmReady;
}

export interface StmtBound {
  run(): Promise<{ changes: number }>;
  all<T>(): Promise<{ results: T[] }>;
}

function makeBound(s: any): StmtBound {
  return {
    run: async () => {
      s.step();
      return { changes: s.getRowsChanged() };
    },
    all: async <T>(): Promise<{ results: T[] }> => {
      const rows: T[] = [];
      while (s.step()) rows.push(s.getAsObject() as T);
      return { results: rows };
    },
  };
}

export const inlineDriver = {
  async init(): Promise<void> {
    if (!db) {
      const sqlite = await getWasm();
      db = await sqlite.open_v2(':memory:');
      sqlite.executeBatch(db, [
        `create table if not exists secere_tree(key text primary key, data text);`,
        `create table if not exists secere_media(sha256 text primary key, mime text, bytes blob);`,
      ]);
    }
  },
  prepare(sql: string): Stmt {
    if (!db) throw new Error('inlineDriver not initialised');
    const sqlite = db.constructor.prototype.constructor as any;
    const sqlPtr = sqlite.str_new(db, sql);
    const prepared = sqlite.prepare_v2(db, sqlPtr) as any;
    sqlite.str_finish(sqlPtr);
    if (!prepared) throw new Error('inlineDriver prepare_v2 returned null');
    const rawBind = prepared.bind.bind(prepared);
    const bound: Stmt['bind'] = ((...values: unknown[]) => rawBind(values)) as any;
    const all: Stmt['all'] = makeBound(prepared).all;
    return { bind: bound, all };
  },
  async exec(sql: string): Promise<void> {
    await this.init();
    const sqlite = db.constructor.prototype.constructor as any;
    await sqlite.executeBatch(db, [sql]);
  },
};
