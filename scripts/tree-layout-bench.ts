/**
 * Benchmark harness for the family-tree layout engine (`lib/tree-layout.ts`).
 *
 * Motivation: on wide, deep trees (5–7 ancestor layers with many marry-ins that
 * carry their own ancestor lines) the ordering stage settles into local minima
 * with many connector crossings. This script reproduces that at several sizes so
 * a fix can be measured against a stable baseline.
 *
 * Run:  npx tsx scripts/tree-layout-bench.ts
 *
 * See docs/TREE_LAYOUT_CROSSINGS_PLAN.md for the full diagnosis.
 */
import { layoutFamilyTree, type LayoutEdge, type LayoutPerson } from '../lib/tree-layout';

const spouse = (a: string, b: string): LayoutEdge => ({ type: 'spouse', from: a, to: b });
const parent = (a: string, b: string): LayoutEdge => ({ type: 'parent', from: a, to: b });
const couple = (a: string, b: string, kids: string[]): LayoutEdge[] => [
  spouse(a, b),
  ...kids.flatMap((c) => [parent(a, c), parent(b, c)]),
];

/**
 * Grow a tree DOWNWARD from `topCouples` founder couples over `gens`
 * generations. Each couple has 1–3 children; children that continue the line
 * marry a MARRY-IN, and a fraction of those marry-ins have their own recorded
 * ancestors (a short stub fanning UP) — this pendant-from-above structure is
 * what drives the crossings. Deterministic (seeded LCG), no Date/Math.random.
 */
function build(topCouples: number, gens: number, seed = 1) {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const people: LayoutPerson[] = [];
  const edges: LayoutEdge[] = [];
  let n = 0;
  const add = (year: number) => {
    const id = `p${n++}`;
    people.push({ id, firstName: id, bornOn: `${year}-01-01` });
    return id;
  };
  const marryIn = (year: number, upLayers: number) => {
    const m = add(year + Math.floor(rnd() * 3));
    if (upLayers > 0 && rnd() < 0.6) {
      let child = m;
      let y = year;
      for (let u = 0; u < upLayers; u++) {
        y -= 28;
        const fa = add(y);
        const mo = add(y + 2);
        edges.push(spouse(fa, mo), parent(fa, child), parent(mo, child));
        child = fa;
      }
    }
    return m;
  };
  let layer: string[] = [];
  let year = 1900;
  for (let i = 0; i < topCouples; i++) {
    const a = add(year);
    const b = add(year + 1);
    edges.push(spouse(a, b));
    layer.push(a);
  }
  for (let g = 1; g < gens; g++) {
    year += 28;
    const next: string[] = [];
    for (const blood of layer) {
      const nKids = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < nKids; k++) {
        const kid = add(year);
        const sp = edges.find((e) => e.type === 'spouse' && (e.from === blood || e.to === blood));
        const other = sp ? (sp.from === blood ? sp.to : sp.from) : blood;
        edges.push(parent(blood, kid), parent(other, kid));
        if (g < gens - 1 && rnd() < 0.8) {
          const mi = marryIn(year, Math.min(g, 3));
          edges.push(spouse(kid, mi));
          next.push(kid);
        }
      }
    }
    layer = next;
  }
  return { people, edges };
}

/** The "marry-in with ancestors" minimal reproduction (0 → 3 crossings). */
function nagoreRepro() {
  const P = (id: string, born: string): LayoutPerson => ({ id, firstName: id, bornOn: born });
  const people = [
    P('ErnstO', '1919-01-01'), P('GiselaK', '1920-01-01'),
    P('ChristianS', '1935-01-01'), P('IngeburgS', '1936-01-01'),
    P('AnnemarieH', '1938-01-01'), P('WernerH', '1936-01-01'),
    P('GiselaSch', '1940-01-01'), P('HansSch', '1938-01-01'),
    P('KarstenO', '1957-01-01'), P('KathrinO', '1966-01-01'),
    P('GeraldS', '1963-01-01'), P('PetraS', '1964-01-01'),
    P('ImkeH', '1961-01-01'), P('UlfH', '1962-01-01'),
    P('BjoernH', '1960-01-01'), P('SilkeH', '1964-01-01'),
    P('MartinaSch', '1965-01-01'), P('MatthiasSch', '1963-01-01'),
    P('AntjeG', '1966-01-01'), P('HeikeM', '1967-01-01'),
    P('NagoreN', '1990-01-01'), P('ChristophO', '1989-01-01'),
    P('ClemensO', '1994-01-01'), P('ChiraH', '1995-01-01'),
    P('NicoleS', '1992-01-01'), P('SebastianS', '1994-01-01'),
    P('LauraN', '1993-01-01'), P('GerritN', '1991-01-01'),
    P('CarolaSch', '1992-01-01'), P('MarioSch', '1990-01-01'),
    P('ElenaG', '1995-01-01'), P('LeonardG', '1997-01-01'),
    P('TheresaM', '1996-01-01'), P('VincentM', '1998-01-01'),
    P('BrunoO', '2024-01-01'), P('AvaO', '2026-01-01'),
    P('XaverN', '2021-01-01'), P('JasperN', '2023-01-01'),
    // NagoreN's parents — a marry-in ancestor stub added on top:
    P('NopaN', '1960-01-01'), P('NomaN', '1962-01-01'),
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
  return { people, edges };
}

function measure(label: string, people: LayoutPerson[], edges: LayoutEdge[]) {
  const t0 = process.hrtime.bigint();
  const { rows, crossings } = layoutFamilyTree(people, edges);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const widest = Math.max(...rows.map((r) => r.ids.length));
  console.log(
    `${label.padEnd(30)} people=${String(people.length).padStart(4)}  rows=${rows.length}  ` +
      `widest=${String(widest).padStart(3)}  crossings=${String(crossings).padStart(4)}  ${ms.toFixed(0)}ms`,
  );
  return crossings;
}

console.log('=== family-tree layout crossings benchmark ===\n');
measure('nagore-repro (expect ~3)', ...Object.values(nagoreRepro()) as [LayoutPerson[], LayoutEdge[]]);
for (const [tc, g, seed] of [
  [3, 5, 1], [4, 6, 1], [5, 7, 1], [3, 5, 7], [4, 6, 3], [5, 7, 9],
] as [number, number, number][]) {
  const { people, edges } = build(tc, g, seed);
  measure(`gen tc=${tc} g=${g} seed=${seed}`, people, edges);
}
