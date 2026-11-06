/**
 * SQLite repo driver for the Secere Tauri desktop app.
 *
 * This file is desktop-only: the browser/TS build excludes it, so it never
 * pulls in `@tauri-apps/api/core` in the web shell. The front-end `repo`
 * stays wired to `persistence-store.ts`; the Tauri app calls
 * `persistence-store.createRepo(tauriDriver)` early in the boot sequence.
 */
import type { Driver, Stmt } from '../core/persistence-store';

export const tauriDriver: Driver = {
  async exec() {
    return Promise.reject(new Error('Tauri SQLite driver not wired to a plugin'));
  },
  prepare(_sql: string): Stmt {
    return {
      bind(..._values: unknown[]): never {
        throw new Error('Tauri SQLite driver not wired to a plugin');
      },
      all() {
        return Promise.reject(new Error('Tauri SQLite driver not wired to a plugin'));
      },
    };
  },
};
