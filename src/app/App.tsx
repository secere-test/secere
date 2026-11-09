import { useEffect, useMemo, useRef, useState } from 'react';
import { mergeTrees, readBundle, type ImportReport, type MergeReport } from '../core/bundle';
import { findDuplicatePairs, mergePersons } from '../core/duplicates';
import { browseOrder } from '../core/relations';
import { defaultCriteria, type SubsetCriteria } from '../core/subset';
import { createSampleTree, SAMPLE_TREE_ID } from '../core/sample';
import type { MediaBlobStore, TreeData } from '../core/types';
import { repo } from '../core/persistence-store';
import ChartView from './ChartView';
import MergeView from './MergeView';
import ExportPanel from './ExportPanel';
import PersonList from './PersonList';
import PersonProfile from './PersonProfile';
import { LOCALE_NAMES, LOCALES, useI18n, type Locale } from './i18n';
import type { Msg } from '../core/i18n';

export interface ImportOutcome {
  report: ImportReport;
  merged?: MergeReport;
  replaced: boolean;
}

interface InitialState {
  tree: TreeData;
  blobs: MediaBlobStore;
  isSample: boolean;
}

// The first load is cached at module scope, not in the component: React
// StrictMode mounts effects twice in development, and a per-mount guard would
// cancel the first run while the second one bailed out, leaving the boot screen
// up forever. Sharing one promise makes the second mount reuse the same load.
let initialLoad: Promise<InitialState> | null = null;

function loadInitialState(): Promise<InitialState> {
  initialLoad ??= (async () => {
    const loaded = await repo.load();

    // Anything saved earlier wins: seeding the sample on top of a restored tree
    // would overwrite the user's archive on the next visit.
    if (loaded.tree.persons.length) {
      return {
        tree: loaded.tree,
        blobs: loaded.blobs,
        isSample: loaded.tree.meta.id === SAMPLE_TREE_ID,
      };
    }

    const { tree: sample, blobs } = await createSampleTree();
    repo.save(sample, blobs).catch(() => {/* best-effort persistence */});
    return { tree: sample, blobs, isSample: true };
  })();
  return initialLoad;
}

function firstPersonId(tree: TreeData, preferred: string): string {
  return tree.persons.find((p) => p.id === preferred)?.id ?? tree.persons[0]?.id ?? '';
}

