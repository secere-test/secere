import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Which driver the bundle carries: `web` (wa-sqlite in the browser), `tauri`
 * (desktop) or `android` (Capacitor). `src/driver-resolver.ts` branches on this
 * constant, so it must be substituted at build time — left as a bare
 * `__TARGET__` identifier it would throw a ReferenceError before the app renders.
 */
const TARGETS = ['web', 'tauri', 'android'];
const env =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const target = env.SECERE_TARGET ?? 'web';

if (!TARGETS.includes(target)) {
  throw new Error(`Unknown SECERE_TARGET "${target}"; expected one of ${TARGETS.join(', ')}`);
}

/**
 * `define` covers `vite build`, but the dev server serves source modules
 * without applying it, so `__TARGET__` would survive as a bare identifier and
 * throw before React mounts. Substitute it during dev as well.
 */
function targetPlaceholder(value: string): Plugin {
  const replacement = JSON.stringify(value);
  return {
    name: 'secere-target-placeholder',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('/src/') || !code.includes('__TARGET__')) return null;
      // Leave the `declare const __TARGET__` line alone: it is a type-only
      // statement that must stay parseable and is erased later anyway.
      const replaced = code
        .split('\n')
        .map((line) =>
          line.trimStart().startsWith('declare ') ? line : line.replace(/__TARGET__/g, replacement),
        )
        .join('\n');
      return { code: replaced, map: null };
    },
  };
}

export default defineConfig({
  plugins: [targetPlaceholder(target), react()],
  define: {
    __TARGET__: JSON.stringify(target),
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
  },
});
