/**
 * Charts: pedigree, descendant, hourglass and fan.
 *
 * The model is a cyclic-capable graph (see types.ts), so chart layout cannot
 * assume a clean binary tree. Everything here therefore:
 *
 *   - draws each person at most once, even when pedigree collapse means the
 *     same ancestor is reachable by two paths (the links still show both);
 *   - treats a data loop as a note, never a hang;
 *   - reserves a slot for a missing ancestor, so a fan or pedigree keeps its
 *     shape instead of collapsing into a lopsided spiral.
 *
 * Layout is pure geometry, returned as plain boxes and links. The renderer only
 * turns coordinates into SVG, which is what makes the layout testable without a
 * DOM and reusable for print or canvas later.
 */

import { buildIndex, type Index } from './subset';
import type { Msg } from './i18n';
import {
  lifespan,
  personName,
  type ID,
  type Pedigree,
  type Person,
  type Sex,
  type TreeData,
  type Union,
} from './types';

export type ChartKind = 'pedigree' | 'descendant' | 'hourglass' | 'fan';

export interface ChartOptions {
  kind: ChartKind;
  focusId: ID;
  /** Generations upwards: pedigree, hourglass and fan. */
  ancestors?: number;
  /** Generations downwards: descendant and hourglass. */
  descendants?: number;
  /**
   * How a person's dates read under their name. Left to the caller so the
   * layout stays language-free: the app passes a localised lifespan.
   */
  formatDetail?: (person: Person) => string;
}

export interface ChartBox {
  personId: ID;
  generation: number;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  detail: string;
  sex: Sex;
  role: 'focus' | 'ancestor' | 'descendant';
}

export interface ChartLink {
  key: string;
  childId: ID;
  parentIds: ID[];
  /** Non-birth links (adoption, step, foster) are drawn dashed. */
  pedigree?: Pedigree;
}

export interface FanWedge {
  personId: ID;
  generation: number;
  /** SVG sector path, in absolute coordinates. */
  d: string;
  label: string;
  detail: string;
  sex: Sex;
  labelX: number;
  labelY: number;
  /** Degrees; fan labels run tangentially. */
  labelRotation: number;
  /** Angular width in degrees, so the renderer can drop labels that cannot fit. */
  span: number;
  /** Radius at which the label sits, for working out how much text fits. */
  midRadius: number;
}

export interface ChartLayout {
  kind: ChartKind;
  width: number;
  height: number;
  boxes: ChartBox[];
  links: ChartLink[];
  wedges: FanWedge[];
  notes: Msg[];
}

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

// Box charts ---------------------------------------------------------------

interface Geometry {
  boxW: number;
  boxH: number;
  /** Distance between generations. */
  genPitch: number;
  /** Distance between parallel branches. */
  lanePitch: number;
  pad: number;
}

const PEDIGREE: Geometry = { boxW: 172, boxH: 46, genPitch: 210, lanePitch: 60, pad: 22 };
const DESCENDANT: Geometry = { boxW: 140, boxH: 44, genPitch: 92, lanePitch: 154, pad: 22 };
const HOURGLASS_UP: Geometry = { boxW: 142, boxH: 44, genPitch: 196, lanePitch: 58, pad: 22 };
const HOURGLASS_DOWN: Geometry = { boxW: 142, boxH: 44, genPitch: 190, lanePitch: 88, pad: 22 };

const SEX_RANK: Record<Sex, number> = { M: 0, F: 1, U: 2 };

