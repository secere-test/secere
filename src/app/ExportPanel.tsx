import { useMemo, useState } from 'react';
import { buildBundle, bundleFileName, planArchive, planBundle } from '../core/bundle';
import { saveExport } from '../save-export';
import { writeGedcom } from '../core/gedcom/write';
import {
  defaultCriteria,
  describeCriteriaParts,
  formatBytes,
  type BoundaryPolicy,
  type LivingFilter,
  type MediaMode,
  type SubsetCriteria,
} from '../core/subset';
import type { MediaBlobStore, Sex, TreeData } from '../core/types';
import { useI18n } from './i18n';
import type { Msg } from '../core/i18n';

interface Props {
  tree: TreeData;
  blobs: MediaBlobStore;
  criteria: SubsetCriteria;
  onChange: (criteria: SubsetCriteria) => void;
  selectedId: string;
  selectedName: string;
  onNotice: (message: Msg) => void;
}

const MEDIA_MODES: MediaMode[] = ['none', 'thumbs', 'full'];
const BOUNDARY_POLICIES: BoundaryPolicy[] = ['include', 'stub', 'prune'];

export default function ExportPanel({ tree, blobs, criteria, onChange, selectedId, selectedName, onNotice }: Props) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const plan = useMemo(() => planBundle(tree, criteria, blobs), [tree, criteria, blobs]);
  const stats = plan.stats;

  const factsOnlyBytes = plan.dataBytesEstimate;
  const thumbBytes = factsOnlyBytes + plan.slice.media.reduce((sum, m) => sum + (m.thumbBytes ?? 0), 0);
  const fullBytes = factsOnlyBytes + plan.slice.media.reduce((sum, m) => sum + m.bytes, 0);

  function set(patch: Partial<SubsetCriteria>) {
    onChange({ ...criteria, ...patch });
  }

  function setFilter(patch: Partial<SubsetCriteria['filters']>) {
    onChange({ ...criteria, filters: { ...criteria.filters, ...patch } });
  }

  function number(value: string): number | undefined {
    if (value.trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  /**
   * Hand bytes to the platform. Returns false when nothing was written, having
   * already explained why, so callers can skip their own success notice.
   */
  async function save(bytes: Uint8Array, filename: string, mime: string): Promise<boolean> {
    setSaving(true);
    try {
      const outcome = await saveExport(bytes, filename, mime);
      if (outcome.status === 'cancelled') {
        onNotice({ key: 'notice.saveCancelled' });
        return false;
      }
      return true;
    } catch (error) {
      onNotice({ key: 'notice.saveFailed', params: { message: (error as Error).message } });
      return false;
    } finally {
      setSaving(false);
    }
  }

  function mediaLine(counts: { referenced: number; included: number }): Msg {
    return criteria.media === 'none'
      ? { key: 'export.mediaFactsOnly', params: { count: counts.referenced } }
      : { key: 'export.mediaImages', params: { included: counts.included, referenced: counts.referenced } };
  }

  async function exportBundle() {
    const fresh = planBundle(tree, criteria, blobs);
    const built = await buildBundle(fresh, blobs);
    if (!(await save(built.zip, bundleFileName(fresh.sliceName, criteria.media), 'application/zip'))) return;
    onNotice({
      key: 'export.doneBundle',
      params: {
        name: fresh.sliceName,
        people: fresh.stats.persons,
        families: fresh.stats.unions,
        media: mediaLine(fresh.manifest.media),
        size: formatBytes(built.zip.length),
      },
    });
  }

  async function exportGedcom() {
    const ged = writeGedcom(plan.slice);
    const name = `${plan.sliceName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.ged`;
    if (!(await save(new TextEncoder().encode(ged), name, 'text/plain'))) return;
    onNotice({ key: 'export.doneGedcom', params: { people: stats.persons, families: stats.unions } });
  }

  /**
   * A backup, not a share: the whole tree with no filters and, crucially, no
   * redaction or private-record stripping — otherwise the copy you kept to
   * survive an uninstall would be missing the living people and the notes.
   * Only the image tier follows the panel, since that is the one choice with a
   * real cost in bytes.
   */
  async function saveArchive() {
    const fresh = planArchive(tree, blobs, criteria.media);
    const built = await buildBundle(fresh, blobs);
    const name = bundleFileName(fresh.sliceName, criteria.media);
    if (!(await save(built.zip, name, 'application/zip'))) return;
    const mediaText: Msg =
      criteria.media === 'none'
        ? { key: 'export.mediaFactsOnly', params: { count: fresh.manifest.media.referenced } }
        : {
            key: 'export.mediaImages',
            params: {
              included: fresh.manifest.media.included,
              referenced: fresh.manifest.media.referenced,
            },
          };
    onNotice({
      key: 'export.doneArchive',
      params: {
        people: fresh.stats.persons,
        families: fresh.stats.unions,
        media: mediaText,
        size: formatBytes(built.zip.length),
      },
    });
  }

  const anchored = criteria.roots.length > 0;

  return (
    <div className="export">
      <header className="export-head">
        <h2>{t('export.heading')}</h2>
        <p className="subtle">{t('export.intro')}</p>
      </header>

      <section className="field">
        <div className="segmented">
          <button
            className={!anchored ? 'seg is-active' : 'seg'}
            onClick={() => set({ roots: [], manualIds: [], ancestors: 0, descendants: 0 })}
          >
            {t('export.wholeTree')}
          </button>
          <button
            className={anchored ? 'seg is-active' : 'seg'}
            onClick={() => {
              if (!anchored && selectedId) set({ roots: [selectedId] });
            }}
            disabled={!selectedId}
            title={selectedId ? t('export.walkTitle') : t('export.selectFirst')}
          >
            {t('export.around', { name: selectedName || t('export.aroundFallback') })}
          </button>
        </div>
      </section>

      <section className="field">
        <label className="slider-row">
          <span>
            {t('export.generationsUp')} <b>{criteria.ancestors}</b>
          </span>
          <input
            type="range"
            min={0}
            max={6}
            value={criteria.ancestors}
            onChange={(event) => set({ ancestors: Number(event.target.value) })}
          />
        </label>
        <label className="slider-row">
          <span>
            {t('export.generationsDown')} <b>{criteria.descendants}</b>
          </span>
          <input
            type="range"
            min={0}
            max={6}
            value={criteria.descendants}
            onChange={(event) => set({ descendants: Number(event.target.value) })}
          />
        </label>
        <label className="slider-row">
          <span>
            {t('export.sideways')} <b>{criteria.collateral}</b>
          </span>
          <input
            type="range"
            min={0}
            max={3}
            value={criteria.collateral}
            onChange={(event) => set({ collateral: Number(event.target.value) })}
          />
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={criteria.includeSpouses}
            onChange={(event) => set({ includeSpouses: event.target.checked })}
          />
          {t('export.includeSpouses')}
        </label>
      </section>

      <details className="field">
        <summary>{t('export.filters')}</summary>
        <div className="filter-grid">
          <label>
            <span>{t('export.nameContains')}</span>
            <input
              type="text"
              placeholder={t('export.example', { value: 'Keane' })}
              value={criteria.filters.nameIncludes ?? ''}
              onChange={(event) => setFilter({ nameIncludes: event.target.value || undefined })}
            />
          </label>
          <label>
            <span>{t('export.placeContains')}</span>
            <input
              type="text"
              placeholder={t('export.example', { value: 'Kerry' })}
              value={criteria.filters.placeIncludes ?? ''}
              onChange={(event) => setFilter({ placeIncludes: event.target.value || undefined })}
            />
          </label>
          <label>
            <span>{t('export.bornFrom')}</span>
            <input
              type="number"
              placeholder="1800"
              value={criteria.filters.bornFrom ?? ''}
              onChange={(event) => setFilter({ bornFrom: number(event.target.value) })}
            />
          </label>
          <label>
            <span>{t('export.bornTo')}</span>
            <input
              type="number"
              placeholder="1950"
              value={criteria.filters.bornTo ?? ''}
              onChange={(event) => setFilter({ bornTo: number(event.target.value) })}
            />
          </label>
          <label>
            <span>{t('export.sex')}</span>
            <select
              value={criteria.filters.sex?.join(',') ?? ''}
              onChange={(event) => {
                const value = event.target.value;
                setFilter({ sex: value ? [value as Sex] : undefined });
              }}
            >
              <option value="">{t('export.any')}</option>
              <option value="M">{t('sex.M')}</option>
              <option value="F">{t('sex.F')}</option>
            </select>
          </label>
          <label>
            <span>{t('export.status')}</span>
            <select
              value={criteria.filters.living ?? 'any'}
              onChange={(event) => setFilter({ living: event.target.value as LivingFilter })}
            >
              <option value="any">{t('export.anyone')}</option>
              <option value="living">{t('export.livingOnly')}</option>
              <option value="deceased">{t('export.deceasedOnly')}</option>
            </select>
          </label>
          <label>
            <span>{t('export.media')}</span>
            <select
              value={criteria.filters.hasMedia === undefined ? '' : criteria.filters.hasMedia ? 'yes' : 'no'}
              onChange={(event) => {
                const value = event.target.value;
                setFilter({ hasMedia: value === '' ? undefined : value === 'yes' });
              }}
            >
              <option value="">{t('export.any')}</option>
              <option value="yes">{t('export.hasMedia')}</option>
              <option value="no">{t('export.noMedia')}</option>
            </select>
          </label>
        </div>
        <p className="footnote">{t('export.filtersFootnote')}</p>
      </details>

      <section className="field">
        <h3>{t('export.boundary')}</h3>
        <div className="choice-list">
          {BOUNDARY_POLICIES.map((value) => (
            <label key={value} className={`choice${criteria.boundary === value ? ' is-active' : ''}`}>
              <input
                type="radio"
                name="boundary"
                checked={criteria.boundary === value}
                onChange={() => set({ boundary: value })}
              />
              <span>
                <b>{t(`export.boundary.${value}.title`)}</b>
                <em>{t(`export.boundary.${value}.hint`)}</em>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="field">
        <label className="check">
          <input
            type="checkbox"
            checked={criteria.redactLiving}
            onChange={(event) => set({ redactLiving: event.target.checked })}
          />
          {t('export.redactLiving')}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={criteria.stripPrivate}
            onChange={(event) => set({ stripPrivate: event.target.checked })}
          />
          {t('export.stripPrivate')}
        </label>
      </section>

      <section className="field">
        <h3>{t('export.images')}</h3>
        <div className="choice-list">
          {MEDIA_MODES.map((value) => {
            const bytes = value === 'none' ? factsOnlyBytes : value === 'thumbs' ? thumbBytes : fullBytes;
            return (
              <label key={value} className={`choice${criteria.media === value ? ' is-active' : ''}`}>
                <input
                  type="radio"
                  name="media"
                  checked={criteria.media === value}
                  onChange={() => set({ media: value })}
                />
                <span>
                  <b>{t(`export.media.${value}.title`)}</b>
                  <em>{t(`export.media.${value}.hint`)}</em>
                </span>
                <span className="choice-size">≈ {formatBytes(bytes)}</span>
              </label>
            );
          })}
        </div>
        <p className="footnote">
          {stats.mediaRefs === 0
            ? t('export.mediaNoRefs')
            : criteria.media === 'none'
              ? t('export.mediaNone', {
                  count: stats.mediaRefs,
                  size: formatBytes(stats.mediaBytesReferenced),
                })
              : `${t('export.mediaAttachable', {
                  included: stats.mediaIncluded,
                  total: stats.mediaRefs,
                })}${
                  plan.missingLocalBlobs.length
                    ? ` ${t('export.mediaMissing', { count: plan.missingLocalBlobs.length })}`
                    : ''
                }`}
        </p>
      </section>

      {criteria.manualIds.length > 0 && (
        <section className="field">
          <h3>
            {t('export.handPicked')} <span className="count">{criteria.manualIds.length}</span>
          </h3>
          <div className="chips">
            {criteria.manualIds.map((id) => {
              const person = tree.persons.find((p) => p.id === id);
              return (
                <button
                  key={id}
                  className="chip"
                  onClick={() => onChange({ ...criteria, manualIds: criteria.manualIds.filter((x) => x !== id) })}
                  title={t('export.removeFromSlice')}
                >
                  {person?.names[0]?.given ?? id} {person?.names[0]?.surname ?? ''} ×
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section className="preview">
        <h3>{t('export.thisSlice')}</h3>
        <p className="preview-range">{describeCriteriaParts(criteria).map((part) => t(part)).join(', ')}</p>
        <div className="preview-grid">
          <div>
            <b>{stats.persons}</b>
            <span>{t('export.people')}</span>
          </div>
          <div>
            <b>{stats.unions}</b>
            <span>{t('export.families')}</span>
          </div>
          <div>
            <b>{stats.sources}</b>
            <span>{t('export.sources')}</span>
          </div>
          <div>
            <b>{stats.mediaRefs}</b>
            <span>{t('export.mediaRefs')}</span>
          </div>
        </div>
        <p className="subtle">
          {t('export.previewMeta', {
            redacted: stats.redacted,
            stubs: stats.stubs,
            size: formatBytes(stats.mediaBytesReferenced),
          })}
        </p>

        {plan.warnings.length > 0 && (
          <ul className="warnings">
            {plan.warnings.slice(0, 3).map((warning) => (
              <li key={`${warning.key}:${JSON.stringify(warning.params ?? {})}`}>{t(warning)}</li>
            ))}
          </ul>
        )}

        <div className="export-actions">
          <button className="primary" onClick={() => void exportBundle()} disabled={saving}>
            {saving ? t('export.saving') : t('export.exportBundle')}
          </button>
          <button className="ghost" onClick={() => void exportGedcom()} disabled={saving}>
            {t('export.exportGedcom')}
          </button>
        </div>
        <p className="footnote">{t('export.bundleFootnote')}</p>

        <div className="export-actions">
          <button className="ghost" onClick={() => void saveArchive()} disabled={saving}>
            {t('export.saveArchive')}
          </button>
        </div>
        <p className="footnote">{t('export.archiveFootnote')}</p>
      </section>

      <button
        className="link reset-link"
        onClick={() => onChange(defaultCriteria(criteria.roots))}
        type="button"
      >
        {t('export.reset')}
      </button>
    </div>
  );
}
