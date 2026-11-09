/**
 * Secere bundle format: the portable, self-describing unit of exchange.
 *
 *   manifest.json   what this is, how it was selected, what is inside
 *   data.json       the complete slice (lossless for facts, always includes
 *                   the media *index*)
 *   media/<sha256>  image bytes, only when the export asks for them
 *
 * The rules that make image handling painless:
 *
 *  - The media index always travels. Captions, dates, ordering and which fact
 *    each photo documents survive even in a facts-only bundle.
 *  - Bytes are addressed by SHA-256, never by path, so the same photo is the
 *    same asset on every device and in every bundle. Deduplication is free.
 *  - A bundle that omits pixels declares itself incomplete rather than
 *    pretending to be whole. Recipients see "0 of 412 photos included" and can
 *    relink from files they already have, or fetch a media pack later.
 */

import JSZip from 'jszip';
import type { Msg } from './i18n';
import { mediaFileName, readGedcom } from './gedcom/read';
import {
  defaultCriteria,
  extractSubset,
  formatBytes,
  type MediaMode,
  type SubsetCriteria,
  type SubsetStats,
} from './subset';
import {
  APP_VERSION,
  SCHEMA_VERSION,
  emptyTree,
  type MediaBlobStore,
  type MediaRef,
  type TreeData,
} from './types';

export interface BundleAsset {
  sha256: string;
  mime: string;
  bytes: number;
  caption?: string;
  /** Path inside the bundle, if the bytes are included. */
  path?: string;
  /** True when the bytes are present in this bundle. */
  included: boolean;
}

export interface BundleFileEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface BundleManifest {
  format: 'secere-bundle';
  schemaVersion: number;
  appVersion: string;
  exportedAt: string;
  treeName: string;
  sliceName: string;
  description: string;
  criteria: SubsetCriteria;
  counts: SubsetStats;
  media: {
    mode: MediaMode;
    referenced: number;
    included: number;
    bytesIncluded: number;
    /** Sum of original bytes for every referenced asset, whether shipped or not. */
    bytesReferenced: number;
    /** False when the bundle references photos whose bytes are not inside. */
    complete: boolean;
    assets: BundleAsset[];
  };
  files: BundleFileEntry[];
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    // Deterministic fallback so non-browser environments still produce stable
    // ids. Real deployments always have WebCrypto.
    let h1 = 0x811c9dc5;
    for (const byte of bytes) {
      h1 ^= byte;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
    }
    return `fnv-${h1.toString(16).padStart(8, '0')}`;
  }
  const digest = await subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function extensionFor(mime: string): string {
  const sub = (mime.split('/')[1] ?? 'bin').toLowerCase();
  if (sub.includes('svg')) return 'svg';
  if (sub === 'jpeg') return 'jpg';
  return sub.replace(/\+\w+$/, '') || 'bin';
}

export function mediaAssetPath(ref: MediaRef, mode: MediaMode): string {
  if (mode === 'thumbs') {
    const mime = ref.thumbMime ?? 'image/webp';
    return `thumbs/${ref.thumbSha256 ?? ref.sha256}.${extensionFor(mime)}`;
  }
  return `media/${mediaFileName(ref)}`;
}

export interface BundlePlan {
  sliceName: string;
  slice: TreeData;
  manifest: BundleManifest;
  /** Media refs whose bytes we could ship but are not in the local store. */
  missingLocalBlobs: MediaRef[];
  stats: SubsetStats;
  warnings: Msg[];
  /** Rough size of the data-only part, before zip compression. */
  dataBytesEstimate: number;
}

/**
 * Plan a bundle without touching the disk: this is what the export dialog
 * shows live, so the user sees exactly what is about to leave the device.
 */
