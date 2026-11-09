import { useMemo, useState } from 'react';
import { displaySortName } from '../core/relations';
import type { Person } from '../core/types';
import { useI18n } from './i18n';

interface Props {
  people: Person[];
  selectedId: string;
  onSelect: (id: string) => void;
  pickedIds: string[];
}

export default function PersonList({ people, selectedId, onSelect, pickedIds }: Props) {
  const { t, life } = useI18n();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return people;
    return people.filter((person) => {
      const names = person.names.map((n) => `${n.given} ${n.surname} ${n.nickname ?? ''}`).join(' ').toLowerCase();
      const places = person.events.map((e) => e.place ?? '').join(' ').toLowerCase();
      return names.includes(needle) || places.includes(needle);
    });
  }, [people, query]);

  return (
    <div className="person-list">
      <label className="search">
        <span className="sr-only">{t('list.searchLabel')}</span>
        <input
          type="search"
          placeholder={t('list.searchPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <p className="list-count subtle">
        {t('list.count', { shown: filtered.length, total: people.length })}
      </p>

      <ul>
        {filtered.map((person) => {
          const picked = pickedIds.includes(person.id);
          return (
            <li key={person.id}>
              <button
                className={`person-row${person.id === selectedId ? ' is-selected' : ''}`}
                onClick={() => onSelect(person.id)}
              >
                <span className={`sex-dot sex-${person.sex.toLowerCase()}`} aria-hidden="true" />
                <span className="person-row-text">
                  <span className="person-row-name">{displaySortName(person)}</span>
                  <span className="person-row-meta">
                    {life(person) || t('list.datesUnknown')}
                    {person.tags.length > 0 && <em className="tag-inline">{person.tags[0]}</em>}
                  </span>
                </span>
                {picked && (
                  <span className="pick-mark" title={t('list.pickMark')}>
                    ●
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {filtered.length === 0 && <p className="empty-small">{t('list.noMatch', { query })}</p>}
    </div>
  );
}