export default function App() {
  const { t, n, locale, setLocale } = useI18n();
  const [tree, setTree] = useState<TreeData | null>(null);
  const [blobs, setBlobs] = useState<MediaBlobStore>(new Map());
  const [selectedId, setSelectedId] = useState<string>('');
  const [criteria, setCriteria] = useState<SubsetCriteria>(defaultCriteria());
  const [isSample, setIsSample] = useState(true);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  // Held as a message, not as text: switching language re-reads it.
  const [notice, setNotice] = useState<Msg | null>(null);
  const [view, setView] = useState<'record' | 'chart' | 'merge'>('record');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = `Secere — ${t('app.title')}`;
  }, [t, locale]);

  useEffect(() => {
    let alive = true;

    function show(state: InitialState) {
      setTree(state.tree);
      setBlobs(state.blobs);
      setIsSample(state.isSample);
      setSelectedId(firstPersonId(state.tree, 'I13'));
      setCriteria(defaultCriteria(state.isSample ? ['I13'] : []));
    }

    loadInitialState()
      .then((state) => {
        if (alive) show(state);
      })
      .catch(async (error: unknown) => {
        // A storage failure must not leave the app on the boot screen.
        if (!alive) return;
        setNotice({ key: 'notice.storageFailed', params: { message: (error as Error).message } });
        const { tree: sample, blobs } = await createSampleTree();
        if (!alive) return;
        show({ tree: sample, blobs, isSample: true });
      });

    return () => {
      alive = false;
    };
    // Runs once: a language change must not reload the tree from storage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const people = useMemo(() => (tree ? browseOrder(tree) : []), [tree]);
  const selected = tree?.persons.find((p) => p.id === selectedId);
  const pairs = useMemo(() => (tree ? findDuplicatePairs(tree) : []), [tree]);

  function mergePair(keepId: string, dropId: string) {
    if (!tree) return;
    try {
      const keepName = tree.persons.find((p) => p.id === keepId);
      const dropName = tree.persons.find((p) => p.id === dropId);
      const summary = mergePersons(tree, keepId, dropId);
      setTree(summary.tree);
      if (selectedId === dropId) setSelectedId(keepId);
      repo.save(summary.tree, blobs).catch(() => {/* best-effort persistence */});
      setIsSample(false);

      // Kept as messages so the notice re-reads itself after a language switch.
      const moved = [
        summary.movedEvents ? { key: 'count.facts' as const, count: summary.movedEvents } : null,
        summary.movedChildren ? { key: 'count.children' as const, count: summary.movedChildren } : null,
        summary.movedMedia ? { key: 'count.mediaItems' as const, count: summary.movedMedia } : null,
        summary.collapsedUnions
          ? { key: 'count.duplicateFamilies' as const, count: summary.collapsedUnions }
          : null,
      ].filter((entry): entry is NonNullable<typeof entry> => entry !== null) as Msg[];

      const label = (person: TreeData['persons'][number] | undefined, id: string) => {
        if (!person) return id;
        const name = person.names[0];
        const full = [name?.given, name?.surname].filter(Boolean).join(' ');
        return full ? `${full} (${id})` : id;
      };

      const conflicts = summary.conflicts.length;
      const key = moved.length
        ? conflicts
          ? 'notice.mergedMovedConflicts'
          : 'notice.mergedMoved'
        : conflicts
          ? 'notice.mergedConflicts'
          : 'notice.merged';

      setNotice({
        key,
        params: {
          dropped: label(dropName, dropId),
          kept: label(keepName, keepId),
          items: moved,
          conflicts: { key: 'count.conflictingDates', count: conflicts },
        },
      });
    } catch (error) {
      setNotice({ key: 'notice.mergeFailed', params: { message: (error as Error).message } });
    }
  }

  function togglePick(id: string) {
    const has = criteria.manualIds.includes(id);
    setCriteria({
      ...criteria,
      manualIds: has ? criteria.manualIds.filter((x) => x !== id) : [...criteria.manualIds, id],
    });
  }

  function anchorHere() {
    if (!selectedId) return;
    setCriteria({ ...criteria, roots: [selectedId], manualIds: [] });
    setNotice({ key: 'notice.anchored' });
  }

  function reset() {
    createSampleTree().then(({ tree: sample, blobs: sampleBlobs }) => {
      setTree(sample);
      setBlobs(sampleBlobs);
      setIsSample(true);
      setOutcome(null);
      setSelectedId(sample.persons.find((p) => p.id === 'I13')?.id ?? '');
      setCriteria(defaultCriteria(['I13']));
      setNotice({ key: 'notice.sampleReloaded' });
      repo.save(sample, sampleBlobs).catch(() => {/* best-effort */});
    });
  }

  async function handleFile(file: File) {
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const report = await readBundle(bytes, blobs);
      if (!tree) {
        setTree(report.tree);
        setSelectedId(report.tree.persons[0]?.id ?? '');
        setOutcome({ report, replaced: true });
        setBlobs(report.blobs);
        repo.save(report.tree, report.blobs).catch(() => {/* best-effort persistence */});
        return;
      }
      // Merge by default: importing the same file twice must change nothing.
      const { tree: merged, report: mergeReport } = mergeTrees(tree, report.tree);
      const allBlobs = new Map([...blobs, ...report.blobs]);
      setTree(merged);
      setOutcome({ report, merged: mergeReport, replaced: false });
      setBlobs(allBlobs);
      repo.save(merged, allBlobs).catch(() => {/* best-effort persistence */});
      setIsSample(false);
    } catch (error) {
      setNotice({ key: 'notice.importFailed', params: { message: (error as Error).message } });
    } finally {
      setBusy(false);
    }
  }

  if (!tree) {
    return (
      <div className="boot">
        <p>{t('app.opening')}</p>
      </div>
    );
  }

  const mediaRefs = tree.media.length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden="true">
            S
          </span>
          <div>
            <h1>Secere</h1>
            <p className="subtle">{t('app.tagline')}</p>
          </div>
        </div>

        <div className="tree-stats" aria-label={t('app.treeSummary')}>
          <strong>{tree.meta.name}</strong>
          <span className="subtle">
            {t('stats.line', {
              people: n('count.people', tree.persons.length),
              families: n('count.families', tree.unions.length),
              sources: n('count.sources', tree.sources.length),
              media: n('count.mediaRefs', mediaRefs),
            })}
          </span>
        </div>

        <div className="topbar-actions">
          {!isSample && <span className="badge">{t('app.imported')}</span>}
          <label className="locale-field" title={t('app.language')}>
            <span className="sr-only">{t('app.language')}</span>
            <select
              value={locale}
              aria-label={t('app.language')}
              onChange={(event) => setLocale(event.target.value as Locale)}
            >
              {LOCALES.map((entry) => (
                <option key={entry} value={entry}>
                  {LOCALE_NAMES[entry]}
                </option>
              ))}
            </select>
          </label>
          <button className="ghost" onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? t('app.reading') : t('app.import')}
          </button>
          <button className="ghost" onClick={reset}>
            {t('app.loadSample')}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".zip,.ged,.gedcom,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void handleFile(file);
            }}
          />
        </div>
      </header>

      {notice && (
        <div className="notice" role="status">
          <span>{t(notice)}</span>
          <button className="link" onClick={() => setNotice(null)}>
            {t('app.dismiss')}
          </button>
        </div>
      )}

      {outcome && <OutcomeBanner outcome={outcome} onDismiss={() => setOutcome(null)} />}

      <main className={`layout${view === 'record' ? '' : ' is-wide'}`}>
        <aside className="sidebar">
          <PersonList people={people} selectedId={selectedId} onSelect={setSelectedId} pickedIds={criteria.manualIds} />
        </aside>

        <section className="content">
          <div className="view-switch">
            <div className="segmented">
              <button
                className={`seg${view === 'record' ? ' is-active' : ''}`}
                onClick={() => setView('record')}
              >
                {t('view.record')}
              </button>
              <button
                className={`seg${view === 'chart' ? ' is-active' : ''}`}
                onClick={() => setView('chart')}
              >
                {t('view.chart')}
              </button>
              <button
                className={`seg${view === 'merge' ? ' is-active' : ''}`}
                onClick={() => setView('merge')}
                title={t('view.mergeTitle')}
              >
                {t('view.merge')}
                {pairs.length ? ` (${pairs.length})` : ''}
              </button>
            </div>
          </div>

          {view === 'merge' ? (
            <MergeView
              tree={tree}
              pairs={pairs}
              onMerge={mergePair}
              onOpen={(id) => {
                setSelectedId(id);
                setView('record');
              }}
            />
          ) : view === 'chart' && selected ? (
            <ChartView tree={tree} focusId={selected.id} onSelect={setSelectedId} />
          ) : view === 'chart' ? (
            <div className="empty">{t('view.pickToChart')}</div>
          ) : selected ? (
            <PersonProfile
              tree={tree}
              person={selected}
              blobs={blobs}
              picked={criteria.manualIds.includes(selected.id)}
              onSelect={setSelectedId}
              onTogglePick={() => togglePick(selected.id)}
              onAnchor={anchorHere}
            />
          ) : (
            <div className="empty">{t('view.selectPerson')}</div>
          )}
        </section>

        {/* A chart wants the width more than the slice panel does, and the two
            are never read at the same time. */}
        {view === 'record' && (
          <aside className="panel">
            <ExportPanel
              tree={tree}
              blobs={blobs}
              criteria={criteria}
              onChange={setCriteria}
              selectedId={selectedId}
              selectedName={selected ? selected.names[0]?.given ?? '' : ''}
              onNotice={setNotice}
            />
          </aside>
        )}
      </main>
    </div>
  );
}

