import { useMemo, useState } from 'react';
import { layoutChart, type ChartBox, type ChartKind, type ChartLayout } from '../core/chart';
import { personName, type TreeData } from '../core/types';
import { useI18n } from './i18n';

interface Props {
  tree: TreeData;
  focusId: string;
  onSelect: (id: string) => void;
}

const KINDS: ChartKind[] = ['pedigree', 'descendant', 'hourglass', 'fan'];

/** Cuts a name to the width of its box without shrinking the type. */
function fit(text: string, width: number, perChar = 6.7): string {
  const max = Math.max(4, Math.floor((width - 14) / perChar));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A fan wedge only has its own arc to write in, and outer generations are a few
 * dozen pixels wide. Full name, then surname, then nothing: shrinking the type
 * instead would make the deepest generation unreadable everywhere.
 */
function wedgeLabel(label: string, span: number, radius: number): { text: string; showDetail: boolean } {
  const arc = (span * Math.PI * radius) / 180;
  const chars = Math.floor(arc / 6.4);
  const parts = label.split(' ');
  const surname = parts.slice(-1)[0] ?? label;
  // "T. Keane" fits where "Thomas Keane" does not and still tells two Keanes
  // apart, so it is worth a tier of its own before falling back to the surname.
  const short = parts.length > 1 ? `${parts[0].slice(0, 1)}. ${surname}` : surname;

  if (chars >= label.length + 2) return { text: label, showDetail: chars >= label.length + 9 };
  if (chars >= short.length + 1) return { text: short, showDetail: false };
  if (chars >= surname.length + 1) return { text: surname, showDetail: false };
  if (chars >= 3) return { text: `${label.slice(0, chars - 1)}…`, showDetail: false };
  return { text: '', showDetail: false };
}

/**
 * Routes a parent link from the edge facing the child to the edge facing the
 * parent, with one elbow on the dominant axis. Working from the sign of the
 * delta rather than a fixed orientation means the same router draws a pedigree
 * (ancestors right), a descendant chart (children below) and an hourglass (both
 * directions) without per-kind code.
 */
function linkPath(parent: ChartBox, child: ChartBox): string {
  const pCx = parent.x + parent.w / 2;
  const pCy = parent.y + parent.h / 2;
  const cCx = child.x + child.w / 2;
  const cCy = child.y + child.h / 2;
  const dx = cCx - pCx;
  const dy = cCy - pCy;

  if (Math.abs(dx) >= Math.abs(dy)) {
    const x1 = dx >= 0 ? parent.x + parent.w : parent.x;
    const x2 = dx >= 0 ? child.x : child.x + child.w;
    const mx = (x1 + x2) / 2;
    return `M${x1},${pCy} H${mx} V${cCy} H${x2}`;
  }

  const y1 = dy >= 0 ? parent.y + parent.h : parent.y;
  const y2 = dy >= 0 ? child.y : child.y + child.h;
  const my = (y1 + y2) / 2;
  return `M${pCx},${y1} V${my} H${cCx} V${y2}`;
}

function ChartSvg({
  chart,
  onSelect,
  zoom,
  label,
}: {
  chart: ChartLayout;
  onSelect: (id: string) => void;
  zoom: 'fit' | 'full';
  label: string;
}) {
  const byId = new Map(chart.boxes.map((box) => [box.personId, box]));

  return (
    <svg
      className={`chart-svg is-${zoom}`}
      viewBox={`0 0 ${chart.width} ${chart.height}`}
      // Fit shrinks a deep pedigree into the column; actual size keeps the type
      // at 100% and lets the container scroll, which is the readable option once
      // a chart gets wide.
      width={zoom === 'full' ? chart.width : undefined}
      height={zoom === 'full' ? chart.height : undefined}
      // Capped at natural size: fit shrinks a wide chart, it never blows a small
      // one up to billboard size.
      style={zoom === 'fit' ? { width: '100%', maxWidth: chart.width, height: 'auto' } : undefined}
      role="img"
      aria-label={label}
    >
      <g className="chart-links">
        {chart.links.flatMap((link) => {
          const child = byId.get(link.childId);
          if (!child) return [];
          const adopted = link.pedigree !== undefined && link.pedigree !== 'birth';
          return link.parentIds.flatMap((parentId) => {
            const parent = byId.get(parentId);
            if (!parent) return [];
            return [
              <path
                key={`${link.key}:${parentId}`}
                className={`chart-link${adopted ? ' is-adopted' : ''}`}
                d={linkPath(parent, child)}
              />,
            ];
          });
        })}
      </g>

      {chart.boxes.map((box) => (
        <g
          key={box.personId}
          className={`chart-node sex-${box.sex.toLowerCase()}${box.role === 'focus' ? ' is-focus' : ''}`}
          onClick={() => onSelect(box.personId)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelect(box.personId);
            }
          }}
          role="button"
          tabIndex={0}
        >
          <title>{box.detail ? `${box.label} (${box.detail})` : box.label}</title>
          <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={7} />
          <rect className="chart-accent" x={box.x} y={box.y} width={4} height={box.h} rx={2} />
          <text className="chart-name" x={box.x + box.w / 2} y={box.y + box.h / 2 - 2} textAnchor="middle">
            {fit(box.label, box.w)}
          </text>
          <text className="chart-detail" x={box.x + box.w / 2} y={box.y + box.h / 2 + 13} textAnchor="middle">
            {box.detail || ' '}
          </text>
        </g>
      ))}

      {chart.wedges.map((wedge) => {
        // The focus is a half disc, so its label is horizontal in the middle.
        const label =
          wedge.generation === 0
            ? { text: wedge.label, showDetail: Boolean(wedge.detail) }
            : wedgeLabel(wedge.label, wedge.span, wedge.midRadius);

        return (
          <g
            key={wedge.personId}
            className={`chart-wedge sex-${wedge.sex.toLowerCase()}${wedge.generation === 0 ? ' is-focus' : ''}`}
            onClick={() => onSelect(wedge.personId)}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(wedge.personId);
              }
            }}
          >
            <title>{wedge.detail ? `${wedge.label} (${wedge.detail})` : wedge.label}</title>
            <path d={wedge.d} />
            {label.text && (
              <text
                className="chart-name"
                transform={`rotate(${wedge.labelRotation} ${wedge.labelX} ${wedge.labelY})`}
                x={wedge.labelX}
                y={wedge.labelY + (label.showDetail ? -3 : 0)}
                textAnchor="middle"
              >
                {label.text}
              </text>
            )}
            {label.showDetail && wedge.detail && (
              <text
                className="chart-detail"
                transform={`rotate(${wedge.labelRotation} ${wedge.labelX} ${wedge.labelY})`}
                x={wedge.labelX}
                y={wedge.labelY + 11}
                textAnchor="middle"
              >
                {wedge.detail}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export default function ChartView({ tree, focusId, onSelect }: Props) {
  const { t, life } = useI18n();
  const [kind, setKind] = useState<ChartKind>('pedigree');
  const [generationsUp, setGenerationsUp] = useState(3);
  const [generationsDown, setGenerationsDown] = useState(2);
  const [zoom, setZoom] = useState<'fit' | 'full'>('fit');

  const chart = useMemo(
    () =>
      layoutChart(tree, {
        kind,
        focusId,
        ancestors: generationsUp,
        descendants: generationsDown,
        formatDetail: life,
      }),
    [tree, kind, focusId, generationsUp, generationsDown, life],
  );

  const focus = tree.persons.find((person) => person.id === focusId);
  const needsUp = kind === 'pedigree' || kind === 'hourglass' || kind === 'fan';
  const needsDown = kind === 'descendant' || kind === 'hourglass';
  const upMax = kind === 'fan' ? 5 : 6;

  return (
    <div className="chart">
      <div className="chart-head">
        <div>
          <h2>{focus ? personName(focus) : t('view.chart')}</h2>
          <p className="subtle">
            {chart.boxes.length || chart.wedges.length ? t('chart.hint') : t('chart.empty')}
          </p>
        </div>
      </div>

      <div className="chart-controls">
        <div className="segmented" style={{ maxWidth: 260 }}>
          {KINDS.map((entry) => (
            <button
              key={entry}
              className={`seg${kind === entry ? ' is-active' : ''}`}
              onClick={() => setKind(entry)}
            >
              {t(`chart.kind.${entry}`)}
            </button>
          ))}
        </div>

        <div className="chart-sliders">
          {needsUp && (
            <label className="slider-row">
              <span>
                {t('chart.ancestors')} <b>{generationsUp}</b>
              </span>
              <input
                type="range"
                min={1}
                max={upMax}
                value={Math.min(generationsUp, upMax)}
                onChange={(event) => setGenerationsUp(Number(event.target.value))}
              />
            </label>
          )}
          {needsDown && (
            <label className="slider-row">
              <span>
                {t('chart.descendants')} <b>{generationsDown}</b>
              </span>
              <input
                type="range"
                min={1}
                max={4}
                value={generationsDown}
                onChange={(event) => setGenerationsDown(Number(event.target.value))}
              />
            </label>
          )}
        </div>

        <div className="segmented chart-zoom">
          <button className={`seg${zoom === 'fit' ? ' is-active' : ''}`} onClick={() => setZoom('fit')}>
            {t('chart.fit')}
          </button>
          <button className={`seg${zoom === 'full' ? ' is-active' : ''}`} onClick={() => setZoom('full')}>
            {t('chart.actual')}
          </button>
        </div>
      </div>

      {chart.boxes.length || chart.wedges.length ? (
        <div className="chart-scroll">
          <ChartSvg
            chart={chart}
            onSelect={onSelect}
            zoom={zoom}
            label={t('chart.aria', { kind: t(`chart.kind.${kind}`) })}
          />
        </div>
      ) : (
        <p className="empty-small">{t('chart.notInTree')}</p>
      )}

      {chart.notes.length > 0 && (
        <ul className="chart-notes">
          {chart.notes.map((note) => (
            <li key={`${note.key}:${JSON.stringify(note.params ?? {})}`}>{t(note)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
