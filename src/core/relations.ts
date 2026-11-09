import { buildIndex, type Index } from './subset';
import { personName, type ID, type Person, type TreeData, type Union } from './types';

export interface FamilyGroup {
  union: Union;
  partners: Person[];
  children: Person[];
  /** The partner of the focus person in this union, if any. */
  counterpart?: Person;
}

export interface RelativeView {
  parents: Person[];
  groups: FamilyGroup[];
  siblings: Person[];
  index: Index;
}

export function relativesOf(tree: TreeData, personId: ID): RelativeView {
  const index = buildIndex(tree);
  const person = index.personById.get(personId);
  const parents: Person[] = [];
  const groups: FamilyGroup[] = [];
  const siblings = new Set<Person>();

  if (!person) return { parents: [], groups: [], siblings: [], index };

  for (const unionId of index.unionsByChild.get(personId) ?? []) {
    const union = index.unionById.get(unionId);
    if (!union) continue;
    for (const id of union.partnerIds) {
      const parent = index.personById.get(id);
      if (parent) parents.push(parent);
    }
    for (const id of union.childIds) {
      if (id === personId) continue;
      const sibling = index.personById.get(id);
      if (sibling) siblings.add(sibling);
    }
  }

  for (const unionId of index.unionsByPartner.get(personId) ?? []) {
    const union = index.unionById.get(unionId);
    if (!union) continue;
    const partners = union.partnerIds
      .map((id) => index.personById.get(id))
      .filter((p): p is Person => Boolean(p));
    const children = union.childIds
      .map((id) => index.personById.get(id))
      .filter((p): p is Person => Boolean(p));
    groups.push({
      union,
      partners,
      children,
      counterpart: partners.find((p) => p.id !== personId),
    });
  }

  return { parents, groups, siblings: [...siblings], index };
}

/** People sorted for the sidebar: surname, then given name. */
export function browseOrder(tree: TreeData): Person[] {
  return [...tree.persons].sort((a, b) => {
    const an = a.names[0];
    const bn = b.names[0];
    const last = (an?.surname ?? '').localeCompare(bn?.surname ?? '');
    if (last !== 0) return last;
    return (an?.given ?? '').localeCompare(bn?.given ?? '');
  });
}

export function displaySortName(person: Person): string {
  const n = person.names[0];
  return n ? `${n.surname}, ${n.given}` : personName(person);
}
