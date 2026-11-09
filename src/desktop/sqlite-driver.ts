/**
 * SQLite repo driver for the Secere Tauri desktop app.
 *
 * This file is desktop-only: the browser/TS build excludes it, so it never
 * pulls in `@tauri-apps/api/core` in the web shell. The front-end `repo`
 * stays wired to `persistence-store.ts`; the Tauri app calls
 * `persistence-store.createRepo(tauriDriver)` early in the boot sequence.
 *
 * Still a rejecting stub: the Tauri build has no SQLite plugin wired yet, so
 * the resolver's `init()` probe rejects and the app falls back rather than
 * returning a driver whose first query throws.
 */
import type { Driver, Stmt } from '../core/persistence-store';

const notWired = (): Error => new Error('Tauri SQLite driver not wired to a plugin');

export const tauriDriver: Driver = {
  async init(): Promise<void> {
    throw notWired();
  },
  async exec(): Promise<void> {
    throw notWired();
  },
  async prepare(_sql: string): Promise<Stmt> {
    throw notWired();
  },
};
