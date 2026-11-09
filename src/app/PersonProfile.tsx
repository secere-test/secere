import { relativesOf } from '../core/relations';
import { isLiving, personName, type MediaBlobStore, type Person, type TreeData } from '../core/types';
import { MediaTile } from './MediaImg';
import { useI18n } from './i18n';

interface Props {
  tree: TreeData;
  person: Person;
  blobs: MediaBlobStore;
  picked: boolean;
  onSelect: (id: string) => void;
  onTogglePick: () => void;
  onAnchor: () => void;
}

function Chip({ person, onSelect }: { person: Person; onSelect: (id: string) => void }) {
  const { life } = useI18n();
  return (
    <button className="chip" onClick={() => onSelect(person.id)}>
      <span className={`sex-dot sex-${person.sex.toLowerCase()}`} aria-hidden="true" />
      {personName(person)}
      <span className="chip-years">{life(person)}</span>
    </button>
  );
}

export default function PersonProfile({ tree, person, blobs, picked, onSelect, onTogglePick, onAnchor }: Props) {
  const { t, date, life, eventName, pedigree, certainty } = useI18n();
  const { parents, groups, siblings } = relativesOf(tree, person.id);
  const living = isLiving(person);
  const events = [...person.events].sort((a, b) => (a.date?.from ?? '9999').localeCompare(b.date?.from ?? '9999'));
  const media = person.mediaIds
    .map((id) => tree.media.find((m) => m.id === id))
    .filter((ref): ref is NonNullable<typeof ref> => Boolean(ref));

  const years = life(person);

  return (
    <article className="profile">
      <header className="profile-head">
        <div>
          <p className="eyebrow">
            {t(`sex.${person.sex}`)}
            {living ? ` · ${t('profile.living')}` : ''}
            {person.privacy !== 'public' ? ` · ${t(`privacy.${person.privacy}`)}` : ''}
          </p>
          <h2>
            {personName(person)}
            {years && <span className="profile-years">{years}</span>}
          </h2>
          {person.names.length > 1 && (
            <p className="subtle">
              {t('profile.alsoRecordedAs', {
                names: person.names
                  .slice(1)
                  .map((n) => [n.given, n.surname].filter(Boolean).join(' '))
                  .join('; '),
              })}
            </p>
          )}
          {person.tags.length > 0 && (
            <p className="tags">
              {person.tags.map((tag) => (
                <span key={tag} className="badge badge-quiet">
                  {tag}
                </span>
              ))}
            </p>
          )}
        </div>

        <div className="profile-actions">
          <button className={picked ? 'primary' : 'ghost'} onClick={onTogglePick}>
            {picked ? t('profile.inSlice') : t('profile.addToSlice')}
          </button>
          <button className="ghost" onClick={onAnchor}>
            {t('profile.anchor')}
          </button>
        </div>
      </header>

      <section className="block">
        <h3>{t('family.heading')}</h3>
        {parents.length > 0 && (
          <div className="relation-row">
            <span className="relation-label">{t('family.parents')}</span>
            <div className="chips">
              {parents.map((parent) => (
                <Chip key={parent.id} person={parent} onSelect={onSelect} />
              ))}
            </div>
          </div>
        )}

        {siblings.length > 0 && (
          <div className="relation-row">
            <span className="relation-label">{t('family.siblings')}</span>
            <div className="chips">
              {siblings.map((sibling) => (
                <Chip key={sibling.id} person={sibling} onSelect={onSelect} />
              ))}
            </div>
          </div>
        )}

        {groups.map((group) => {
          const marriage = group.union.events.find((event) => event.type === 'MARR' || event.type === 'DIV');
          return (
            <div className="union-card" key={group.union.id}>
              <div className="union-head">
                <span className="relation-label">
                  {group.counterpart
                    ? t('family.with', { name: personName(group.counterpart) })
                    : t('family.noPartner')}
                </span>
                {marriage && (
                  <span className="subtle">
                    {eventName(marriage.type)} {date(marriage.date)}
                    {marriage.place ? ` · ${marriage.place}` : ''}
                  </span>
                )}
              </div>
              {group.children.length > 0 ? (
                <div className="chips">
                  {group.children.map((child) => {
                    const link = group.union.childLinks?.[child.id];
                    return (
                      <span className="chip-wrap" key={child.id}>
                        <Chip person={child} onSelect={onSelect} />
                        {link && link.pedigree !== 'birth' && (
                          <span className="badge badge-quiet">{pedigree(link.pedigree)}</span>
                        )}
                      </span>
                    );
                  })}
                </div>
              ) : (
                <p className="subtle">{t('family.noChildren')}</p>
              )}
            </div>
          );
        })}

        {parents.length === 0 && groups.length === 0 && siblings.length === 0 && (
          <p className="subtle">{t('family.none')}</p>
        )}
      </section>

      <section className="block">
        <h3>{t('timeline.heading')}</h3>
        {events.length === 0 ? (
          <p className="subtle">{t('timeline.empty')}</p>
        ) : (
          <ol className="timeline">
            {events.map((event) => {
              const disputed = certainty(event.certainty);
              return (
                <li key={event.id}>
                  <span className="timeline-date">{date(event.date) || '—'}</span>
                  <span className="timeline-body">
                    <strong>{eventName(event.type, event.label)}</strong>
                    {/* "1 OCCU Creamery manager": the fact's own text. */}
                    {event.value && <span className="timeline-value">{event.value}</span>}
                    {event.place && <span className="timeline-place">{event.place}</span>}
                    {event.note && <span className="timeline-note">{event.note}</span>}
                    {disputed && <span className="badge badge-quiet">{disputed}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className="block">
        <h3>
          {t('media.heading')} <span className="count">{media.length}</span>
        </h3>
        {media.length === 0 ? (
          <p className="subtle">{t('media.empty')}</p>
        ) : (
          <div className="media-grid">
            {media.map((ref) => (
              <MediaTile key={ref.id} asset={ref} blobs={blobs} />
            ))}
          </div>
        )}
        <p className="footnote">{t('media.footnote')}</p>
      </section>

      <section className="block">
        <h3>{t('notes.heading')}</h3>
        {person.notes.filter((note) => !note.isPrivate).length === 0 ? (
          <p className="subtle">{t('notes.empty')}</p>
        ) : (
          person.notes
            .filter((note) => !note.isPrivate)
            .map((note) => <p key={note.id}>{note.body}</p>)
        )}
        {person.notes.some((note) => note.isPrivate) && <p className="footnote">{t('notes.private')}</p>}
      </section>
    </article>
  );
}
