import type { DuplicateCandidate } from '../core/duplicates';
import { sortName, type Person, type TreeData } from '../core/types';
import { useI18n } from './i18n';

interface Props {
  tree: TreeData;
  pairs: DuplicateCandidate[];
  onMerge: (keepId: string, dropId: string) => void;
  onOpen: (id: string) => void;
}

/** What the reader needs to tell two candidate records apart at a glance. */
function RecordCard({
  person,
  tree,
  onKeep,
  onOpen,
}: {
  person: Person;
  tree: TreeData;
  onKeep: () => void;
  onOpen: () => void;
}) {
  const { t, n, life } = useI18n();
  const birth = person.events.find((e) => e.type === 'BIRT' || e.type === 'CHR');
  const families = tree.unions.filter((u) => u.partnerIds.includes(person.id));
  const children = new Set(families.flatMap((u) => u.childIds)).size;

  const facts = [
    t(`sex.${person.sex}`),
    n('count.facts', person.events.length),
    birth?.place ? t('merge.born', { place: birth.place }) : '',
    children ? n('count.children', children) : '',
    person.mediaIds.length ? n('count.mediaItems', person.mediaIds.length) : '',
  ].filter(Boolean);

  return (
    <article className="merge-side">
      <header>
        <button className="link merge-name" onClick={onOpen} title={t('merge.open')}>
          {sortName(person)}
        </button>
        <span className="subtle">{life(person) || t('merge.noDates')}</span>
      </header>

      <p className="merge-facts subtle">{facts.join(' · ')}</p>

      <p className="merge-id subtle">{person.id}</p>

      <button className="ghost merge-keep" onClick={onKeep}>
        {t('merge.keep')}
      </button>
    </article>
  );
}

export default function MergeView({ tree, pairs, onMerge, onOpen }: Props) {
  const { t } = useI18n();

  return (
    <section className="merge">
      <div className="chart-head">
        <div>
          <h2>{t('merge.heading')}</h2>
          <p className="subtle">{t('merge.intro')}</p>
        </div>
      </div>

      {pairs.length === 0 ? (
        <div className="empty">{t('merge.empty')}</div>
      ) : (
        <ul className="merge-list">
          {pairs.map((pair) => (
            <li key={`${pair.a.id}|${pair.b.id}`} className="merge-pair">
              <div className="merge-why">
                <span className="merge-score">{Math.round(pair.score * 100)}%</span>
                <span className="subtle">{pair.reasons.map((reason) => t(reason)).join(' · ')}</span>
              </div>

              <div className="merge-sides">
                <RecordCard
                  person={pair.a}
                  tree={tree}
                  onKeep={() => onMerge(pair.a.id, pair.b.id)}
                  onOpen={() => onOpen(pair.a.id)}
                />
                <RecordCard
                  person={pair.b}
                  tree={tree}
                  onKeep={() => onMerge(pair.b.id, pair.a.id)}
                  onOpen={() => onOpen(pair.b.id)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="subtle merge-foot">{t('merge.footnote')}</p>
    </section>
  );
}
