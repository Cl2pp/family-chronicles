import { describe, expect, it } from 'vitest';
import { layoutFamilyTree, type LayoutEdge, type LayoutPerson } from './tree-layout';

const CARD = 150;
const GAP = 24;

function person(id: string, born?: string): LayoutPerson {
  return { id, firstName: id, bornOn: born ?? null };
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

  it("aligns a marry-in's parents with their in-laws, not with the tree roots", () => {
    // One side has an extra recorded generation (GrandpaA above ParentA).
    // ParentB has no recorded parents but is the same generation as ParentA —
    // depth-from-roots used to pin ParentB to the top row next to GrandpaA
    // and push ChildB two rows below their own parent.
    const people = [
      person('GrandpaA', '1930-01-01'),
      person('ParentA', '1960-01-01'),
      person('ParentB', '1962-01-01'),
      person('ChildA', '1990-01-01'),
      person('ChildB', '1992-01-01'),
      person('SiblingB', '1994-01-01'),
    ];
    const edges = [
      parent('GrandpaA', 'ParentA'),
      parent('ParentA', 'ChildA'),
      parent('ParentB', 'ChildB'),
      parent('ParentB', 'SiblingB'),
      spouse('ChildA', 'ChildB'),
    ];
    const { rows } = layoutFamilyTree(people, edges);
    expect(rowIndexOf(rows, 'ParentB')).toBe(rowIndexOf(rows, 'ParentA'));
    expect(rowIndexOf(rows, 'ChildB')).toBe(rowIndexOf(rows, 'ParentB') + 1);
    // Siblings share a row even though only one of them married "down".
    expect(rowIndexOf(rows, 'SiblingB')).toBe(rowIndexOf(rows, 'ChildB'));
  });

  it('keeps both families level in the app-screenshot shape (Chira bug)', () => {
    // Real structure: Chira and Laura are the Hartwigs' daughters; Kathrin's
    // parents add an extra generation on the Ortlepp side. Björn+Silke must
    // sit with Karsten+Kathrin (not with the Strauß grandparents), Chira with
    // her husband AND her sister, and the Neumann kids with Bruno/Ava.
    const people = [
      person('BjornH', '1962-01-01'), person('SilkeH', '1964-01-01'),
      person('ChristianS', '1936-01-01'), person('IngeburgS', '1938-01-01'),
      person('KathrinO', '1963-01-01'), person('KarstenO', '1961-01-01'),
      person('LauraN', '1988-01-01'), person('GerritN', '1986-01-01'),
      person('ChiraH', '1995-01-01'),
      person('ChristophO', '1992-01-01'), person('NagoreN', '1993-01-01'),
      person('ClemensO', '1994-01-01'),
      person('JasperN', '2018-01-01'), person('XaverN', '2020-01-01'),
      person('BrunoO', '2024-01-01'), person('AvaO', '2026-01-01'),
    ];
    const edges = [
      ...couple('ChristianS', 'IngeburgS', ['KathrinO']),
      ...couple('BjornH', 'SilkeH', ['LauraN', 'ChiraH']),
      ...couple('KathrinO', 'KarstenO', ['ChristophO', 'ClemensO']),
      ...couple('LauraN', 'GerritN', ['JasperN', 'XaverN']),
      spouse('ChristophO', 'NagoreN'),
      spouse('ClemensO', 'ChiraH'),
      ...['BrunoO'].flatMap((c) => [parent('ChristophO', c), parent('NagoreN', c)]),
      ...['AvaO'].flatMap((c) => [parent('ClemensO', c), parent('ChiraH', c)]),
    ];
    const { rows, crossings } = layoutFamilyTree(people, edges);

    expect(rowIndexOf(rows, 'BjornH')).toBe(rowIndexOf(rows, 'KarstenO'));
    expect(rowIndexOf(rows, 'ChiraH')).toBe(rowIndexOf(rows, 'ClemensO'));
    expect(rowIndexOf(rows, 'ChiraH')).toBe(rowIndexOf(rows, 'LauraN'));
    // Parents directly above — the connector cannot pass through another row.
    expect(rowIndexOf(rows, 'ChiraH')).toBe(rowIndexOf(rows, 'BjornH') + 1);
    expect(rowIndexOf(rows, 'JasperN')).toBe(rowIndexOf(rows, 'BrunoO'));
    expect(crossings).toBe(0);
  });

  it('survives cross-generation marriages: children below parents, spouses level', () => {
    // C marries their parent's sibling Q — the kinship cycle has no
    // consistent leveling, so the repair pass must still guarantee the
    // renderer's invariants.
    const people = ['G', 'P', 'Q', 'C'].map((id) => person(id));
    const edges = [
      parent('G', 'P'),
      parent('G', 'Q'),
      parent('P', 'C'),
      spouse('C', 'Q'),
    ];
    const { rows } = layoutFamilyTree(people, edges);
    for (const [p, c] of [['G', 'P'], ['G', 'Q'], ['P', 'C']]) {
      expect(rowIndexOf(rows, p)).toBeLessThan(rowIndexOf(rows, c));
    }
    expect(rowIndexOf(rows, 'C')).toBe(rowIndexOf(rows, 'Q'));
  });

  it('keeps sibling groups together instead of interleaving families (Martina bug)', () => {
    // Full production shape: four root couples, three sibling groups in the
    // middle row. Crossing count alone tolerated Martina (a Strauß daughter)
    // parked beyond the whole Hartwig sibling run; the span objective plus
    // reflow-aware relocation must pull each sibling group into one run,
    // with only spouses allowed between siblings.
    const people = [
      person('ErnstO', '1919-01-01'), person('GiselaK', '1920-01-01'),
      person('ChristianS', '1935-01-01'), person('IngeburgS', '1936-01-01'),
      person('AnnemarieH', '1938-01-01'), person('WernerH', '1936-01-01'),
      person('GiselaSch', '1940-01-01'), person('HansSch', '1938-01-01'),
      person('KarstenO', '1957-01-01'), person('KathrinO', '1966-01-01'),
      person('GeraldS', '1963-01-01'), person('PetraS', '1964-01-01'),
      person('ImkeH', '1961-01-01'), person('UlfH', '1962-01-01'),
      person('BjoernH', '1960-01-01'), person('SilkeH', '1964-01-01'),
      person('MartinaSch', '1965-01-01'), person('MatthiasSch', '1963-01-01'),
      person('AntjeG', '1966-01-01'), person('HeikeM', '1967-01-01'),
      person('NagoreN', '1990-01-01'), person('ChristophO', '1989-01-01'),
      person('ClemensO', '1994-01-01'), person('ChiraH', '1995-01-01'),
      person('NicoleS', '1992-01-01'), person('SebastianS', '1994-01-01'),
      person('LauraN', '1993-01-01'), person('GerritN', '1991-01-01'),
      person('CarolaSch', '1992-01-01'), person('MarioSch', '1990-01-01'),
      person('ElenaG', '1995-01-01'), person('LeonardG', '1997-01-01'),
      person('TheresaM', '1996-01-01'), person('VincentM', '1998-01-01'),
      person('BrunoO', '2024-01-01'), person('AvaO', '2026-01-01'),
      person('XaverN', '2021-01-01'), person('JasperN', '2023-01-01'),
    ];
    const edges = [
      ...couple('ErnstO', 'GiselaK', ['KarstenO']),
      ...couple('ChristianS', 'IngeburgS', ['KathrinO', 'GeraldS', 'MartinaSch']),
      ...couple('AnnemarieH', 'WernerH', ['ImkeH', 'UlfH', 'BjoernH', 'AntjeG', 'HeikeM']),
      ...couple('GiselaSch', 'HansSch', ['SilkeH']),
      ...couple('KarstenO', 'KathrinO', ['ChristophO', 'ClemensO']),
      ...couple('GeraldS', 'PetraS', ['NicoleS', 'SebastianS']),
      ...couple('BjoernH', 'SilkeH', ['LauraN', 'ChiraH']),
      ...couple('MartinaSch', 'MatthiasSch', ['CarolaSch', 'MarioSch']),
      parent('AntjeG', 'ElenaG'), parent('AntjeG', 'LeonardG'),
      parent('HeikeM', 'TheresaM'), parent('HeikeM', 'VincentM'),
      ...couple('ChristophO', 'NagoreN', ['BrunoO']),
      ...couple('ClemensO', 'ChiraH', ['AvaO']),
      ...couple('LauraN', 'GerritN', ['XaverN', 'JasperN']),
    ];
    const { rows, crossings } = layoutFamilyTree(people, edges);

    expect(crossings).toBe(0);

    const spouseOf: Record<string, string> = {
      KathrinO: 'KarstenO', GeraldS: 'PetraS', MartinaSch: 'MatthiasSch',
      BjoernH: 'SilkeH', ImkeH: '', UlfH: '', AntjeG: '', HeikeM: '',
    };
    for (const siblings of [
      ['KathrinO', 'GeraldS', 'MartinaSch'],
      ['ImkeH', 'UlfH', 'BjoernH', 'AntjeG', 'HeikeM'],
    ]) {
      const row = rows.find((r) => r.ids.includes(siblings[0]))!;
      const idxs = siblings.map((id) => row.ids.indexOf(id));
      const span = row.ids.slice(Math.min(...idxs), Math.max(...idxs) + 1);
      const allowed = new Set(
        siblings.flatMap((id) => [id, spouseOf[id]]).filter(Boolean),
      );
      for (const id of span) expect(allowed).toContain(id);
    }
  });

  it("anchors a marry-in's ancestor stub without disturbing the rest (Nagore's parents)", () => {
    // The docs/TREE_LAYOUT_CROSSINGS_PLAN.md minimal repro: the Martina-bug
    // shape lays out at 0 crossings, and adding ONE marry-in's parents
    // (NopaN+NomaN above NagoreN) used to knock it into a 3-crossing local
    // minimum. The stub must be parked directly above Nagore instead.
    const people = [
      person('ErnstO', '1919-01-01'), person('GiselaK', '1920-01-01'),
      person('ChristianS', '1935-01-01'), person('IngeburgS', '1936-01-01'),
      person('AnnemarieH', '1938-01-01'), person('WernerH', '1936-01-01'),
      person('GiselaSch', '1940-01-01'), person('HansSch', '1938-01-01'),
      person('KarstenO', '1957-01-01'), person('KathrinO', '1966-01-01'),
      person('GeraldS', '1963-01-01'), person('PetraS', '1964-01-01'),
      person('ImkeH', '1961-01-01'), person('UlfH', '1962-01-01'),
      person('BjoernH', '1960-01-01'), person('SilkeH', '1964-01-01'),
      person('MartinaSch', '1965-01-01'), person('MatthiasSch', '1963-01-01'),
      person('AntjeG', '1966-01-01'), person('HeikeM', '1967-01-01'),
      person('NagoreN', '1990-01-01'), person('ChristophO', '1989-01-01'),
      person('ClemensO', '1994-01-01'), person('ChiraH', '1995-01-01'),
      person('NicoleS', '1992-01-01'), person('SebastianS', '1994-01-01'),
      person('LauraN', '1993-01-01'), person('GerritN', '1991-01-01'),
      person('CarolaSch', '1992-01-01'), person('MarioSch', '1990-01-01'),
      person('ElenaG', '1995-01-01'), person('LeonardG', '1997-01-01'),
      person('TheresaM', '1996-01-01'), person('VincentM', '1998-01-01'),
      person('BrunoO', '2024-01-01'), person('AvaO', '2026-01-01'),
      person('XaverN', '2021-01-01'), person('JasperN', '2023-01-01'),
      person('NopaN', '1960-01-01'), person('NomaN', '1962-01-01'),
    ];
    const edges = [
      ...couple('ErnstO', 'GiselaK', ['KarstenO']),
      ...couple('ChristianS', 'IngeburgS', ['KathrinO', 'GeraldS', 'MartinaSch']),
      ...couple('AnnemarieH', 'WernerH', ['ImkeH', 'UlfH', 'BjoernH', 'AntjeG', 'HeikeM']),
      ...couple('GiselaSch', 'HansSch', ['SilkeH']),
      ...couple('KarstenO', 'KathrinO', ['ChristophO', 'ClemensO']),
      ...couple('GeraldS', 'PetraS', ['NicoleS', 'SebastianS']),
      ...couple('BjoernH', 'SilkeH', ['LauraN', 'ChiraH']),
      ...couple('MartinaSch', 'MatthiasSch', ['CarolaSch', 'MarioSch']),
      parent('AntjeG', 'ElenaG'), parent('AntjeG', 'LeonardG'),
      parent('HeikeM', 'TheresaM'), parent('HeikeM', 'VincentM'),
      ...couple('ChristophO', 'NagoreN', ['BrunoO']),
      ...couple('ClemensO', 'ChiraH', ['AvaO']),
      ...couple('LauraN', 'GerritN', ['XaverN', 'JasperN']),
      ...couple('NopaN', 'NomaN', ['NagoreN']),
    ];
    const { rows, crossings } = layoutFamilyTree(people, edges);
    expect(crossings).toBe(0);
    // The stub sits in the row above Nagore, and horizontally near her.
    expect(rowIndexOf(rows, 'NopaN')).toBe(rowIndexOf(rows, 'NagoreN') - 1);
  });

  it('lays out the production tree with four ancestor-stub couples at 0 crossings', () => {
    // The app-screenshot shape that showed Schmalzbauer and Strauß sibling
    // buses crossing: every grandparent couple on the top row is an ancestor
    // stub over one marry-in, and the Schmalzbauer children (Silke, Yvonne)
    // interleaved with the Strauß children (Kathrin, Gerald, Martina).
    const people = [
      person('RosaO', '1894-01-01'), person('AugustO', '1894-06-01'),
      person('LeonhardK', '1889-01-01'), person('FriedaK', '1898-01-01'),
      person('EmilS', '1899-01-01'), person('OlgaS', '1900-01-01'),
      person('MartinM', '1903-01-01'), person('MarthaM', '1906-01-01'),
      person('ErnstO', '1919-01-01'), person('GiselaK', '1920-01-01'),
      person('GiselaSch', '1940-01-01'), person('HansSch', '1938-01-01'),
      person('ChristianS', '1935-01-01'), person('IngeburgS', '1936-01-01'),
      person('BjoernH', '1960-01-01'), person('SilkeH', '1964-01-01'),
      person('KarstenO', '1957-01-01'), person('KathrinO', '1966-01-01'),
      person('UlrichR', '1962-01-01'), person('YvonneR', '1965-01-01'),
      person('GeraldS', '1963-01-01'), person('PetraS', '1964-01-01'),
      person('MartinaSch', '1965-01-01'), person('MatthiasSch', '1963-01-01'),
      person('LauraN', '1993-01-01'), person('ChiraH', '1995-01-01'),
      person('ClemensO', '1994-01-01'), person('ChristophO', '1989-01-01'),
      person('NagoreN', '1990-01-01'),
      person('ChristopherR', '1990-01-01'), person('JosephineR', '1992-01-01'),
      person('MaxR', '1994-01-01'),
      person('NicoleS', '1992-01-01'), person('SebastianS', '1994-01-01'),
      person('CarolaSch', '1992-01-01'), person('MarioSch', '1990-01-01'),
      person('BrunoO', '2024-01-01'), person('AvaO', '2026-01-01'),
    ];
    const edges = [
      ...couple('RosaO', 'AugustO', ['ErnstO']),
      ...couple('LeonhardK', 'FriedaK', ['GiselaK']),
      ...couple('EmilS', 'OlgaS', ['ChristianS']),
      ...couple('MartinM', 'MarthaM', ['IngeburgS']),
      ...couple('ErnstO', 'GiselaK', ['KarstenO']),
      ...couple('GiselaSch', 'HansSch', ['SilkeH', 'YvonneR']),
      ...couple('ChristianS', 'IngeburgS', ['KathrinO', 'GeraldS', 'MartinaSch']),
      ...couple('BjoernH', 'SilkeH', ['LauraN', 'ChiraH']),
      ...couple('KarstenO', 'KathrinO', ['ChristophO', 'ClemensO']),
      ...couple('UlrichR', 'YvonneR', ['ChristopherR', 'JosephineR', 'MaxR']),
      ...couple('GeraldS', 'PetraS', ['NicoleS', 'SebastianS']),
      ...couple('MartinaSch', 'MatthiasSch', ['CarolaSch', 'MarioSch']),
      ...couple('ChristophO', 'NagoreN', ['BrunoO']),
      ...couple('ClemensO', 'ChiraH', ['AvaO']),
    ];
    const { crossings } = layoutFamilyTree(people, edges);
    expect(crossings).toBe(0);
  });

  it('never does worse than the classic joint search (adversarial-review seeds)', () => {
    // An independent review of the stub-anchoring change fuzz-compared the
    // engine against the pre-stub implementation and found a handful of
    // random genealogies where extraction (or the probe-settled relocation)
    // regressed the crossing count. The dual-candidate selection must keep
    // those at the classic engine's numbers. Generator ported from the
    // review's fuzz harness (mulberry32-seeded).
    const mulberry32 = (a: number) => () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const gencase = (seed: number) => {
      const rnd = mulberry32(seed);
      const people: LayoutPerson[] = [];
      const edges: LayoutEdge[] = [];
      let n = 0;
      const add = (year: number) => {
        const id = `p${n++}`;
        people.push({
          id,
          firstName: id,
          bornOn: rnd() < 0.9 ? `${year}-0${1 + Math.floor(rnd() * 8)}-01` : null,
        });
        return id;
      };
      const sp = (a: string, b: string) => edges.push(spouse(a, b));
      const par = (p: string, c: string) => edges.push(parent(p, c));
      const ancestors = (id: string, year: number, depth: number) => {
        let cur = id;
        let y = year;
        for (let d = 0; d < depth; d++) {
          y -= 25 + Math.floor(rnd() * 10);
          const f = add(y);
          const m = add(y + 1);
          sp(f, m);
          par(f, cur);
          par(m, cur);
          if (rnd() < 0.3) {
            const sib = add(y + 2);
            par(f, sib);
            edges.pop();
            n--;
            people.pop();
          }
          cur = rnd() < 0.5 ? f : m;
        }
      };
      const gens = 3 + Math.floor(rnd() * 3);
      const topCouples = 1 + Math.floor(rnd() * 3);
      let layer: string[] = [];
      for (let i = 0; i < topCouples; i++) {
        const y = 1900 + Math.floor(rnd() * 6);
        const a = add(y);
        const b = add(y + 1);
        sp(a, b);
        const kids = 1 + Math.floor(rnd() * 3);
        for (let k = 0; k < kids; k++) {
          const c = add(y + 25 + k * 2);
          par(a, c);
          par(b, c);
          layer.push(c);
        }
      }
      let year = 1930;
      for (let g = 1; g < gens; g++) {
        year += 28;
        const next: string[] = [];
        for (const p of layer) {
          if (rnd() < 0.75) {
            const partner = add(year - 28 + Math.floor(rnd() * 4));
            sp(p, partner);
            if (rnd() < 0.5) ancestors(partner, year - 28, 1 + Math.floor(rnd() * 3));
            const kids = Math.floor(rnd() * 3);
            for (let k = 0; k < kids; k++) {
              const c = add(year + k * 2);
              par(p, c);
              par(partner, c);
              next.push(c);
            }
          } else if (rnd() < 0.3) {
            const c = add(year);
            par(p, c);
            next.push(c);
          }
        }
        if (next.length >= 2 && rnd() < 0.3) {
          const i = Math.floor(rnd() * next.length);
          let j = Math.floor(rnd() * next.length);
          if (j === i) j = (j + 1) % next.length;
          sp(next[i], next[j]);
        }
        layer = next;
        if (!layer.length) break;
      }
      if (rnd() < 0.5) add(1950);
      if (rnd() < 0.3) {
        const a = add(1960);
        const b = add(1961);
        sp(a, b);
      }
      return { people, edges };
    };
    // (seed, classic-engine crossings) — the ceiling the engine must hold.
    for (const [seed, classic] of [
      [20, 0],
      [73, 0],
      [80, 1],
    ] as [number, number][]) {
      const { people, edges } = gencase(seed);
      const { crossings } = layoutFamilyTree(people, edges);
      expect(crossings, `fuzz seed ${seed}`).toBeLessThanOrEqual(classic);
    }
  });

  it('places a disconnected person on the row matching their birth year', () => {
    const people = [
      person('Mom', '1960-01-01'),
      person('Dad', '1958-01-01'),
      person('Kid1', '1985-01-01'),
      person('Kid2', '1988-01-01'),
      person('Stranger', '1986-01-01'), // same era as the kids
    ];
    const edges = couple('Mom', 'Dad', ['Kid1', 'Kid2']);
    const { rows } = layoutFamilyTree(people, edges);
    expect(rowIndexOf(rows, 'Stranger')).toBe(rowIndexOf(rows, 'Kid1'));
  });
});