function parentSet(
  index: Index,
  id: ID,
  notes: Msg[],
): { partners: Person[]; union: Union; pedigree?: Pedigree } | null {
  const candidateIds = (index.unionsByChild.get(id) ?? []).filter((unionId) => {
    const union = index.unionById.get(unionId);
    return Boolean(union && union.partnerIds.length);
  });

  if (candidateIds.length > 1) {
    notes.push({ key: 'chart.note.multipleParents' });
  }

  for (const unionId of candidateIds) {
    const union = index.unionById.get(unionId);
    if (!union) continue;
    const partners = union.partnerIds
      .map((pid) => index.personById.get(pid))
      .filter((person): person is Person => Boolean(person))
      // Fathers above mothers is the convention readers expect; unknown sex last.
      .sort((a, b) => SEX_RANK[a.sex] - SEX_RANK[b.sex]);
    if (!partners.length) continue;
    return { partners: partners.slice(0, 2), union, pedigree: union.childLinks?.[id]?.pedigree };
  }

  return null;
}

function childrenOf(index: Index, id: ID): Person[] {
  const out: Person[] = [];
  const seen = new Set<ID>();
  for (const unionId of index.unionsByPartner.get(id) ?? []) {
    const union = index.unionById.get(unionId);
    if (!union) continue;
    for (const childId of union.childIds) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      const child = index.personById.get(childId);
      if (child) out.push(child);
    }
  }
  return out;
}

interface AncestorNode {
  personId: ID;
  generation: number;
  parents: AncestorNode[];
  lane?: number;
  pedigree?: Pedigree;
}

interface DescendantNode {
  personId: ID;
  generation: number;
  children: DescendantNode[];
  lane?: number;
}

function buildAncestors(
  index: Index,
  focusId: ID,
  depth: number,
  notes: Msg[],
): { root: AncestorNode; nodes: AncestorNode[] } | null {
  if (!index.personById.has(focusId)) return null;

  const byPerson = new Map<ID, AncestorNode>();
  const nodes: AncestorNode[] = [];
  let cut = false;

  const build = (personId: ID, generation: number): AncestorNode | null => {
    const existing = byPerson.get(personId);
    if (existing) {
      // The same person reachable twice at the same depth is ordinary pedigree
      // collapse: share the box. Seeing them at a different depth can only be a
      // loop in the data, and sharing a box there would make lane assignment
      // recurse forever, so the loop is cut and declared.
      if (existing.generation !== generation) {
        notes.push({ key: 'chart.note.loopParents' });
        return null;
      }
      return existing;
    }

    const node: AncestorNode = { personId, generation, parents: [] };
    byPerson.set(personId, node);
    nodes.push(node);

    if (generation >= depth) {
      cut = cut || Boolean(parentSet(index, personId, []));
      return node;
    }

    const set = parentSet(index, personId, notes);
    if (!set) return node;

    node.pedigree = set.pedigree;
    for (const partner of set.partners) {
      const parent = build(partner.id, generation + 1);
      if (parent) node.parents.push(parent);
    }
    return node;
  };

  const root = build(focusId, 0);
  if (!root) return null;

  if (cut)
    notes.push({
      key: depth === 1 ? 'chart.note.ancestorDepth' : 'chart.note.ancestorDepthPlural',
      params: { count: depth },
    });

  // Lanes: leaves get successive slots in father-first order, and each person
  // sits between their parents. Because the DFS row sets are contiguous and
  // disjoint, two people in the same generation never share a lane.
  let leaf = 0;
  const assign = (node: AncestorNode): number => {
    if (node.lane !== undefined) return node.lane;
    if (!node.parents.length) {
      node.lane = leaf++;
      return node.lane;
    }
    const lanes = node.parents.map(assign);
    node.lane = (Math.min(...lanes) + Math.max(...lanes)) / 2;
    return node.lane;
  };
  assign(root);

  return { root, nodes };
}

