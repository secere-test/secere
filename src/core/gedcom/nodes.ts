/**
 * A minimal, dependency-free GEDCOM 5.5.1 line parser/serializer.
 *
 * We parse into a generic node tree first and only then interpret it into the
 * model. That separation matters: real-world files contain vendor tags we do
 * not model, and a generic tree lets us preserve or skip them without the
 * interpreter having to know about them.
 */

export interface GdNode {
  level: number;
  xref?: string;
  tag: string;
  value: string;
  children: GdNode[];
}

const LINE = /^(\d+)[ \t]+(?:(@[^@]+@)[ \t]+)?([A-Za-z0-9_]+)(?:[ \t]([\s\S]*))?$/;

export function parseGedcomTree(text: string): GdNode[] {
  const roots: GdNode[] = [];
  const stack: GdNode[] = [];

  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;

    const m = LINE.exec(line);
    if (!m) continue; // tolerate junk rather than failing the whole import

    const level = Number(m[1]);
    const xref = m[2]?.replace(/@/g, '');
    const tag = m[3].toUpperCase();
    const value = m[4] ?? '';

    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack[stack.length - 1];

    // Continuation lines belong to the previous value, not to a new node.
    if (parent && (tag === 'CONT' || tag === 'CONC')) {
      parent.value += (tag === 'CONT' ? '\n' : '') + value;
      continue;
    }

    const node: GdNode = { level, xref, tag, value, children: [] };
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }

  return roots;
}

const MAX_LINE = 200;

function pushLine(out: string[], level: number, node: Pick<GdNode, 'xref' | 'tag' | 'value'>): void {
  const head = [String(level), node.xref ? `@${node.xref}@` : '', node.tag].filter(Boolean).join(' ');
  const paragraphs = node.value.split('\n');

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const chunks = paragraph.length
      ? paragraph.match(new RegExp(`[\\s\\S]{1,${MAX_LINE}}`, 'g')) ?? []
      : [''];

    chunks.forEach((chunk, chunkIndex) => {
      if (paragraphIndex === 0 && chunkIndex === 0) {
        out.push(chunk ? `${head} ${chunk}` : head);
      } else if (chunkIndex === 0) {
        out.push(chunk ? `${level + 1} CONT ${chunk}` : `${level + 1} CONT`);
      } else {
        out.push(`${level + 1} CONC ${chunk}`);
      }
    });
  });
}

export function serializeGedcomTree(roots: GdNode[]): string {
  const out: string[] = [];
  const walk = (node: GdNode): void => {
    pushLine(out, node.level, node);
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  out.push('0 TRLR');
  return out.join('\n') + '\n';
}

export function child(node: GdNode | undefined, tag: string): GdNode | undefined {
  return node?.children.find((c) => c.tag === tag);
}

export function children(node: GdNode | undefined, tag: string): GdNode[] {
  return node?.children.filter((c) => c.tag === tag) ?? [];
}

export function node(tag: string, value = '', children: GdNode[] = [], xref?: string): GdNode {
  return { level: 0, xref, tag, value, children };
}

/** Re-level a freshly built subtree so levels are consistent from `start`. */
export function relevel(nodes: GdNode[], start = 0): GdNode[] {
  const fix = (n: GdNode, level: number): void => {
    n.level = level;
    for (const c of n.children) fix(c, level + 1);
  };
  for (const n of nodes) fix(n, start);
  return nodes;
}
