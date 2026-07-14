import { describe, expect, it } from 'vitest';
import { layoutFamilyTree, type LayoutEdge, type LayoutPerson } from './tree-layout';

const CARD = 150;
const GAP = 24;

function person(id: string, born?: string): LayoutPerson {
  return { id, displayName: id, bornOn: born ?? null };
}

function parent(from: string, to: string): LayoutEdge {
  return { type: 'parent', from, to };
}

function spouse(a: string, b: string): LayoutEdge {
  return { type: 'spouse', from: a, to: b };
}

/** Both parents of every child edge. */
function couple(a: string, b: string, children: string[]): LayoutEdge[] {
  return [
    spouse(a, b),
    ...children.flatMap((c) => [parent(a, c), parent(b, c)]),
  ];
}

function rowIndexOf(rows: { ids: string[] }[], id: string): number {
  return rows.findIndex((r) => r.ids.includes(id));
}

function posIn(rows: { ids: string[] }[], id: string): number {
  const row = rows.find((r) => r.ids.includes(id))!;
  return row.ids.indexOf(id);
}

/** Reconstruct each card's absolute left edge from the flow margins. */
function leftsOf(rows: { ids: string[] }[], margins: Map<string, number>) {
  const left = new Map<string, number>();
  for (const row of rows) {
    let flow = 0;
    for (const id of row.ids) {
      const l = flow + (margins.get(id) ?? 0);
      left.set(id, l);
      flow = l + CARD;
    }
  }
  return left;
}

const centerOf = (left: Map<string, number>, id: string) => left.get(id)! + CARD / 2;

