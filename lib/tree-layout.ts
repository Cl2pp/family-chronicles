/**
 * Pure layout engine for the family-tree view (no DOM, no React) so it can be
 * unit-tested and evolved without touching rendering.
 *
 * Layered (Sugiyama-style) layout specialised for genealogy:
 * - Generations are RELATIVE, not depth-from-roots: levels propagate through
 *   spouse (same row) and parent (one row down) edges in both directions, so
 *   in-law branches line up with their counterpart generation; disconnected
 *   components are aligned by birth year (~30 years per generation).
 * - Couples stay adjacent: each row is a sequence of "blocks" (spouse-connected
 *   groups); ordering and placement move blocks, never split them.
 * - Ancestor stubs are anchored, not searched: a subtree whose only tie to
 *   the rest of the graph is one parent edge into a marry-in (the marry-in's
 *   own parents, grandparents, …) is pulled out before ordering and, once the
 *   dense core has settled, re-inserted directly above its single descendant.
 *   Left inside the search, the stub gives the marry-in an upward anchor that
 *   the barycenter sweeps chase across the whole interlocked row — the local
 *   move set (adjacent swaps, ±2 relocation) can never walk a multi-row unit
 *   back over its anchor, so the search parks in crossing-heavy minima
 *   (see docs/TREE_LAYOUT_CROSSINGS_PLAN.md for the full diagnosis).
 * - Row order comes from iterated down/up barycenter sweeps followed by a
 *   transpose pass (adjacent swaps) and a relocation pass (a block may jump
 *   anywhere in its row). Both accept a move on the lexicographic objective
 *   (crossings, generation-weighted connector span): crossings stay primary,
 *   but among equal-crossing orders the one with tighter parent connectors
 *   wins. Siblings share a union point, so the span term pulls sibling
 *   groups together instead of letting them interleave with other families;
 *   the weight doubles per row upward, so older generations keep their
 *   siblings adjacent even when that spreads the rows below.
 *   A single top-down pass (the old approach) gave marry-ins no anchor and
 *   let their whole couple drift to the end of the row.
 * - X placement is balanced: every pass re-centers blocks over both their
 *   parents and their children, and each row is resolved with an
 *   order-preserving least-squares merge instead of a greedy push-right scan,
 *   so parents float back over their children.
 * - Ties break deterministically: birth date, then display name, then id —
 *   siblings render oldest-first and adding people doesn't reshuffle rows.
 */

export interface LayoutPerson {
  id: string;
  firstName: string;
  bornOn?: Date | string | null;
}

export interface LayoutEdge {
  type: string; // 'parent' | 'spouse'
  from: string;
  to: string;
}

export interface TreeLayout<E extends LayoutEdge> {
  rows: { gen: number; ids: string[] }[];
  validEdges: E[];
  /** Extra left margin per card id — the renderer lays cards out flow-style. */
  margins: Map<string, number>;
  /** Parent-connector crossings in the final ordering — exposed for tests. */
  crossings: number;
}

interface Block {
  members: string[];
}

const cmpNum = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);

const ORDER_SWEEPS = 10;
const TRANSPOSE_ROUNDS = 20;
const PLACE_ROUNDS = 40;
const PLACE_EPSILON = 0.5;