export function planBundle(
  tree: TreeData,
  criteria: SubsetCriteria,
  blobs: MediaBlobStore,
  sliceName?: string,
): BundlePlan {
  const result = extractSubset(tree, criteria, sliceName ?? `${tree.meta.name} slice`);
  const media = result.tree.media;

  const assets: BundleAsset[] = media.map((ref) => {
    const included = criteria.media !== 'none' && blobs.has(criteria.media === 'thumbs' ? ref.thumbSha256 ?? ref.sha256 : ref.sha256);
    return {
      sha256: criteria.media === 'thumbs' ? ref.thumbSha256 ?? ref.sha256 : ref.sha256,
      mime: criteria.media === 'thumbs' ? ref.thumbMime ?? 'image/webp' : ref.mime,
      bytes: criteria.media === 'thumbs' ? ref.thumbBytes ?? 0 : ref.bytes,
      caption: ref.caption,
      path: included ? mediaAssetPath(ref, criteria.media) : undefined,
      included,
    };
  });

  const missingLocalBlobs = criteria.media === 'none'
    ? []
    : media.filter((ref) => !blobs.has(criteria.media === 'thumbs' ? ref.thumbSha256 ?? ref.sha256 : ref.sha256));

  const includedCount = assets.filter((a) => a.included).length;

  const manifest: BundleManifest = {
    format: 'secere-bundle',
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    treeName: tree.meta.name,
    sliceName: result.tree.meta.name,
    description: `${result.stats.persons} people selected from "${tree.meta.name}"`,
    criteria,
    counts: result.stats,
    media: {
      mode: criteria.media,
      referenced: media.length,
      included: includedCount,
      bytesIncluded: assets.filter((a) => a.included).reduce((sum, a) => sum + a.bytes, 0),
      bytesReferenced: result.stats.mediaBytesReferenced,
      complete: media.length === 0 || includedCount === media.length,
      assets,
    },
    files: [],
  };

  return {
    sliceName: result.tree.meta.name,
    slice: result.tree,
    manifest,
    missingLocalBlobs,
    stats: result.stats,
    warnings: result.warnings,
    dataBytesEstimate: JSON.stringify(result.tree).length,
  };
}

/**
 * Criteria for a backup rather than a share: the whole tree, no filters and no
 * redaction. `defaultCriteria` is tuned for sending a slice to someone else —
 * it redacts living people and strips private notes and media — which is
 * exactly wrong for the copy kept to survive an uninstall.
 *
 * The image tier is the one choice that follows the caller, because it is the
 * only one with a real cost in bytes.
 */
export function archiveCriteria(media: MediaMode = 'none'): SubsetCriteria {
  return {
    ...defaultCriteria([]),
    redactLiving: false,
    stripPrivate: false,
    // Privacy is a sharing decision, not a storage one: a backup that dropped
    // private records would quietly lose part of the tree it exists to keep.
    filters: { allowPrivacy: ['public', 'family', 'private'] },
    media,
  };
}

/** Plan a whole-tree backup. */
export function planArchive(tree: TreeData, blobs: MediaBlobStore, media: MediaMode = 'none'): BundlePlan {
  return planBundle(tree, archiveCriteria(media), blobs, `${tree.meta.name} archive`);
}

export interface BuiltBundle {
  manifest: BundleManifest;
  dataJson: string;
  zip: Uint8Array;
}

/** Materialise a planned bundle into a zip archive. */
export async function buildBundle(plan: BundlePlan, blobs: MediaBlobStore): Promise<BuiltBundle> {
  const zip = new JSZip();
  const dataJson = JSON.stringify(plan.slice, null, 2);
  const manifest: BundleManifest = { ...plan.manifest, files: [] };

  zip.file('data.json', dataJson);
  manifest.files.push({ path: 'data.json', sha256: await sha256Hex(new TextEncoder().encode(dataJson)), bytes: new TextEncoder().encode(dataJson).length });

  for (const ref of plan.slice.media) {
    if (plan.manifest.media.mode === 'none') break;
    const key = plan.manifest.media.mode === 'thumbs' ? ref.thumbSha256 ?? ref.sha256 : ref.sha256;
    const blob = blobs.get(key);
    if (!blob) continue;
    const path = mediaAssetPath(ref, plan.manifest.media.mode);
    zip.file(path, blob.bytes);
    manifest.files.push({ path, sha256: await sha256Hex(blob.bytes), bytes: blob.bytes.length });
  }

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  const zipBytes = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  return { manifest, dataJson, zip: zipBytes };
}

