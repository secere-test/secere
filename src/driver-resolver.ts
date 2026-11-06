/** @license SPDX-License-Identifier: MIT */

/**
 * Resolve the correct `Driver` for the current build target.
 *
 * We resolve at module-evaluation time, not at runtime, because these files are
 * tree-shaken by the build: only one implementation should survive in each
 * target. The resolver picks:
 *   - Tauri desktop: `src/desktop/sqlite-driver.ts`
 *   - Capacitor Android: `src/android/sqlite-driver.ts`
 *   - browser: `src/inline-db.ts`
 *
 * Targets are distinguished by the bundler's define placeholders that the build
 * sets per platform. The resolver is the single place the app uses to decide
 * which driver powers `repo`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- bundler target placeholder
declare const __TARGET__: 'tauri' | 'android' | 'web';
// ^^^ untyped bundler target placeholder, set per target at build time, not emitted at runtime

import type { Driver } from './core/persistence-store';

// Re-export the per-target driver module so desktop/Android entry points can
// import the concrete driver directly when they prefer, instead of going through
// async resolution.

export { tauriDriver } from './desktop/sqlite-driver';
export { capacitorDriver } from './android/sqlite-driver';
export { inlineDriver } from './inline-db';


async function resolveWebDriver(): Promise<Driver> {
  const m = await import('./inline-db');
  await m.inlineDriver.init();
  return m.inlineDriver;
}

async function resolveDesktopDriver(): Promise<Driver> {
  const m = await import('./desktop/sqlite-driver');
  return m.tauriDriver;
}

async function resolveAndroidDriver(): Promise<Driver> {
  const m = await import('./android/sqlite-driver');
  return m.capacitorDriver;
}

export async function resolveDriver(): Promise<Driver> {
  if (__TARGET__ === 'web') return resolveWebDriver();
  if (__TARGET__ === 'tauri') return resolveDesktopDriver();
  // __TARGET__ === 'android'
  return resolveAndroidDriver();
}
