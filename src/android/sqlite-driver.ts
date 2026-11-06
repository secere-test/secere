/** @license SPDX-License-Identifier: MIT */

/**
 * SQLite repo driver for the Secere Capacitor Android app.
 *
 * This module is Android-only: the web check excludes it from the browser
 * build, so `@capacitor-community/sqlite` is never resolved or bundled for the
 * web. The front-end `repo` stays in `persistence-store.ts`; the Android app
 * calls `persistence-store.createRepo(capacitorDriver)` once the plugin is
 * ready.
 */

import type { Driver, Stmt } from '../core/persistence-store';

// @capacitor-community/sqlite is imported only on Android at runtime and is never
// resolved in the web build. The import below is a runtime-only module load so
// it does not break the browser bundle.
async function loadPlugin(): Promise<void> {
  // const { CapacitorSqlite } = await import('@capacitor-community/sqlite');
  // return new CapacitorSqlite();
  throw new Error('Android SQLite driver not wired to @capacitor-community/sqlite');
}

export const capacitorDriver: Driver = {
  async exec() {
    await loadPlugin();
    throw new Error('Android SQLite driver not implemented against the plugin');
  },
  prepare(_sql: string): Stmt {
    return {
      bind(..._values: unknown[]): never {
        throw new Error('Android SQLite driver not implemented against the plugin');
      },
      all() {
        return Promise.reject(new Error('Android SQLite driver not implemented against the plugin'));
      },
    };
  },
};