function buildDescendants(
  index: Index,
  focusId: ID,
  depth: number,
  notes: Msg[],
): { root: DescendantNode; nodes: DescendantNode[] } | null {
  if (!index.personById.has(focusId)) return null;

  const byPerson = new Map<ID, DescendantNode>();
  const nodes: DescendantNode[] = [];
  let cut = false;

  const build = (personId: ID, generation: number): DescendantNode | null => {
    const existing = byPerson.get(personId);
    if (existing) {
      if (existing.generation !== generation) {
        notes.push({ key: 'chart.note.loopChildren' });
        return null;
      }
      return existing;
    }

    const node: DescendantNode = { personId, generation, children: [] };
    byPerson.set(personId, node);
    nodes.push(node);

    if (generation >= depth) {
      cut = cut || childrenOf(index, personId).length > 0;
      return node;
    }

    for (const child of childrenOf(index, personId)) {
      const childNode = build(child.id, generation + 1);
      if (childNode) node.children.push(childNode);
    }
    return node;
  };

  const root = build(focusId, 0);
  if (!root) return null;

  if (cut) {
    notes.push({
      key: depth === 1 ? 'chart.note.descendantDepth' : 'chart.note.descendantDepthPlural',
      params: { count: depth },
    });
  }

  // Lanes: leaves take successive slots, parents centre over their children.
  let cursor = 0;
  const assign = (node: DescendantNode) => {
    if (node.lane !== undefined) return;
    if (!node.children.length) {
      node.lane = cursor + 0.5;
      cursor += 1;
      return;
    }
    const start = cursor;
    for (const child of node.children) assign(child);
    node.lane = (start + cursor) / 2;
  };
  assign(root);

  return { root, nodes };
}

function toBox(
  index: Index,
  personId: ID,
  generation: number,
  role: ChartBox['role'],
  geo: Geometry,
  formatDetail: (person: Person) => string,
): Omit<ChartBox, 'x' | 'y'> | null {
  const person = index.personById.get(personId);
  if (!person) return null;
  return {
    personId,
    generation,
    w: geo.boxW,
    h: geo.boxH,
    label: personName(person),
    detail: formatDetail(person),
    sex: person.sex,
    role,
  };
}

/** Shifts everything into the positive quadrant and sizes the drawing. */
function normalize(boxes: ChartBox[], pad: number): { width: number; height: number } {
  if (!boxes.length) return { width: 0, height: 0 };
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  for (const box of boxes) {
    box.x += pad - minX;
    box.y += pad - minY;
  }
  const width = Math.max(...boxes.map((b) => b.x + b.w)) + pad;
  const height = Math.max(...boxes.map((b) => b.y + b.h)) + pad;
  return { width: Math.ceil(width), height: Math.ceil(height) };
}

function ancestorLinks(root: AncestorNode): ChartLink[] {
  const links: ChartLink[] = [];
  const seen = new Set<ID>();
  const walk = (node: AncestorNode) => {
    if (node.parents.length && !seen.has(node.personId)) {
      seen.add(node.personId);
      links.push({
        key: node.personId,
        childId: node.personId,
        parentIds: node.parents.map((p) => p.personId),
        pedigree: node.pedigree,
      });
    }
    for (const parent of node.parents) walk(parent);
  };
  walk(root);
  return links;
}

function descendantLinks(root: DescendantNode): ChartLink[] {
  const links: ChartLink[] = [];
  const seen = new Set<string>();
  const walk = (node: DescendantNode) => {
    for (const child of node.children) {
      const key = `${node.personId}->${child.personId}`;
      if (!seen.has(key)) {
        seen.add(key);
        links.push({ key, childId: child.personId, parentIds: [node.personId] });
      }
      walk(child);
    }
  };
  walk(root);
  return links;
}

// Public layout entry points ----------------------------------------------