function OutcomeBanner({ outcome, onDismiss }: { outcome: ImportOutcome; onDismiss: () => void }) {
  const { t, n } = useI18n();
  const { report, merged, replaced } = outcome;
  return (
    <div className="outcome" role="status">
      <div className="outcome-head">
        <strong>
          {t('outcome.imported', { format: t(`outcome.format.${report.format}`) })}
          {replaced ? t('outcome.replaced') : ''}
        </strong>
        <button className="link" onClick={onDismiss}>
          {t('app.dismiss')}
        </button>
      </div>

      <ul className="outcome-list">
        <li>
          {t('outcome.fileCounts', {
            people: report.tree.persons.length,
            families: report.tree.unions.length,
            media: report.tree.media.length,
          })}
        </li>
        {merged && (
          <li>
            {t('outcome.merged', {
              people: merged.addedPersons,
              families: merged.addedUnions,
              sources: merged.addedSources,
              media: merged.addedMedia,
            })}
            {merged.conflicts.length
              ? ` · ${n('count.recordsDiffer', merged.conflicts.length)}`
              : ''}
          </li>
        )}
        <li>
          {t('outcome.images', {
            included: report.mediaIncluded,
            local: report.mediaLocalHits,
            missing: report.mediaMissing,
          })}
        </li>
      </ul>

      {report.warnings.length > 0 && (
        <ul className="outcome-warnings">
          {report.warnings.slice(0, 4).map((warning) => (
            <li key={warning.key}>{t(warning)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
