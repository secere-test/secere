/** @license SPDX-License-Identifier: MIT */

/**
 * Get an exported archive off the device.
 *
 * Two very different destinations, one call site:
 *
 *  - Android shell: the system "save as" picker, via the `SecereFiles` plugin.
 *    Needed because a WebView has no download manager, so the usual anchor
 *    trick writes nothing at all.
 *  - Browser (and the desktop shell): a normal download.
 *
 * The platform check uses the build's `__TARGET__` constant and then asks
 * Capacitor whether the plugin is actually registered, so a browser preview of
 * the Android build still downloads instead of failing.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- bundler target placeholder
declare const __TARGET__: 'tauri' | 'android' | 'web';

export type SaveOutcome =
  /** Written to a user-chosen file, outside app storage. */
  | { status: 'saved'; name: string; bytes: number }
  /** The user dismissed the picker; nothing was written. */
  | { status: 'cancelled' }
  /** Handed to the browser's download machinery. */
  | { status: 'downloaded' };

function downloadInBrowser(bytes: Uint8Array, filename: string, mime: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function saveExport(
  bytes: Uint8Array,
  filename: string,
  mime: string,
): Promise<SaveOutcome> {
  if (__TARGET__ === 'android') {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isPluginAvailable('SecereFiles')) {
      const native = await import('./android/save-file');
      const saved = await native.saveFileToDevice(bytes, filename, mime);
      return saved ? { status: 'saved', ...saved } : { status: 'cancelled' };
    }
    console.warn(
      '[secere] SecereFiles plugin missing; falling back to a browser download, which a WebView will not complete',
    );
  }

  downloadInBrowser(bytes, filename, mime);
  return { status: 'downloaded' };
}