export function layoutChart(tree: TreeData, options: ChartOptions): ChartLayout {
  const kind = options.kind;
  if (kind === 'fan') return layoutFan(tree, options);

  const index = buildIndex(tree);
  const notes: Msg[] = [];
  const detail = options.formatDetail ?? lifespan;
  const up = clamp(Math.round(options.ancestors ?? 3), 1, 6);
  const down = clamp(Math.round(options.descendants ?? 3), 1, 4);

  if (kind === 'pedigree') {
    const built = buildAncestors(index, options.focusId, up, notes);
    if (!built) return emptyLayout(kind, options.focusId);
    const geo = PEDIGREE;
    const focusLane = built.root.lane ?? 0;

    const boxes = built.nodes
      .map((node) => {
        const base = toBox(index, node.personId, node.generation, node.generation === 0 ? 'focus' : 'ancestor', geo, detail);
        if (!base) return null;
        return {
          ...base,
          x: node.generation * geo.genPitch,
          y: ((node.lane ?? 0) - focusLane) * geo.lanePitch,
        };
      })
      .filter((box): box is ChartBox => Boolean(box));

    if (!built.root.parents.length) notes.push({ key: 'chart.note.noParents' });
    const size = normalize(boxes, geo.pad);
    return { kind, ...size, boxes, links: ancestorLinks(built.root), wedges: [], notes };
  }

  if (kind === 'descendant') {
    const built = buildDescendants(index, options.focusId, down, notes);
    if (!built) return emptyLayout(kind, options.focusId);
    const geo = DESCENDANT;

    const boxes = built.nodes
      .map((node) => {
        const base = toBox(index, node.personId, node.generation, node.generation === 0 ? 'focus' : 'descendant', geo, detail);
        if (!base) return null;
        return {
          ...base,
          x: (node.lane ?? 0) * geo.lanePitch,
          y: node.generation * geo.genPitch,
        };
      })
      .filter((box): box is ChartBox => Boolean(box));

    if (!built.root.children.length) notes.push({ key: 'chart.note.noChildren' });
    const size = normalize(boxes, geo.pad);
    return { kind, ...size, boxes, links: descendantLinks(built.root), wedges: [], notes };
  }

  // Hourglass: ancestors to the left, descendants to the right, focus centred.
  const ancestors = buildAncestors(index, options.focusId, up, notes);
  const descendants = buildDescendants(index, options.focusId, down, notes);
  if (!ancestors) return emptyLayout(kind, options.focusId);

  const upGeo = HOURGLASS_UP;
  const downGeo = HOURGLASS_DOWN;
  const focusLane = ancestors.root.lane ?? 0;

  const boxes: ChartBox[] = [];
  for (const node of ancestors.nodes) {
    const base = toBox(index, node.personId, node.generation, node.generation === 0 ? 'focus' : 'ancestor', upGeo, detail);
    if (!base) continue;
    boxes.push({
      ...base,
      // Grows leftwards: a pedigree read right-to-left.
      x: -node.generation * upGeo.genPitch,
      y: ((node.lane ?? 0) - focusLane) * upGeo.lanePitch,
    });
  }

  const downFocusLane = descendants?.root.lane ?? 0;
  for (const node of descendants?.nodes ?? []) {
    if (node.generation === 0) continue; // the focus box is already placed
    const base = toBox(index, node.personId, node.generation, 'descendant', downGeo, detail);
    if (!base) continue;
    boxes.push({
      ...base,
      x: node.generation * downGeo.genPitch,
      y: ((node.lane ?? 0) - downFocusLane) * downGeo.lanePitch,
    });
  }

  if (!ancestors.root.parents.length && !(descendants?.root.children.length ?? 0)) {
    notes.push({ key: 'chart.note.noneEither' });
  }

  const size = normalize(boxes, upGeo.pad);
  const links = [...ancestorLinks(ancestors.root), ...(descendants ? descendantLinks(descendants.root) : [])];
  return { kind, ...size, boxes, links, wedges: [], notes };
}

function emptyLayout(kind: ChartKind, focusId: ID): ChartLayout {
  return {
    kind,
    width: 0,
    height: 0,
    boxes: [],
    links: [],
    wedges: [],
    notes: [{ key: 'chart.note.notInTree', params: { id: focusId } }],
  };
}

// Fan ---------------------------------------------------------------------

const FAN_BAND = 64;
const FAN_PAD = 10;

