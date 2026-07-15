/**
 * Pure connector routing for the family-tree view (no DOM, no React): turns
 * measured card boxes + parent edges into orthogonal "sibling bus" paths.
 *
 * Every parent couple (or lone parent) gets ONE bus per child row: a drop
 * from the couple's spouse bar, a horizontal rail, and a drop onto each
 * child. Rails that would overlap horizontally in the same row gap are
 * pushed onto separate lanes (greedy interval coloring), so two families'
 * connectors can never merge into a single ambiguous line — previously every
 * bus sat at the same mid-gap height, and a wide family (children married
 * into branches laid out far left/right) ran exactly on top of a
 * neighbouring couple's bus. Wider rails take the lanes closer to the
 * parents: a family nested inside a wide rail's span then crosses it once
 * with its source drop, instead of once per child drop.
 */

export interface CardBox {
  cx: number;
  top: number;
  bottom: number;
  midY: number;
}

export interface RouteEdge {
  type: string; // 'parent' | 'spouse'
  from: string;
  to: string;
}

export interface ParentBus {
  /** SVG path: source drop, horizontal rail, one drop per child. */
  d: string;
  parentIds: string[];
  childIds: string[];
  /** The rail's y coordinate — exposed for tests. */
  busY: number;
}

/** Rows are top-aligned, so same-row couples differ in top by rendering noise only. */
const COUPLE_TOP_TOLERANCE = 4;

export function routeParentConnectors(opts: {
  positions: Map<string, CardBox>;
  edges: RouteEdge[];
  /** Person id → row index, from the layout's `rows`. */
  rowIndexOf: Map<string, number>;
  cardWidth?: number;
  /** Minimum horizontal distance between two rails sharing a lane. */
  laneClearance?: number;
}): ParentBus[] {
  const { positions, edges, rowIndexOf } = opts;
  const cardWidth = opts.cardWidth ?? 150;
  const laneClearance = opts.laneClearance ?? 24;

  const parentsOfChild = new Map<string, string[]>();
  for (const e of edges) {
    if (e.type !== 'parent') continue;
    if (!positions.has(e.from) || !positions.has(e.to)) continue;
    if (!rowIndexOf.has(e.to)) continue;
    const arr = parentsOfChild.get(e.to) ?? [];
    arr.push(e.from);
    parentsOfChild.set(e.to, arr);
  }

  // Band = the empty strip between a row and the row above it. Rails always
  // live in the band directly above their children, so a multi-row connector
  // drops straight through intermediate rows (behind the cards) and only
  // goes horizontal right before reaching its children.
  const maxBottom = new Map<number, number>();
  const minTop = new Map<number, number>();
  for (const [id, r] of rowIndexOf) {
    const p = positions.get(id);
    if (!p) continue;
    maxBottom.set(r, Math.max(maxBottom.get(r) ?? Number.NEGATIVE_INFINITY, p.bottom));
    minTop.set(r, Math.min(minTop.get(r) ?? Number.POSITIVE_INFINITY, p.top));
  }

  interface Bus {
    parentIds: string[];
    childIds: string[];
    sourceX: number;
    sourceY: number;
    childRow: number;
    left: number;
    right: number;
    lane: number;
  }

  // One bus per (union, child row). A union is a side-by-side couple — the
  // same geometric test the old renderer used — or a lone parent; a child
  // whose parents ended up apart gets one elbow per parent, as before.
  const buses = new Map<string, Bus>();
  for (const [child, ps] of parentsOfChild) {
    const childRow = rowIndexOf.get(child)!;
    const a = positions.get(ps[0])!;
    const b = ps.length === 2 ? positions.get(ps[1])! : undefined;
    const sideBySide =
      !!b &&
      Math.abs(a.top - b.top) < COUPLE_TOP_TOLERANCE &&
      Math.abs(a.cx - b.cx) < cardWidth * 2;
    const unions: string[][] = sideBySide ? [[...ps].sort()] : ps.map((p) => [p]);
    for (const u of unions) {
      const key = `${u.join('|')}@${childRow}`;
      let bus = buses.get(key);
      if (!bus) {
        const boxes = u.map((id) => positions.get(id)!);
        bus = {
          parentIds: u,
          childIds: [],
          sourceX: boxes.reduce((s, p) => s + p.cx, 0) / boxes.length,
          // Couples drop from the middle of their spouse bar, lone parents
          // from their card's bottom edge.
          sourceY:
            boxes.length === 2 ? (boxes[0].midY + boxes[1].midY) / 2 : boxes[0].bottom,
          childRow,
          left: 0,
          right: 0,
          lane: 0,
        };
        buses.set(key, bus);
      }
      bus.childIds.push(child);
    }
  }

  for (const bus of buses.values()) {
    const xs = [bus.sourceX, ...bus.childIds.map((c) => positions.get(c)!.cx)];
    bus.left = Math.min(...xs);
    bus.right = Math.max(...xs);
    bus.childIds.sort(
      (a, b) => positions.get(a)!.cx - positions.get(b)!.cx || (a < b ? -1 : 1),
    );
  }

  const byBand = new Map<number, Bus[]>();
  for (const bus of buses.values()) {
    const arr = byBand.get(bus.childRow) ?? [];
    arr.push(bus);
    byBand.set(bus.childRow, arr);
  }

  const out: ParentBus[] = [];
  for (const [row, band] of [...byBand.entries()].sort((a, b) => a[0] - b[0])) {
    // Widest first, so wide rails claim the top lanes (nearest the parents).
    band.sort(
      (a, b) =>
        b.right - b.left - (a.right - a.left) ||
        a.left - b.left ||
        (a.parentIds[0] < b.parentIds[0] ? -1 : 1),
    );
    const lanes: { left: number; right: number }[][] = [];
    for (const bus of band) {
      let lane = lanes.findIndex((occupied) =>
        occupied.every(
          (o) => bus.right + laneClearance <= o.left || bus.left - laneClearance >= o.right,
        ),
      );
      if (lane === -1) {
        lane = lanes.length;
        lanes.push([]);
      }
      lanes[lane].push({ left: bus.left, right: bus.right });
      bus.lane = lane;
    }

    // Spread the lanes evenly across the band; a single lane lands mid-gap,
    // matching the old rendering for the simple case.
    const bandBottom = minTop.get(row) ?? 0;
    const bandTop = Math.min(maxBottom.get(row - 1) ?? bandBottom - 48, bandBottom);
    const step = (bandBottom - bandTop) / (lanes.length + 1);
    band.sort((a, b) => a.lane - b.lane || a.left - b.left);
    for (const bus of band) {
      const busY = bandTop + step * (bus.lane + 1);
      let d = `M ${bus.sourceX} ${bus.sourceY} V ${busY}`;
      if (bus.right > bus.left) d += ` M ${bus.left} ${busY} H ${bus.right}`;
      for (const c of bus.childIds) {
        const p = positions.get(c)!;
        d += ` M ${p.cx} ${busY} V ${p.top}`;
      }
      out.push({ d, parentIds: [...bus.parentIds], childIds: [...bus.childIds], busY });
    }
  }
  return out;
}
