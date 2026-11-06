import { useEffect, useMemo, useRef, useState } from 'react';
import { mergeTrees, readBundle, type ImportReport, type MergeReport } from '../core/bundle';
import { browseOrder } from '../core/relations';
import { defaultCriteria, type SubsetCriteria } from '../core/subset';
import { createSampleTree } from '../core/sample';
import type { MediaBlobStore, TreeData } from '../core/types';
import { repo } from '../core/persistence-store';
import ExportPanel from './ExportPanel';
import PersonList from './PersonList';
import PersonProfile from './PersonProfile';

export interface ImportOutcome {
  report: ImportReport;
  merged?: MergeReport;
  replaced: boolean;
}

export default function App() {
  const [tree, setTree] = useState<TreeData | null>(null);
  const [blobs, setBlobs] = useState<MediaBlobStore>(new Map());
  const [selectedId, setSelectedId] = useState<string>('');
  const [criteria, setCriteria] = useState<SubsetCriteria>(defaultCriteria());
  const [isSample, setIsSample] = useState(true);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const loadRef = useRef(false);

  useEffect(() => {
    if (loadRef.current) return;
    loadRef.current = true;

    let cancelled = false;
    repo.load().then(async (loaded) => {
      if (cancelled) return;
      if (loaded.tree.persons.length) {
        setTree(loaded.tree);
        setBlobs(loaded.blobs);
        setIsSample(false);
        setSelectedId(loaded.tree.persons[0]?.id ?? '');
        setCriteria(defaultCriteria([]));
      }

      if (!tree) {
        const { tree: sample, blobs: sampleBlobs } = await createSampleTree();
        if (cancelled) return;
        setTree(sample);
        setBlobs(sampleBlobs);
        setSelectedId(sample.persons.find((p) => p.id === 'I13')?.id ?? sample.persons[0]?.id ?? '');
        setCriteria(defaultCriteria(['I13']));
        repo.save(sample, sampleBlobs).catch(() => {/* best-effort persistence */});
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const people = useMemo(() => (tree ? browseOrder(tree) : []), [tree]);
  const selected = tree?.persons.find((p) => p.id === selectedId);

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
    setNotice('Slice anchored to the selected person.');
  }

  function reset() {
    createSampleTree().then(({ tree: sample, blobs: sampleBlobs }) => {
      setTree(sample);
      setBlobs(sampleBlobs);
      setIsSample(true);
      setOutcome(null);
      setSelectedId(sample.persons.find((p) => p.id === 'I13')?.id ?? '');
      setCriteria(defaultCriteria(['I13']));
      setNotice('Sample tree reloaded.');
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
      setNotice(`Import failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }



  if (!tree) {
    return (
      <div className="boot">
        <p>Opening the family archive…</p>
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
            <p className="subtle">local-first family tree · slice export</p>
          </div>
        </div>

        <div className="tree-stats" aria-label="Tree summary">
          <strong>{tree.meta.name}</strong>
          <span className="subtle">
            {tree.persons.length} people · {tree.unions.length} families · {tree.sources.length} sources ·{' '}
            {mediaRefs} media refs
          </span>
        </div>

        <div className="topbar-actions">
          {!isSample && <span className="badge">imported</span>}
          <button className="ghost" onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? 'Reading…' : 'Import…'}
          </button>
          <button className="ghost" onClick={reset}>
            Load sample
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
          <span>{notice}</span>
          <button className="link" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </div>
      )}

      {outcome && <OutcomeBanner outcome={outcome} onDismiss={() => setOutcome(null)} />}

      <main className="layout">
        <aside className="sidebar">
          <PersonList people={people} selectedId={selectedId} onSelect={setSelectedId} pickedIds={criteria.manualIds} />
        </aside>

        <section className="content">
          {selected ? (
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
            <div className="empty">Select a person to see their record.</div>
          )}
        </section>

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
      </main>
    </div>
  );
}

function OutcomeBanner({ outcome, onDismiss }: { outcome: ImportOutcome; onDismiss: () => void }) {
  const { report, merged, replaced } = outcome;
  return (
    <div className="outcome" role="status">
      <div className="outcome-head">
        <strong>
          Imported {report.format === 'bundle' ? 'bundle' : report.format.toUpperCase()}
          {replaced ? ' — replaced the tree' : ''}
        </strong>
        <button className="link" onClick={onDismiss}>
          dismiss
        </button>
      </div>

      <ul className="outcome-list">
        <li>
          {report.tree.persons.length} people, {report.tree.unions.length} families, {report.tree.media.length} media
          references in the file
        </li>
        {merged && (
          <li>
            merged: +{merged.addedPersons} people, +{merged.addedUnions} families, +{merged.addedSources} sources,{' '}
            +{merged.addedMedia} media
            {merged.conflicts.length
              ? ` · ${merged.conflicts.length} records differ, local versions kept`
              : ''}
          </li>
        )}
        <li>
          images: {report.mediaIncluded} included · {report.mediaLocalHits} already on this device ·{' '}
          {report.mediaMissing} missing (index only)
        </li>
      </ul>

      {report.warnings.length > 0 && (
        <ul className="outcome-warnings">
          {report.warnings.slice(0, 4).map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