export interface ImportReport {
  format: 'bundle' | 'json' | 'gedcom';
  tree: TreeData;
  manifest?: BundleManifest;
  mediaReferenced: number;
  mediaIncluded: number;
  /** Assets already present locally, matched by content hash. */
  mediaLocalHits: number;
  mediaMissing: number;
  warnings: Msg[];
  blobs: MediaBlobStore;
}

function asUint8(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

/** Read a bundle (or bare data.json / .ged) into a tree plus media status. */
export async function readBundle(input: Uint8Array | ArrayBuffer, localBlobs: MediaBlobStore = new Map()): Promise<ImportReport> {
  const bytes = asUint8(input);
  const zip = await JSZip.loadAsync(bytes).catch(() => null);

  if (!zip) {
    const text = new TextDecoder().decode(bytes);
    if (/^\s*0 HEAD/.test(text)) {
      const parsed = readGedcom(text);
      return {
        format: 'gedcom',
        tree: parsed.tree,
        mediaReferenced: parsed.tree.media.length,
        mediaIncluded: 0,
        mediaLocalHits: 0,
        mediaMissing: parsed.tree.media.length,
        warnings: parsed.warnings,
        blobs: new Map(),
      };
    }
    const tree = JSON.parse(text) as TreeData;
    return summarise('json', tree, undefined, localBlobs, new Map(), []);
  }

  const manifestFile = zip.file('manifest.json');
  const dataFile = zip.file('data.json');
  if (!manifestFile || !dataFile) throw new Error('Bundle is missing manifest.json or data.json');

  const manifest = JSON.parse(await manifestFile.async('text')) as BundleManifest;
  const tree = JSON.parse(await dataFile.async('text')) as TreeData;

  const blobs: MediaBlobStore = new Map();
  const warnings: Msg[] = [];

  if (manifest.schemaVersion > SCHEMA_VERSION) {
    warnings.push({
      key: 'warn.schemaNewer',
      params: { schema: manifest.schemaVersion, app: SCHEMA_VERSION },
    });
  }
  if (!manifest.media.complete) {
    warnings.push({
      key: 'warn.mediaIndexOnly',
      params: {
        referenced: manifest.media.referenced,
        size: formatBytes(manifest.media.bytesReferenced),
      },
    });
  }

  for (const entry of manifest.files) {
    if (!entry.path.startsWith('media/') && !entry.path.startsWith('thumbs/')) continue;
    const file = zip.file(entry.path);
    if (!file) continue;
    const content = await file.async('uint8array');
    const actual = await sha256Hex(content);
    if (entry.sha256 && actual !== entry.sha256) {
      warnings.push({ key: 'warn.checksum', params: { path: entry.path } });
      continue;
    }
    blobs.set(entry.sha256, {
      bytes: content,
      mime: manifest.media.assets.find((a) => a.sha256 === entry.sha256)?.mime ?? 'application/octet-stream',
    });
  }

  for (const asset of manifest.media.assets) {
    if (!asset.included && asset.sha256) {
      const local = localBlobs.get(asset.sha256);
      if (local) blobs.set(asset.sha256, local);
    }
  }

  return summarise('bundle', tree, manifest, localBlobs, blobs, warnings);
}

function summarise(
  format: ImportReport['format'],
  tree: TreeData,
  manifest: BundleManifest | undefined,
  localBlobs: MediaBlobStore,
  blobs: MediaBlobStore,
  warnings: Msg[],
): ImportReport {
  const mediaReferenced = tree.media.length;
  let localHits = 0;
  let missing = 0;

  for (const ref of tree.media) {
    const key = ref.thumbSha256 ?? ref.sha256;
    if (blobs.has(ref.sha256) || blobs.has(key)) continue;
    if (localBlobs.has(ref.sha256) || localBlobs.has(key)) localHits++;
    else missing++;
  }

  return {
    format,
    tree,
    manifest,
    mediaReferenced,
    mediaIncluded: blobs.size,
    mediaLocalHits: localHits,
    mediaMissing: missing,
    warnings,
    blobs,
  };
}

/** Reattach media by content hash from files the user already has. */
export async function relinkMedia(
  tree: TreeData,
  files: Array<{ name: string; bytes: Uint8Array }>,
  blobs: MediaBlobStore,
): Promise<{ relinked: number; blobs: MediaBlobStore; unmatched: string[] }> {
  const wanted = new Map<string, MediaRef>();
  for (const ref of tree.media) {
    wanted.set(ref.sha256, ref);
    if (ref.thumbSha256) wanted.set(ref.thumbSha256, ref);
  }

  const next: MediaBlobStore = new Map(blobs);
  const unmatched: string[] = [];
  let relinked = 0;

  for (const file of files) {
    const hash = await sha256Hex(file.bytes);
    const ref = wanted.get(hash);
    if (!ref) {
      unmatched.push(file.name);
      continue;
    }
    if (!next.has(hash)) {
      next.set(hash, { bytes: file.bytes, mime: ref.mime });
      relinked++;
    }
  }

  return { relinked, blobs: next, unmatched };
}

export interface MergeReport {
  addedPersons: number;
  addedUnions: number;
  addedSources: number;
  addedMedia: number;
  conflicts: Array<{ entity: string; id: string; reason: string }>;
}

/**
 * Idempotent, additive merge. Local data always wins on a field conflict; the
 * incoming version is reported so the user can look, never silently applied.
 */
export function mergeTrees(local: TreeData, incoming: TreeData): { tree: TreeData; report: MergeReport } {
  const tree: TreeData = {
    ...local,
    persons: [...local.persons],
    unions: [...local.unions],
    sources: [...local.sources],
    media: [...local.media],
  };
  const report: MergeReport = { addedPersons: 0, addedUnions: 0, addedSources: 0, addedMedia: 0, conflicts: [] };

  const personIds = new Set(local.persons.map((p) => p.id));
  for (const person of incoming.persons) {
    if (personIds.has(person.id)) {
      const existing = local.persons.find((p) => p.id === person.id)!;
      if (JSON.stringify(existing) !== JSON.stringify(person)) {
        report.conflicts.push({ entity: 'person', id: person.id, reason: 'kept local version' });
      }
      continue;
    }
    tree.persons.push(person);
    report.addedPersons++;
  }

  const unionIds = new Set(local.unions.map((u) => u.id));
  for (const union of incoming.unions) {
    if (unionIds.has(union.id)) {
      report.conflicts.push({ entity: 'union', id: union.id, reason: 'kept local version' });
      continue;
    }
    tree.unions.push(union);
    report.addedUnions++;
  }

  const sourceIds = new Set(local.sources.map((s) => s.id));
  for (const source of incoming.sources) {
    if (sourceIds.has(source.id)) continue;
    tree.sources.push(source);
    report.addedSources++;
  }

  const mediaIds = new Set(local.media.map((m) => m.id));
  for (const ref of incoming.media) {
    if (mediaIds.has(ref.id)) continue;
    tree.media.push(ref);
    report.addedMedia++;
  }

  tree.meta = { ...local.meta, updatedAt: new Date().toISOString() };
  return { tree, report };
}

export function bundleFileName(sliceName: string, mediaMode: MediaMode): string {
  const base = sliceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'secere_slice';
  const suffix = mediaMode === 'none' ? 'facts-only' : mediaMode === 'thumbs' ? 'thumbs' : 'full';
  return `${base}-${suffix}.secere.zip`;
}

export function emptyBundleTree(name = 'Imported'): TreeData {
  return emptyTree(name);
}

export function buildEmptyState(): TreeData {
  const empty = emptyTree('Secere');
  return empty;
}
