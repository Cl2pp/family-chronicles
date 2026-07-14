/**
 * Pure layout engine for the family-tree view (no DOM, no React) so it can be
 * unit-tested and evolved without touching rendering.
 *
 * Layered (Sugiyama-style) layout specialised for genealogy:
 * - Couples stay adjacent: each row is a sequence of "blocks" (spouse-connected
 *   groups); ordering and placement move blocks, never split them.
 * - Row order comes from iterated down/up barycenter sweeps followed by a
 *   transpose pass that swaps neighbouring blocks while crossings decrease.
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
  displayName: string;
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

  // ---- Generation assignment: monotonic relaxation (gens only ever increase).
  // Children end up strictly below both parents; spouses share a row.
  const gen = new Map<string, number>();
  for (const id of ids) gen.set(id, 0);
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

  // ---- Deterministic person ordering helpers.
  const bornTime = (id: string): number => {
    const b = byId.get(id)?.bornOn;
    if (!b) return Number.POSITIVE_INFINITY;
    const d = typeof b === 'string' ? new Date(b) : b;
    const t = d.getTime();
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  const nameOf = (id: string) => byId.get(id)?.displayName ?? '';
  const personCmp = (a: string, b: string) =>
    cmpNum(bornTime(a), bornTime(b)) ||
    nameOf(a).localeCompare(nameOf(b)) ||
    (a < b ? -1 : a > b ? 1 : 0);

  const parentSet = new Map<string, Set<string>>();
  for (const [c, ps] of parentsOf) parentSet.set(c, new Set(ps));
  const sharesParent = (a: string, b: string): boolean => {
    const pa = parentSet.get(a);
    const pb = parentSet.get(b);
    if (!pa || !pb) return false;
    for (const p of pa) if (pb.has(p)) return true;
    return false;
  };

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

  let state: Block[][] = sortedGens.map((g) => {
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

  // ---- Crossing count over parent connectors, matching what the renderer
  // draws: parents in the same couple block emit ONE union edge from their
  // midpoint (two per-parent edges to two children would otherwise count a
  // phantom crossing inside every couple). Edges are grouped by
  // (parent row, child row) so multi-row spans only compete on the same span.
  const totalCrossings = (s: Block[][]): number => {
    const pos = flatPositions(s);
    const blockOf = new Map<string, Block>();
    for (const row of s) for (const b of row) for (const id of b.members) blockOf.set(id, b);
    const groups = new Map<string, [number, number][]>();
    for (const [child, ps] of parentsOf) {
      const rc = rowOf.get(child);
      if (rc === undefined) continue;
      // One union source per (parent block, child): midpoint of the parents
      // of this child that share the block.
      const perBlock = new Map<Block, number[]>();
      for (const p of ps) {
        const b = blockOf.get(p);
        if (!b || rowOf.get(p) === undefined) continue;
        const arr = perBlock.get(b) ?? [];
        arr.push(pos.get(p)!);
        perBlock.set(b, arr);
      }
      for (const [b, xs] of perBlock) {
        const rp = rowOf.get(b.members[0])!;
        const key = `${rp}:${rc}`;
        const arr = groups.get(key) ?? [];
        arr.push([xs.reduce((sum, v) => sum + v, 0) / xs.length, pos.get(child)!]);
        groups.set(key, arr);
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
    return n;
  };

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

  const sweep = (s: Block[][], dir: 'down' | 'up'): boolean => {
    const neigh = dir === 'down' ? parentsOf : childrenOf;
    const rowIdxs = s.map((_, i) => i);
    if (dir === 'up') rowIdxs.reverse();
    let changed = false;
    for (const r of rowIdxs) {
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
      if (row.flatMap((b) => b.members).join('|') !== before) changed = true;
    }
    return changed;
  };

  // ---- Transpose: swap adjacent blocks while it strictly reduces crossings.
  const transpose = (s: Block[][]): boolean => {
    let improved = false;
    let current = totalCrossings(s);
    for (const row of s) {
      for (let bi = 0; bi + 1 < row.length; bi++) {
        [row[bi], row[bi + 1]] = [row[bi + 1], row[bi]];
        const c = totalCrossings(s);
        if (c < current) {
          current = c;
          improved = true;
        } else {
          [row[bi], row[bi + 1]] = [row[bi + 1], row[bi]];
        }
      }
    }
    return improved;
  };

  const clone = (s: Block[][]): Block[][] =>
    s.map((row) => row.map((b) => ({ members: [...b.members] })));

  let best = clone(state);
  let bestCrossings = totalCrossings(state);
  for (let it = 0; it < ORDER_SWEEPS; it++) {
    const downChanged = sweep(state, 'down');
    const upChanged = sweep(state, 'up');
    const c = totalCrossings(state);
    if (c < bestCrossings) {
      bestCrossings = c;
      best = clone(state);
    }
    if (!downChanged && !upChanged) break;
  }
  state = best;
  for (let it = 0; it < TRANSPOSE_ROUNDS; it++) {
    if (!transpose(state)) break;
  }

  // Final orientation pass against the settled neighbours, keyed by parents.
  {
    const pos = flatPositions(state);
    for (const row of state) {
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
    const adj = new Map<string, string[]>();
    for (const e of validEdges) {
      push(adj, e.from, e.to);
      push(adj, e.to, e.from);
    }
    const compId = new Map<string, number>();
    let nextComp = 0;
    for (const id of ids) {
      if (compId.has(id)) continue;
      const stack = [id];
      compId.set(id, nextComp);
      while (stack.length) {
        const c = stack.pop()!;
        for (const n of adj.get(c) ?? []) {
          if (!compId.has(n)) {
            compId.set(n, nextComp);
            stack.push(n);
          }
        }
      }
      nextComp++;
    }
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