describe('layoutFamilyTree', () => {
  it('handles empty input', () => {
    const res = layoutFamilyTree([], []);
    expect(res.rows).toEqual([]);
    expect(res.crossings).toBe(0);
  });

  it('orders siblings by birth date, not name', () => {
    const people = [
      person('Mom', '1960-01-01'),
      person('Dad', '1958-01-01'),
      person('Anton', '1990-05-01'), // alphabetically first, born last
      person('Zoe', '1985-05-01'), // alphabetically last, born first
    ];
    const edges = couple('Mom', 'Dad', ['Anton', 'Zoe']);
    const { rows } = layoutFamilyTree(people, edges);
    expect(posIn(rows, 'Zoe')).toBeLessThan(posIn(rows, 'Anton'));
  });

  it('keeps spouses adjacent in every row', () => {
    const people = [
      person('A'), person('B'), person('C'), person('D'),
      person('c1'), person('c2'), person('c3'),
    ];
    const edges = [
      ...couple('A', 'B', ['c1', 'c2']),
      ...couple('C', 'D', ['c3']),
    ];
    const { rows } = layoutFamilyTree(people, edges);
    for (const [a, b] of [['A', 'B'], ['C', 'D']]) {
      expect(rowIndexOf(rows, a)).toBe(rowIndexOf(rows, b));
      expect(Math.abs(posIn(rows, a) - posIn(rows, b))).toBe(1);
    }
  });

  it('places a marry-in on the outer side, next to their spouse, not between siblings', () => {
    // Grandparents with two sons; the younger son married someone from
    // outside the tree. The spouse must not separate the brothers.
    const people = [
      person('Opa', '1940-01-01'),
      person('Oma', '1942-01-01'),
      person('Bruno', '1965-01-01'),
      person('Carl', '1968-01-01'),
      person('Xenia', '1969-01-01'), // Carl's wife, no parents in tree
    ];
    const edges = [...couple('Opa', 'Oma', ['Bruno', 'Carl']), spouse('Carl', 'Xenia')];
    const { rows } = layoutFamilyTree(people, edges);
    const bruno = posIn(rows, 'Bruno');
    const carl = posIn(rows, 'Carl');
    const xenia = posIn(rows, 'Xenia');
    // Carl sits between his brother and his wife.
    expect(Math.abs(carl - xenia)).toBe(1);
    expect(Math.abs(carl - bruno)).toBe(1);
    expect(xenia === bruno).toBe(false);
  });

  it('lays out a two-family tree with a linking marriage without crossings', () => {
    // The shape from the app screenshot: two grandparent couples, their
    // children marry, plus siblings and a marry-in on each side.
    const people = [
      person('BjornH', '1938-01-01'), person('SilkeH', '1940-01-01'),
      person('ChristianS', '1936-01-01'), person('IngeburgS', '1938-01-01'),
      person('LauraN', '1962-01-01'), person('GerritN', '1960-01-01'),
      person('KathrinO', '1963-01-01'), person('KarstenO', '1961-01-01'),
      person('JasperN', '1988-01-01'), person('XaverN', '1990-01-01'),
      person('ChristophO', '1992-01-01'), person('NagoreN', '1993-01-01'),
      person('ClemensO', '1994-01-01'), person('ChiraH', '1995-01-01'),
      person('BrunoO', '2024-01-01'), person('AvaO', '2026-01-01'),
    ];
    const edges = [
      ...couple('BjornH', 'SilkeH', ['LauraN']),
      ...couple('ChristianS', 'IngeburgS', ['KathrinO']),
      ...couple('LauraN', 'GerritN', ['JasperN', 'XaverN']),
      ...couple('KathrinO', 'KarstenO', ['ChristophO', 'ClemensO']),
      spouse('ChristophO', 'NagoreN'),
      spouse('ClemensO', 'ChiraH'),
      ...['BrunoO'].flatMap((c) => [parent('ChristophO', c), parent('NagoreN', c)]),
      ...['AvaO'].flatMap((c) => [parent('ClemensO', c), parent('ChiraH', c)]),
    ];
    const { rows, crossings, margins } = layoutFamilyTree(people, edges);

    // This graph is planar as layered — the layout must find a 0-crossing order.
    expect(crossings).toBe(0);

    // Brothers Christoph and Clemens stay in one sibling run: only their
    // spouses may sit between them.
    const row = rows.find((r) => r.ids.includes('ClemensO'))!;
    const span = row.ids.slice(
      Math.min(row.ids.indexOf('ChristophO'), row.ids.indexOf('ClemensO')),
      Math.max(row.ids.indexOf('ChristophO'), row.ids.indexOf('ClemensO')) + 1,
    );
    for (const id of span) {
      expect(['ChristophO', 'ClemensO', 'NagoreN', 'ChiraH']).toContain(id);
    }

    // Parents are horizontally re-centered over their children: the
    // Kathrin+Karsten couple center sits within one card width of the
    // midpoint of their children's couples.
    const left = leftsOf(rows, margins);
    const parentsCenter = (centerOf(left, 'KathrinO') + centerOf(left, 'KarstenO')) / 2;
    const kidsCenter =
      (centerOf(left, 'ChristophO') +
        centerOf(left, 'NagoreN') +
        centerOf(left, 'ClemensO') +
        centerOf(left, 'ChiraH')) /
      4;
    expect(Math.abs(parentsCenter - kidsCenter)).toBeLessThanOrEqual(CARD + GAP);
  });

  it('never produces overlapping cards', () => {
    const people = [
      ...['A', 'B', 'C', 'D', 'E', 'F'].map((id) => person(id)),
      ...['k1', 'k2', 'k3', 'k4', 'k5'].map((id) => person(id)),
    ];
    const edges = [
      ...couple('A', 'B', ['k1', 'k2', 'k3']),
      ...couple('C', 'D', ['k4']),
      ...couple('E', 'F', ['k5']),
      spouse('k3', 'k4'),
    ];
    const { rows, margins } = layoutFamilyTree(people, edges);
    const left = leftsOf(rows, margins);
    for (const row of rows) {
      for (let i = 1; i < row.ids.length; i++) {
        const prevRight = left.get(row.ids[i - 1])! + CARD;
        expect(left.get(row.ids[i])!).toBeGreaterThanOrEqual(prevRight + GAP - 0.01);
      }
    }
    // No negative margins (renderer requirement).
    for (const m of margins.values()) expect(m).toBeGreaterThanOrEqual(-0.01);
  });

  it('is deterministic and stable when an unrelated person is added', () => {
    const people = [
      person('Mom', '1960-01-01'),
      person('Dad', '1958-01-01'),
      person('Kid1', '1985-01-01'),
      person('Kid2', '1988-01-01'),
    ];
    const edges = couple('Mom', 'Dad', ['Kid1', 'Kid2']);

    const a = layoutFamilyTree(people, edges);
    const b = layoutFamilyTree(people, edges);
    expect(a.rows).toEqual(b.rows);

    // Adding a disconnected person must not reorder existing family members.
    const c = layoutFamilyTree([...people, person('Stranger', '1950-01-01')], edges);
    for (const row of a.rows) {
      const rowC = c.rows.find((r) => row.ids.every((id) => r.ids.includes(id)))!;
      const filtered = rowC.ids.filter((id) => row.ids.includes(id));
      expect(filtered).toEqual(row.ids);
    }
  });

  it('packs disconnected families side by side instead of leaving a void', () => {
    const people = [
      person('A', '1960-01-01'), person('B', '1962-01-01'), person('k1', '1990-01-01'),
      person('C', '1961-01-01'), person('D', '1963-01-01'), person('k2', '1991-01-01'),
    ];
    const edges = [...couple('A', 'B', ['k1']), ...couple('C', 'D', ['k2'])];
    const { rows, margins } = layoutFamilyTree(people, edges);
    const left = leftsOf(rows, margins);
    const maxRight = Math.max(...[...left.values()].map((l) => l + CARD));
    // Parents' row holds 4 cards; the two families must sit within one
    // ordinary gap of each other, not drift apart during relaxation.
    expect(maxRight).toBeLessThanOrEqual(4 * CARD + 3 * GAP + 1);
  });

  it('drops edges pointing at people outside the tree', () => {
    const people = [person('A'), person('B')];
    const edges = [spouse('A', 'B'), parent('A', 'ghost')];
    const { validEdges } = layoutFamilyTree(people, edges);
    expect(validEdges).toHaveLength(1);
  });
});