function sector(cx: number, cy: number, inner: number, outer: number, a0: number, a1: number): string {
  const point = (radius: number, angle: number) => {
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    return `${x.toFixed(2)} ${y.toFixed(2)}`;
  };
  const large = a1 - a0 > Math.PI ? 1 : 0;

  if (inner <= 0.01) {
    return `M ${cx.toFixed(2)} ${cy.toFixed(2)} L ${point(outer, a0)} A ${outer} ${outer} 0 ${large} 1 ${point(outer, a1)} Z`;
  }
  return [
    `M ${point(inner, a0)}`,
    `L ${point(outer, a0)}`,
    `A ${outer} ${outer} 0 ${large} 1 ${point(outer, a1)}`,
    `L ${point(inner, a1)}`,
    `A ${inner} ${inner} 0 ${large} 0 ${point(inner, a0)}`,
    'Z',
  ].join(' ');
}

function layoutFan(tree: TreeData, options: ChartOptions): ChartLayout {
  const index = buildIndex(tree);
  const notes: Msg[] = [];
  const detail = options.formatDetail ?? lifespan;
  const generations = clamp(Math.round(options.ancestors ?? 4), 1, 6);

  if (!index.personById.has(options.focusId)) {
    return {
      kind: 'fan',
      width: 0,
      height: 0,
      boxes: [],
      links: [],
      wedges: [],
      notes: [{ key: 'chart.note.notInTree', params: { id: options.focusId } }],
    };
  }

  // Ahnentafel numbering: n -> father 2n, mother 2n+1. The numbering is what
  // fixes a person's angle, so a missing ancestor leaves a visible gap rather
  // than sliding every other wedge out of place.
  const slots = new Map<number, ID>();
  const fill = (personId: ID, n: number) => {
    if (slots.has(n)) return;
    slots.set(n, personId);
    const generation = Math.floor(Math.log2(n));
    if (generation >= generations) {
      if (parentSet(index, personId, [])) notes.push({ key: 'chart.note.ancestorDepthPlural', params: { count: generations } });
      return;
    }
    const set = parentSet(index, personId, notes);
    if (!set) return;
    set.partners.forEach((partner, i) => fill(partner.id, n * 2 + i));
  };
  fill(options.focusId, 1);

  const radius = (generations + 1) * FAN_BAND;
  const cx = radius + FAN_PAD;
  const cy = radius + FAN_PAD;
  const wedges: FanWedge[] = [];

  for (const [n, personId] of [...slots.entries()].sort((a, b) => a[0] - b[0])) {
    const person = index.personById.get(personId);
    if (!person) continue;

    const generation = Math.floor(Math.log2(n));
    const slot = n - 2 ** generation;
    const span = Math.PI / 2 ** generation;
    const a0 = Math.PI + slot * span;
    const mid = a0 + span / 2;
    const inner = generation * FAN_BAND;
    const outer = inner + FAN_BAND;
    const labelRadius = generation === 0 ? FAN_BAND / 2 : (inner + outer) / 2;

    wedges.push({
      personId,
      generation,
      d: sector(cx, cy, inner, outer, a0, a0 + span),
      label: personName(person),
      detail: detail(person),
      sex: person.sex,
      labelX: cx + labelRadius * Math.cos(mid),
      labelY: cy + labelRadius * Math.sin(mid),
      midRadius: labelRadius,
      // Tangential text: at the top of the arc this is horizontal, on the flanks
      // it runs with the radius, which is how fan charts are read.
      labelRotation: generation === 0 ? 0 : ((mid * 180) / Math.PI + 90) % 360,
      span: (span * 180) / Math.PI,
    });
  }

  const expected = 2 ** (generations + 1) - 1;
  const missing = expected - wedges.length;
  if (missing > 0) notes.push({ key: 'chart.note.emptySlots', params: { missing, expected } });
  if (!parentSet(index, options.focusId, [])) notes.push({ key: 'chart.note.noParents' });

  return {
    kind: 'fan',
    width: Math.ceil(radius * 2 + FAN_PAD * 2),
    height: Math.ceil(radius + FAN_PAD * 2),
    boxes: [],
    links: [],
    wedges,
    notes,
  };
}
