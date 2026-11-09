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

// Every driver is reached through a dynamic import below, on purpose: a static
// re-export here would keep all three drivers (and their plugin dependencies)
// in every target's bundle, whatever `__TARGET__` says.


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
  try {
    // Probe the native plugin through its boot hook: this opens the real
    // SQLite file on the device and proves the plugin is registered.
    await m.capacitorDriver.init?.();
    return m.capacitorDriver;
  } catch (error) {
    // No `SecereSqlite` plugin in this shell — a browser preview of the Android
    // build, or a broken plugin registration. Keep the app usable on the WASM
    // driver instead of white-screening, but say so loudly: data then lives in
    // WebView IndexedDB, not in the app's SQLite file.
    console.warn(
      '[secere] native SQLite plugin unavailable; falling back to the WASM driver',
      error,
    );
    return resolveWebDriver();
  }
}

export async function resolveDriver(): Promise<Driver> {
  if (__TARGET__ === 'web') return resolveWebDriver();
  if (__TARGET__ === 'tauri') return resolveDesktopDriver();
  // __TARGET__ === 'android'
  return resolveAndroidDriver();
}