export function layoutFamilyTree<E extends LayoutEdge>(
  people: LayoutPerson[],
  edges: E[],
  opts?: { cardWidth?: number; hGap?: number },
): TreeLayout<E> {
  const cardWidth = opts?.cardWidth ?? 150;
  const hGap = opts?.hGap ?? 24;

  const ids = new Set(people.map((p) => p.id));
  const byId = new Map(people.map((p) => [p.id, p]));
  const parentsOf = new Map<string, string[]>();
  const childrenOf = new Map<string, string[]>();
  const spousesOf = new Map<string, string[]>();
  const validEdges: E[] = [];

  const push = (m: Map<string, string[]>, k: string, v: string) => {
    const arr = m.get(k);
    if (arr) arr.push(v);
    else m.set(k, [v]);
  };

  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    validEdges.push(e);
    if (e.type === 'parent') {
      push(parentsOf, e.to, e.from);
      push(childrenOf, e.from, e.to);
    } else {
      push(spousesOf, e.from, e.to);
      push(spousesOf, e.to, e.from);
    }
  }

  if (people.length === 0) {
    return { rows: [], validEdges, margins: new Map(), crossings: 0 };
  }

  // ---- Deterministic person ordering helpers.
  const bornTime = (id: string): number => {
    const b = byId.get(id)?.bornOn;
    if (!b) return Number.POSITIVE_INFINITY;
    const d = typeof b === 'string' ? new Date(b) : b;
    const t = d.getTime();
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  const nameOf = (id: string) => byId.get(id)?.firstName ?? '';
  const personCmp = (a: string, b: string) =>
    cmpNum(bornTime(a), bornTime(b)) ||
    nameOf(a).localeCompare(nameOf(b)) ||
    (a < b ? -1 : a > b ? 1 : 0);

  // ---- Generation assignment, three passes.
  // 1. Relative BFS per connected component: spouse edges share a level,
  //    parent edges go exactly one level down. Levels must propagate through
  //    marriages in BOTH directions — min-depth-from-roots (the old approach)
  //    pinned every parentless person to the top row, so a marry-in's parents
  //    floated generations above their in-laws while the spouse rule dragged
  //    the marry-in below their own siblings.
  // 2. Disconnected components share no kinship constraint; align them by
  //    birth year where known (~30 years per generation).
  // 3. Monotonic relaxation as a safety net for kinship cycles whose offsets
  //    don't add up (e.g. cross-generation marriages): children always end
  //    strictly below both parents, spouses share a row.
  const gen = new Map<string, number>();
  const compId = new Map<string, number>();
  {
    const neighbors = new Map<string, { id: string; off: number }[]>();
    const addN = (a: string, b: string, off: number) => {
      const arr = neighbors.get(a);
      if (arr) arr.push({ id: b, off });
      else neighbors.set(a, [{ id: b, off }]);
    };
    for (const e of validEdges) {
      if (e.type === 'parent') {
        addN(e.from, e.to, 1);
        addN(e.to, e.from, -1);
      } else {
        addN(e.from, e.to, 0);
        addN(e.to, e.from, 0);
      }
    }
    let nextComp = 0;
    for (const seed of [...ids].sort()) {
      if (gen.has(seed)) continue;
      const comp = nextComp++;
      gen.set(seed, 0);
      compId.set(seed, comp);
      const queue = [seed];
      for (let qi = 0; qi < queue.length; qi++) {
        const cur = queue[qi];
        const g = gen.get(cur)!;
        for (const { id: n, off } of neighbors.get(cur) ?? []) {
          if (gen.has(n)) continue; // first (shortest-path) assignment wins
          gen.set(n, g + off);
          compId.set(n, comp);
          queue.push(n);
        }
      }
    }

    // Normalize each component to start at 0, then shift dated components so
    // people born in the same era land near the same row as the component
    // with the most known birth dates.
    const minOf = new Map<number, number>();
    for (const [id, g] of gen) {
      const c = compId.get(id)!;
      minOf.set(c, Math.min(minOf.get(c) ?? Number.POSITIVE_INFINITY, g));
    }
    for (const [id, g] of gen) gen.set(id, g - minOf.get(compId.get(id)!)!);

    const YEARS_PER_GEN = 30;
    // Per component: mean of (birth year − 30·gen), i.e. the component's
    // "year of generation zero". Matching these intercepts aligns eras.
    const intercepts = new Map<number, { sum: number; n: number }>();
    for (const [id, g] of gen) {
      const t = bornTime(id);
      if (!Number.isFinite(t)) continue;
      const c = compId.get(id)!;
      const s = intercepts.get(c) ?? { sum: 0, n: 0 };
      s.sum += new Date(t).getUTCFullYear() - YEARS_PER_GEN * g;
      s.n += 1;
      intercepts.set(c, s);
    }
    if (intercepts.size > 1) {
      const [refComp, refStat] = [...intercepts.entries()].sort(
        (a, b) => b[1].n - a[1].n || a[0] - b[0],
      )[0];
      for (const [id, g] of gen) {
        const c = compId.get(id)!;
        const s = intercepts.get(c);
        if (!s || c === refComp) continue;
        const shift = Math.round((s.sum / s.n - refStat.sum / refStat.n) / YEARS_PER_GEN);
        gen.set(id, g + shift);
      }
    }
  }
  const cap = people.length * 4 + 4;
  for (let iter = 0; iter < cap; iter++) {
    let changed = false;
    for (const e of validEdges) {
      if (e.type === 'parent') {
        const want = (gen.get(e.from) ?? 0) + 1;
        if (want > (gen.get(e.to) ?? 0)) {
          gen.set(e.to, want);
          changed = true;
        }
      } else {
        const g = Math.max(gen.get(e.from) ?? 0, gen.get(e.to) ?? 0);
        if (g > (gen.get(e.from) ?? 0)) {
          gen.set(e.from, g);
          changed = true;
        }
        if (g > (gen.get(e.to) ?? 0)) {
          gen.set(e.to, g);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  const parentSet = new Map<string, Set<string>>();
  for (const [c, ps] of parentsOf) parentSet.set(c, new Set(ps));
  const sharesParent = (a: string, b: string): boolean => {
    const pa = parentSet.get(a);
    const pb = parentSet.get(b);
    if (!pa || !pb) return false;
    for (const p of pa) if (pb.has(p)) return true;
    return false;
  };

  // ---- Ancestor stubs. For each person with recorded parents AND their own
  // spouse/children, walk the kinship graph from the parents without stepping
  // onto that person: if the walk never reaches their spouse or children, the
  // ancestor side hangs off them alone (a pendant) and is extracted from the
  // ordering search, to be re-inserted directly above its anchor once the
  // core order has settled. Nested pendants collapse into the outermost one.
  // Only pendants that live entirely ABOVE the anchor qualify: a pendant
  // carrying the anchor's siblings and their descendants is a real clan the
  // main search handles well (and needs to see) — the pathological case is
  // purely upward pull, which the local move set cannot walk back.
  const stubAnchor = new Map<string, string>(); // stub member -> anchor id
  {
    const kinOf = (id: string): string[] => [
      ...(parentsOf.get(id) ?? []),
      ...(childrenOf.get(id) ?? []),
      ...(spousesOf.get(id) ?? []),
    ];
    const reaches: { m: string; reach: Set<string> }[] = [];
    for (const m of [...ids].sort()) {
      const ps = parentsOf.get(m) ?? [];
      const stop = [...(spousesOf.get(m) ?? []), ...(childrenOf.get(m) ?? [])];
      if (!ps.length || !stop.length) continue;
      const stopSet = new Set(stop);
      const reach = new Set<string>();
      const queue = [...ps];
      let pendant = true;
      while (queue.length) {
        const cur = queue.pop()!;
        if (cur === m || reach.has(cur)) continue;
        if (stopSet.has(cur)) {
          pendant = false;
          break;
        }
        reach.add(cur);
        for (const n of kinOf(cur)) if (n !== m && !reach.has(n)) queue.push(n);
      }
      if (!pendant || !reach.size) continue;
      const gm = gen.get(m)!;
      let above = true;
      for (const p of reach) {
        if ((gen.get(p) ?? gm) >= gm) {
          above = false;
          break;
        }
      }
      if (above) reaches.push({ m, reach });
    }
    reaches.sort((a, b) => b.reach.size - a.reach.size || (a.m < b.m ? -1 : 1));
    for (const { m, reach } of reaches) {
      if (stubAnchor.has(m)) continue; // inside a larger stub already
      let overlaps = false;
      for (const p of reach) {
        if (stubAnchor.has(p)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;
      for (const p of reach) stubAnchor.set(p, m);
    }
  }

  // ---- Rows and blocks. A block is a spouse-connected component within a
  // row, arranged as a path so married partners are always adjacent.
  const sortedGens = [...new Set(gen.values())].sort((a, b) => a - b);

  const orderPath = (comp: string[]): string[] => {
    if (comp.length <= 2) return [...comp].sort(personCmp);
    const inComp = new Set(comp);
    const degreeOf = (id: string) =>
      (spousesOf.get(id) ?? []).filter((s) => inComp.has(s)).length;
    const start =
      [...comp].sort(personCmp).find((id) => degreeOf(id) <= 1) ?? comp[0];
    const path: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = start;
    while (cur !== undefined) {
      path.push(cur);
      seen.add(cur);
      cur = (spousesOf.get(cur) ?? [])
        .filter((s) => inComp.has(s) && !seen.has(s))
        .sort(personCmp)[0];
    }
    for (const id of comp) if (!seen.has(id)) path.push(id);
    return path;
  };

  const buildBlocks = (): Block[][] =>
    sortedGens.map((g) => {
      const members = people
        .filter((p) => gen.get(p.id) === g)
        .map((p) => p.id)
        .sort(personCmp);
      const memberSet = new Set(members);
      const visited = new Set<string>();
      const blocks: Block[] = [];
      for (const id of members) {
        if (visited.has(id)) continue;
        const comp: string[] = [];
        const stack = [id];
        while (stack.length) {
          const c = stack.pop()!;
          if (visited.has(c)) continue;
          visited.add(c);
          comp.push(c);
          for (const s of spousesOf.get(c) ?? []) {
            if (memberSet.has(s) && !visited.has(s)) stack.push(s);
          }
        }
        blocks.push({ members: orderPath(comp) });
      }
      return blocks;
    });
  let state: Block[][] = buildBlocks();

  const flatPositions = (s: Block[][]): Map<string, number> => {
    const pos = new Map<string, number>();
    for (const row of s) {
      let i = 0;
      for (const b of row) for (const id of b.members) pos.set(id, i++);
    }
    return pos;
  };

  const rowOf = new Map<string, number>();
  state.forEach((row, r) =>
    row.forEach((b) => b.members.forEach((id) => rowOf.set(id, r))),
  );

  // Person -> block. Blocks never split or merge during the search (only
  // their order changes, and orientation reverses members in place), so this
  // is computed once; presence in the current search state is tested via the
  // position map instead.
  const blockOfAll = new Map<string, Block>();
  for (const row of state) for (const b of row) for (const id of b.members) blockOfAll.set(id, b);

  // Row -> children whose connector touches it (as child side or via a
  // parent's row) — lets the row-local score visit only relevant edges.
  const childrenTouchingRow = new Map<number, string[]>();
  for (const [child, ps] of parentsOf) {
    const rc = rowOf.get(child);
    if (rc === undefined) continue;
    const rs = new Set([rc]);
    for (const p of ps) {
      const rp = rowOf.get(p);
      if (rp !== undefined) rs.add(rp);
    }
    for (const r of rs) {
      const arr = childrenTouchingRow.get(r);
      if (arr) arr.push(child);
      else childrenTouchingRow.set(r, [child]);
    }
  }

  // ---- Ordering objective over parent connectors, matching what the
  // renderer draws: parents in the same couple block emit ONE union edge from
  // their midpoint (two per-parent edges to two children would otherwise
  // count a phantom crossing inside every couple). Edges are grouped by
  // (parent row, child row) so multi-row spans only compete on the same span.
  //
  // The score is lexicographic: crossings first, then the horizontal span
  // Σ|union x − child x| weighted by the child's row (doubling per row
  // upward). Crossing count alone is blind to sibling dispersion — fanning
  // one child of a couple out past another family adds no crossing — so the
  // span term is what keeps sibling groups together, oldest generations
  // first.
  interface OrderScore {
    crossings: number;
    span: number;
  }
  const SPAN_EPSILON = 1e-6;
  const scoreBetter = (a: OrderScore, b: OrderScore) =>
    a.crossings !== b.crossings
      ? a.crossings < b.crossings
      : a.span < b.span - SPAN_EPSILON;
  // With `onlyRow`, only connector groups touching that row (as parent or
  // child side) are scored: a move within one row leaves every other group
  // untouched, so comparing local scores compares the global ones — at a
  // fraction of the cost on wide trees.
  const scoreOf = (s: Block[][], onlyRow?: number): OrderScore => {
    const pos = flatPositions(s);
    const groups = new Map<string, [number, number][]>();
    let span = 0;
    const childList =
      onlyRow === undefined
        ? parentsOf.keys()
        : (childrenTouchingRow.get(onlyRow) ?? []);
    for (const child of childList) {
      const ps = parentsOf.get(child)!;
      const rc = rowOf.get(child);
      if (rc === undefined) continue;
      // One union source per (parent block, child): midpoint of the parents
      // of this child that share the block. Trial states carry copied Block
      // objects, but membership is what groups parents — the original block
      // identity from blockOfAll works for copies too.
      const perBlock = new Map<Block, number[]>();
      for (const p of ps) {
        const px = pos.get(p);
        if (px === undefined) continue; // extracted stub member
        const b = blockOfAll.get(p)!;
        const arr = perBlock.get(b) ?? [];
        arr.push(px);
        perBlock.set(b, arr);
      }
      const cx = pos.get(child);
      if (cx === undefined) continue; // extracted stub member
      for (const [b, xs] of perBlock) {
        const rp = rowOf.get(b.members[0])!;
        if (onlyRow !== undefined && rp !== onlyRow && rc !== onlyRow) continue;
        const key = `${rp}:${rc}`;
        const arr = groups.get(key) ?? [];
        const ux = xs.reduce((sum, v) => sum + v, 0) / xs.length;
        arr.push([ux, cx]);
        groups.set(key, arr);
        span += 2 ** Math.min(s.length - 1 - rc, 32) * Math.abs(ux - cx);
      }
    }
    let n = 0;
    for (const es of groups.values()) {
      for (let i = 0; i < es.length; i++) {
        for (let j = i + 1; j < es.length; j++) {
          if ((es[i][0] - es[j][0]) * (es[i][1] - es[j][1]) < 0) n++;
        }
      }
    }
    return { crossings: n, span };
  };
  const totalCrossings = (s: Block[][]): number => scoreOf(s).crossings;

  // ---- Within-block orientation. Primary: keep blood relatives next to
  // their siblings (marry-ins go on the outer side). Fallback: the direction
  // whose members' barycenter keys are least out of order.
  const orientBlocks = (row: Block[], mKey: Map<string, number | null>) => {
    row.forEach((b, bi) => {
      if (b.members.length < 2) return;
      const forward = b.members;
      const backward = [...b.members].reverse();
      const adjacencyScore = (ms: string[]) => {
        let s = 0;
        const left = row[bi - 1];
        const right = row[bi + 1];
        if (left && left.members.some((o) => sharesParent(o, ms[0]))) s++;
        if (right && right.members.some((o) => sharesParent(o, ms[ms.length - 1]))) s++;
        return s;
      };
      const inversions = (ms: string[]) => {
        let n = 0;
        for (let i = 0; i < ms.length; i++) {
          for (let j = i + 1; j < ms.length; j++) {
            const ki = mKey.get(ms[i]);
            const kj = mKey.get(ms[j]);
            if (ki != null && kj != null && ki > kj) n++;
          }
        }
        return n;
      };
      const preferBackward =
        adjacencyScore(backward) - adjacencyScore(forward) ||
        inversions(forward) - inversions(backward);
      if (preferBackward > 0) b.members = backward;
    });
  };

  // ---- Barycenter sweep. `down` orders each row by parents above, `up` by
  // children below; blocks without an anchor keep their current slot instead
  // of being dumped at the end (the old 1e9 sentinel).
  const eldestOf = (b: Block): number => {
    const blood = b.members.filter((m) => (parentsOf.get(m) ?? []).length > 0);
    const pool = blood.length ? blood : b.members;
    return Math.min(...pool.map(bornTime));
  };

  const orderRowByNeighbors = (
    s: Block[][],
    r: number,
    dir: 'down' | 'up',
  ): boolean => {
    const neigh = dir === 'down' ? parentsOf : childrenOf;
    const pos = flatPositions(s);
    const row = s[r];
    const mKey = new Map<string, number | null>();
    for (const b of row) {
      for (const id of b.members) {
        const anchors = (neigh.get(id) ?? []).filter((n) => pos.has(n));
        mKey.set(
          id,
          anchors.length
            ? anchors.reduce((sum, n) => sum + pos.get(n)!, 0) / anchors.length
            : null,
        );
      }
    }
    const blockKey = new Map<Block, number>();
    row.forEach((b, bi) => {
      const keys = b.members
        .map((m) => mKey.get(m))
        .filter((k): k is number => k != null);
      blockKey.set(
        b,
        keys.length ? keys.reduce((sum, k) => sum + k, 0) / keys.length : bi,
      );
    });
    const before = row.flatMap((b) => b.members).join('|');
    row.sort(
      (a, b) =>
        cmpNum(blockKey.get(a)!, blockKey.get(b)!) ||
        cmpNum(eldestOf(a), eldestOf(b)) ||
        nameOf(a.members[0]).localeCompare(nameOf(b.members[0])) ||
        (a.members[0] < b.members[0] ? -1 : 1),
    );
    orientBlocks(row, mKey);
    return row.flatMap((b) => b.members).join('|') !== before;
  };

  const sweep = (s: Block[][], dir: 'down' | 'up'): boolean => {
    const rowIdxs = s.map((_, i) => i);
    if (dir === 'up') rowIdxs.reverse();
    let changed = false;
    for (const r of rowIdxs) {
      if (orderRowByNeighbors(s, r, dir)) changed = true;
    }
    return changed;
  };

  // ---- Transpose: swap adjacent blocks while the score strictly improves.
  // A swap only perturbs connector groups touching its own row, so the
  // accept test runs on the row-local score.
  const transpose = (s: Block[][]): boolean => {
    let improved = false;
    for (let r = 0; r < s.length; r++) {
      const row = s[r];
      if (row.length < 2) continue;
      let rowScore = scoreOf(s, r);
      for (let bi = 0; bi + 1 < row.length; bi++) {
        [row[bi], row[bi + 1]] = [row[bi + 1], row[bi]];
        const c = scoreOf(s, r);
        if (scoreBetter(c, rowScore)) {
          rowScore = c;
          improved = true;
        } else {
          [row[bi], row[bi + 1]] = [row[bi + 1], row[bi]];
        }
      }
    }
    return improved;
  };

  // ---- Relocation: try each block in every other slot of its row and keep
  // the best strict improvement. Adjacent swaps alone strand a sibling far
  // from their family whenever the multi-step walk back passes through worse
  // intermediate states (e.g. a couple parked behind another family's
  // sibling run). Each candidate is scored twice: as-is, and with the rows
  // below re-flowed by a top-down barycenter pass — moving a couple only
  // pays off once their descendants follow, which no single-row move can
  // express.
  // With `reflow: false` (the post-insertion polish), the expensive cloned
  // reflow trial is skipped and plain moves are tested in place against the
  // row-local score — same accept decisions for plain moves, none of the
  // clone + full-rescore cost.
  const RELOCATE_WINDOW = 2; // probe target block index ± this many slots
  const relocate = (s: Block[][], reflow = true, probeSettled = true): boolean => {
    let improved = false;
    let current = reflow ? scoreOf(s) : { crossings: 0, span: 0 };
    for (let r = 0; r < s.length; r++) {
      const row = s[r];
      for (let bi = 0; bi < row.length; bi++) {
        // Probing every block against every slot with a cloned reflow is
        // quadratic and made large trees take seconds; instead, only blocks
        // that sit away from their kin barycenter are candidates, and only
        // slots around that target get probed.
        const pos = flatPositions(s);
        const b = row[bi];
        let sum = 0;
        let n = 0;
        for (const id of b.members) {
          for (const a of [...(parentsOf.get(id) ?? []), ...(childrenOf.get(id) ?? [])]) {
            const p = pos.get(a);
            if (p !== undefined) {
              sum += p;
              n++;
            }
          }
        }
        if (!n) continue;
        const target = sum / n;
        const center =
          b.members.reduce((acc, id) => acc + pos.get(id)!, 0) / b.members.length;
        // In fast mode only off-barycenter blocks are worth a probe. Reflow
        // mode (with probeSettled) probes settled blocks too: a clan can sit
        // exactly at its barycenter (a local optimum) while a coordinated
        // multi-row move — the couple relocating AND its descendants
        // following — is strictly better, e.g. a pendant family hopping out
        // of another family's sibling run. The classic candidate keeps the
        // old unconditional skip so it reproduces the pre-stub engine.
        if ((!reflow || !probeSettled) && Math.abs(center - target) < 1) continue;
        // Member-coordinate target -> block index in this row.
        let tIdx = row.length - 1;
        let seen = 0;
        for (let k = 0; k < row.length; k++) {
          seen += row[k].members.length;
          if (target < seen) {
            tIdx = k;
            break;
          }
        }
        const lo = Math.max(0, tIdx - RELOCATE_WINDOW);
        const hi = Math.min(row.length - 1, tIdx + RELOCATE_WINDOW);
        if (!reflow) {
          let local = scoreOf(s, r);
          let bestAt = -1;
          const [moved] = row.splice(bi, 1);
          for (let bj = lo; bj <= hi; bj++) {
            if (bj === bi) continue;
            row.splice(bj, 0, moved);
            const sc = scoreOf(s, r);
            row.splice(bj, 1);
            if (scoreBetter(sc, local)) {
              local = sc;
              bestAt = bj;
            }
          }
          row.splice(bestAt >= 0 ? bestAt : bi, 0, moved);
          if (bestAt >= 0) improved = true;
          continue;
        }
        let bestState: Block[][] | null = null;
        let bestScore = current;
        for (let bj = lo; bj <= hi; bj++) {
          if (bj === bi) continue;
          // Rows above r are only read by the trial — share them.
          const trial = s.map((rw, q) =>
            q < r ? rw : rw.map((b) => ({ members: [...b.members] })),
          );
          const [moved] = trial[r].splice(bi, 1);
          trial[r].splice(bj, 0, moved);
          const plain = scoreOf(trial);
          if (scoreBetter(plain, bestScore)) {
            bestScore = plain;
            bestState = clone(trial);
          }
          for (let q = r + 1; q < trial.length; q++) {
            orderRowByNeighbors(trial, q, 'down');
          }
          const reflowed = scoreOf(trial);
          if (scoreBetter(reflowed, bestScore)) {
            bestScore = reflowed;
            bestState = trial;
          }
        }
        if (bestState) {
          for (let q = 0; q < s.length; q++) s[q] = bestState[q];
          current = bestScore;
          improved = true;
        }
      }
    }
    return improved;
  };

  const clone = (s: Block[][]): Block[][] =>
    s.map((row) => row.map((b) => ({ members: [...b.members] })));

  // ---- One full ordering pipeline: barycenter sweeps, transpose/relocate,
  // and (for the stub-anchored candidate) stub re-insertion plus polish.
  // `withStubs: false, probeSettled: false` reproduces the classic pre-stub
  // engine on the same helpers.
  const runOrdering = (
    s0: Block[][],
    withStubs: boolean,
    probeSettled: boolean,
  ): Block[][] => {
    let s = s0;

    // Pull stub blocks out of the search state (rowOf keeps everyone).
    // Spouse edges never cross a stub boundary (a stub spouse tied to the
    // core would be a second connection, contradicting pendant-ness), so
    // blocks partition cleanly; rows keep their index, possibly empty for
    // now.
    const stubBlocksOf = new Map<string, { r: number; block: Block }[]>();
    if (withStubs && stubAnchor.size) {
      s = s.map((row, r) =>
        row.filter((b) => {
          const anchor = stubAnchor.get(b.members[0]);
          if (!anchor) return true;
          const arr = stubBlocksOf.get(anchor) ?? [];
          arr.push({ r, block: b });
          stubBlocksOf.set(anchor, arr);
          return false;
        }),
      );
    }

    let best = clone(s);
    let bestScore = scoreOf(s);
    for (let it = 0; it < ORDER_SWEEPS; it++) {
      const downChanged = sweep(s, 'down');
      const upChanged = sweep(s, 'up');
      const c = scoreOf(s);
      if (scoreBetter(c, bestScore)) {
        bestScore = c;
        best = clone(s);
      }
      if (!downChanged && !upChanged) break;
    }
    s = best;
    for (let it = 0; it < TRANSPOSE_ROUNDS; it++) {
      const t = transpose(s);
      const r = relocate(s, true, probeSettled);
      if (!t && !r) break;
    }

    // ---- Stub re-insertion. The core order is settled without any stub
    // pulling on its marry-in; hang each pendant unit back in, block by
    // block from the anchor outward, each block at the barycenter slot of
    // its already-placed kin — the core order itself is never permuted.
    if (!stubBlocksOf.size) return s;
    const state = s;
    const pos0 = flatPositions(state);
    const anchors = [...stubBlocksOf.keys()].sort(
      (a, b) => cmpNum(pos0.get(a) ?? 0, pos0.get(b) ?? 0) || (a < b ? -1 : 1),
    );
    const inserted: { r: number; block: Block }[] = [];
    // Mean placed-kin position of a block, ignoring same-row kin.
    const kinKey = (block: Block, r: number, pos: Map<string, number>): number | null => {
      let sum = 0;
      let n = 0;
      for (const id of block.members) {
        for (const k of [...(parentsOf.get(id) ?? []), ...(childrenOf.get(id) ?? [])]) {
          if (rowOf.get(k) === r) continue;
          const p = pos.get(k);
          if (p !== undefined) {
            sum += p;
            n++;
          }
        }
      }
      return n ? sum / n : null;
    };
    for (const anchor of anchors) {
      const ar = rowOf.get(anchor)!;
      const pending = [...stubBlocksOf.get(anchor)!].sort(
        (a, b) =>
          cmpNum(Math.abs(a.r - ar), Math.abs(b.r - ar)) ||
          personCmp(a.block.members[0], b.block.members[0]),
      );
      while (pending.length) {
        const pos = flatPositions(state);
        let pick = 0;
        let desired: number | null = null;
        for (let i = 0; i < pending.length; i++) {
          desired = kinKey(pending[i].block, pending[i].r, pos);
          if (desired !== null) {
            pick = i;
            break;
          }
        }
        const { r, block } = pending.splice(pick, 1)[0];
        const row = state[r];
        // Estimate: before the first keyed core block whose kin barycenter
        // exceeds ours (unkeyed blocks are skipped for the comparison) —
        // then let the real objective pick among the slots around it, so
        // stubs hanging near the same anchor don't stack in arbitrary order.
        let insertAt = row.length;
        let lastKeyed = -1;
        if (desired !== null) {
          for (let bi = 0; bi < row.length; bi++) {
            const key = kinKey(row[bi], r, pos);
            if (key === null) continue;
            if (key > desired) {
              insertAt = bi;
              break;
            }
            lastKeyed = bi;
          }
          if (insertAt === row.length && lastKeyed >= 0) insertAt = lastKeyed + 1;
        }
        // Refine within a window by CROSSINGS only — the span term is
        // computed against a partially re-inserted state and its 2^depth
        // top-row weighting misleads deep stubs; crossings are always real.
        // Ties keep the slot closest to the barycenter estimate.
        let bestAt = insertAt;
        if (row.length) {
          let bestCross = Number.POSITIVE_INFINITY;
          const lo = Math.max(0, insertAt - RELOCATE_WINDOW);
          const hi = Math.min(row.length, insertAt + RELOCATE_WINDOW);
          const slots = [...Array(hi - lo + 1)].map((_, i) => lo + i);
          slots.sort(
            (a, b) => cmpNum(Math.abs(a - insertAt), Math.abs(b - insertAt)) || cmpNum(a, b),
          );
          for (const at of slots) {
            row.splice(at, 0, block);
            const c = scoreOf(state, r).crossings;
            row.splice(at, 1);
            if (c < bestCross) {
              bestCross = c;
              bestAt = at;
            }
          }
        }
        row.splice(bestAt, 0, block);
        inserted.push({ r, block });
      }
    }

    // Refine each stub block against the now-complete state: barycenter
    // insertion is blind to stubs placed after it, so slide every stub
    // block within a window of its slot and keep strict improvements on
    // the full objective. Scoring mid-insertion instead is tempting but
    // biased — later stubs' edges don't exist yet.
    const STUB_REFINE_ROUNDS = 4;
    const STUB_REFINE_WINDOW = 2 * RELOCATE_WINDOW;
    for (let round = 0; round < STUB_REFINE_ROUNDS; round++) {
      let improved = false;
      for (const { r, block } of inserted) {
        const row = state[r];
        const bi = row.indexOf(block);
        let current = scoreOf(state, r);
        row.splice(bi, 1);
        let bestAt = bi;
        const lo = Math.max(0, bi - STUB_REFINE_WINDOW);
        const hi = Math.min(row.length, bi + STUB_REFINE_WINDOW);
        for (let at = lo; at <= hi; at++) {
          row.splice(at, 0, block);
          const sc = scoreOf(state, r);
          row.splice(at, 1);
          if (scoreBetter(sc, current)) {
            current = sc;
            bestAt = at;
            improved = true;
          }
        }
        row.splice(bestAt, 0, block);
      }
      if (!improved) break;
    }

    // Then the usual strict-improvement transpose/relocate polish over the
    // full state.
    // Cheap in-place rounds burn down the easy wins; a bounded number of
    // expensive reflow rounds then escape the multi-row minima, each
    // followed by another cheap converge.
    const fastConverge = () => {
      for (let it = 0; it < TRANSPOSE_ROUNDS; it++) {
        const t = transpose(state);
        const r = relocate(state, false);
        if (!t && !r) break;
      }
    };
    fastConverge();
    for (let round = 0; round < 3; round++) {
      if (!relocate(state, true, probeSettled)) break;
      fastConverge();
    }
    return state;
  };

  // Final orientation pass against the settled neighbours, keyed by
  // parents. Runs per candidate (inside the pipeline, not after selection):
  // reversing a block's members moves individual child positions, so
  // orientation shifts the crossing count — candidates must be compared on
  // what will actually be drawn.
  const orientState = (s: Block[][]) => {
    const pos = flatPositions(s);
    for (const row of s) {
      const mKey = new Map<string, number | null>();
      for (const b of row) {
        for (const id of b.members) {
          const anchors = (parentsOf.get(id) ?? []).filter((n) => pos.has(n));
          mKey.set(
            id,
            anchors.length
              ? anchors.reduce((sum, n) => sum + pos.get(n)!, 0) / anchors.length
              : null,
          );
        }
      }
      orientBlocks(row, mKey);
    }
  };

  // ---- Candidate selection. The stub-anchored pipeline wins on the shapes
  // it was built for, but on ~5% of arbitrary trees the core-without-stubs
  // order settles into a basin the bounded re-insertion windows cannot fix,
  // ending worse than the classic joint search. Where trees are small
  // enough that a second full ordering is cheap, run the classic pipeline
  // too and keep the better result (ties keep classic) — layouts are then
  // never worse than the pre-stub engine. Above the cap the stub pipeline
  // consistently beat the classic one on the benchmark, so it stands alone.
  const DUAL_ORDERING_MAX_PEOPLE = 300;
  state = runOrdering(state, true, true);
  orientState(state);
  if (people.length <= DUAL_ORDERING_MAX_PEOPLE) {
    const classic = runOrdering(buildBlocks(), false, false);
    orientState(classic);
    if (!scoreBetter(scoreOf(state), scoreOf(classic))) state = classic;
  }

  // ---- X placement. Blocks get a left edge; iterate: desired position =
  // average of parent and child card centers, then resolve each row with an
  // order-preserving least-squares merge (overlapping runs collapse into a
  // cluster placed at the mean of its desires — no push-right-only bias).
  const colW = cardWidth + hGap;
  const blockWidth = (b: Block) =>
    b.members.length * cardWidth + (b.members.length - 1) * hGap;

  const placeRow = (desired: number[], widths: number[]): number[] => {
    interface Cluster {
      sum: number; // Σ (desired left − offset within cluster)
      n: number;
      w: number;
      start: number;
      count: number;
    }
    const clusters: Cluster[] = [];
    for (let i = 0; i < desired.length; i++) {
      let cur: Cluster = { sum: desired[i], n: 1, w: widths[i], start: i, count: 1 };
      while (clusters.length) {
        const prev = clusters[clusters.length - 1];
        if (cur.sum / cur.n >= prev.sum / prev.n + prev.w + hGap) break;
        clusters.pop();
        cur = {
          sum: prev.sum + cur.sum - cur.n * (prev.w + hGap),
          n: prev.n + cur.n,
          w: prev.w + hGap + cur.w,
          start: prev.start,
          count: prev.count + cur.count,
        };
      }
      clusters.push(cur);
    }
    const out: number[] = new Array(desired.length);
    for (const c of clusters) {
      let p = c.sum / c.n;
      for (let i = c.start; i < c.start + c.count; i++) {
        out[i] = p;
        p += widths[i] + hGap;
      }
    }
    return out;
  };

  const X: number[][] = state.map((row) => {
    let cur = 0;
    return row.map((b) => {
      const x = cur;
      cur += blockWidth(b) + hGap;
      return x;
    });
  });

  // member -> (row, block index, slot) for center lookups
  const slotOf = new Map<string, { r: number; bi: number; k: number }>();
  state.forEach((row, r) =>
    row.forEach((b, bi) => b.members.forEach((id, k) => slotOf.set(id, { r, bi, k }))),
  );
  const centerOf = (id: string): number => {
    const s = slotOf.get(id)!;
    return X[s.r][s.bi] + s.k * colW + cardWidth / 2;
  };

  const relaxRow = (r: number) => {
    const row = state[r];
    const desired = row.map((b, bi) => {
      const wants: number[] = [];
      b.members.forEach((id, k) => {
        const anchors = [
          ...(parentsOf.get(id) ?? []),
          ...(childrenOf.get(id) ?? []),
        ].filter((n) => slotOf.has(n));
        if (!anchors.length) return;
        const target =
          anchors.reduce((sum, n) => sum + centerOf(n), 0) / anchors.length;
        wants.push(target - (k * colW + cardWidth / 2));
      });
      return wants.length
        ? wants.reduce((sum, v) => sum + v, 0) / wants.length
        : X[r][bi];
    });
    const placed = placeRow(desired, row.map(blockWidth));
    let moved = 0;
    placed.forEach((x, bi) => {
      moved += Math.abs(x - X[r][bi]);
      X[r][bi] = x;
    });
    return moved;
  };

  for (let it = 0; it < PLACE_ROUNDS; it++) {
    let moved = 0;
    for (let r = 0; r < state.length; r++) moved += relaxRow(r);
    for (let r = state.length - 1; r >= 0; r--) moved += relaxRow(r);
    if (moved < PLACE_EPSILON) break;
  }

  // ---- Component compaction. Disconnected families converge as free-
  // floating units, so relaxation can leave an arbitrary void between them;
  // pack each component as far left as its rows allow, left-to-right.
  {
    const blocksByComp = new Map<number, { r: number; bi: number }[]>();
    state.forEach((row, r) =>
      row.forEach((b, bi) => {
        const cid = compId.get(b.members[0])!;
        const arr = blocksByComp.get(cid) ?? [];
        arr.push({ r, bi });
        blocksByComp.set(cid, arr);
      }),
    );
    const comps = [...blocksByComp.entries()]
      .map(([cid, refs]) => ({
        cid,
        refs,
        minX: Math.min(...refs.map(({ r, bi }) => X[r][bi])),
      }))
      .sort((a, b) => a.minX - b.minX);
    for (const comp of comps) {
      let shift = Number.POSITIVE_INFINITY;
      for (const { r, bi } of comp.refs) {
        // Wall: the previous block in the row, unless it moves with us.
        const prev = bi > 0 ? state[r][bi - 1] : undefined;
        const wall =
          prev && compId.get(prev.members[0]) !== comp.cid
            ? X[r][bi - 1] + blockWidth(prev) + hGap
            : prev
              ? Number.NEGATIVE_INFINITY // same component: moves along
              : 0;
        if (wall !== Number.NEGATIVE_INFINITY) shift = Math.min(shift, X[r][bi] - wall);
      }
      if (Number.isFinite(shift) && shift > 0) {
        for (const { r, bi } of comp.refs) X[r][bi] -= shift;
      }
    }
  }

  // Normalize so the leftmost card sits at 0 and margins stay non-negative.
  let minLeft = Number.POSITIVE_INFINITY;
  X.forEach((row) => row.forEach((x) => (minLeft = Math.min(minLeft, x))));
  if (Number.isFinite(minLeft) && minLeft !== 0) {
    for (const row of X) {
      for (let bi = 0; bi < row.length; bi++) row[bi] -= minLeft;
    }
  }

  const margins = new Map<string, number>();
  state.forEach((row, r) => {
    let flow = 0;
    row.forEach((b, bi) => {
      b.members.forEach((id, k) => {
        const left = X[r][bi] + k * colW;
        margins.set(id, left - flow);
        flow = left + cardWidth;
      });
    });
  });

  const rows = state.map((row, r) => ({
    gen: sortedGens[r],
    ids: row.flatMap((b) => b.members),
  }));

  return { rows, validEdges, margins, crossings: totalCrossings(state) };
}
