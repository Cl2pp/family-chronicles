import { describe, expect, it } from 'vitest';
import { routeParentConnectors, type CardBox, type RouteEdge } from './tree-routing';

const CARD = 150;
const ROW_H = 120;
const ROW_GAP = 56;

/** Card box for a card centered at `cx` in row `row` (rows top-aligned). */
function box(cx: number, row: number): CardBox {
  const top = row * (ROW_H + ROW_GAP);
  return { cx, top, bottom: top + ROW_H, midY: top + ROW_H / 2 };
}

function parent(from: string, to: string): RouteEdge {
  return { type: 'parent', from, to };
}

/** Both parents of every child. */
function couple(a: string, b: string, children: string[]): RouteEdge[] {
  return children.flatMap((c) => [parent(a, c), parent(b, c)]);
}

function route(
  cards: Record<string, { cx: number; row: number }>,
  edges: RouteEdge[],
) {
  const positions = new Map<string, CardBox>();
  const rowIndexOf = new Map<string, number>();
  for (const [id, { cx, row }] of Object.entries(cards)) {
    positions.set(id, box(cx, row));
    rowIndexOf.set(id, row);
  }
  return routeParentConnectors({ positions, edges, rowIndexOf, cardWidth: CARD });
}

const busOf = (buses: ReturnType<typeof route>, parentIds: string[]) =>
  buses.find((b) => b.parentIds.join('|') === [...parentIds].sort().join('|'))!;

describe('routeParentConnectors', () => {
  it("merges a couple's children into one sibling bus", () => {
    const buses = route(
      {
        A: { cx: 300, row: 0 },
        B: { cx: 474, row: 0 },
        k1: { cx: 200, row: 1 },
        k2: { cx: 374, row: 1 },
        k3: { cx: 548, row: 1 },
      },
      couple('A', 'B', ['k1', 'k2', 'k3']),
    );
    expect(buses).toHaveLength(1);
    expect(buses[0].childIds).toEqual(['k1', 'k2', 'k3']); // sorted by x
    // The rail sits inside the gap between the rows.
    expect(buses[0].busY).toBeGreaterThan(ROW_H);
    expect(buses[0].busY).toBeLessThan(ROW_H + ROW_GAP);
    // Source drop starts at the spouse bar, not below the cards.
    expect(buses[0].d.startsWith(`M 387 ${ROW_H / 2} V `)).toBe(true);
  });

  it('separates overlapping family rails onto different lanes, wide rail on top', () => {
    // The screenshot shape: the Hartwig couple's daughters married into
    // families laid out far left and far right, so their rail spans right
    // across the Strauss couple's children.
    const buses = route(
      {
        GeraldS: { cx: 300, row: 0 },
        PetraS: { cx: 474, row: 0 },
        BjornH: { cx: 648, row: 0 },
        SilkeH: { cx: 822, row: 0 },
        Chira: { cx: 100, row: 1 },
        Nicole: { cx: 300, row: 1 },
        Sebastian: { cx: 474, row: 1 },
        Laura: { cx: 1000, row: 1 },
      },
      [
        ...couple('GeraldS', 'PetraS', ['Nicole', 'Sebastian']),
        ...couple('BjornH', 'SilkeH', ['Chira', 'Laura']),
      ],
    );
    expect(buses).toHaveLength(2);
    const strauss = busOf(buses, ['GeraldS', 'PetraS']);
    const hartwig = busOf(buses, ['BjornH', 'SilkeH']);
    // Distinct heights, both within the row gap.
    expect(strauss.busY).not.toBe(hartwig.busY);
    for (const bus of [strauss, hartwig]) {
      expect(bus.busY).toBeGreaterThan(ROW_H);
      expect(bus.busY).toBeLessThan(ROW_H + ROW_GAP);
    }
    // The wider (Hartwig) rail takes the lane closer to the parents.
    expect(hartwig.busY).toBeLessThan(strauss.busY);
  });

  it('lets families with disjoint spans share a lane', () => {
    const buses = route(
      {
        A: { cx: 100, row: 0 },
        B: { cx: 274, row: 0 },
        C: { cx: 700, row: 0 },
        D: { cx: 874, row: 0 },
        k1: { cx: 187, row: 1 },
        k2: { cx: 787, row: 1 },
      },
      [...couple('A', 'B', ['k1']), ...couple('C', 'D', ['k2'])],
    );
    expect(buses).toHaveLength(2);
    expect(buses[0].busY).toBe(buses[1].busY);
  });

  it('routes a lone parent from their own card bottom', () => {
    const buses = route(
      { P: { cx: 300, row: 0 }, k: { cx: 500, row: 1 } },
      [parent('P', 'k')],
    );
    expect(buses).toHaveLength(1);
    expect(buses[0].parentIds).toEqual(['P']);
    expect(buses[0].d.startsWith(`M 300 ${ROW_H} V `)).toBe(true);
  });

  it('draws one elbow per parent when the parents are not side by side', () => {
    const buses = route(
      {
        P1: { cx: 100, row: 0 },
        P2: { cx: 900, row: 0 }, // farther apart than a couple can be
        k: { cx: 500, row: 1 },
      },
      [parent('P1', 'k'), parent('P2', 'k')],
    );
    expect(buses).toHaveLength(2);
    expect(buses.map((b) => b.parentIds.length)).toEqual([1, 1]);
  });

  it('puts a multi-row rail in the band directly above the children', () => {
    const buses = route(
      {
        P: { cx: 300, row: 0 },
        other: { cx: 1000, row: 1 }, // unrelated card occupying the middle row
        k: { cx: 400, row: 2 },
      },
      [parent('P', 'k')],
    );
    expect(buses).toHaveLength(1);
    const row2Top = 2 * (ROW_H + ROW_GAP);
    expect(buses[0].busY).toBeGreaterThan(row2Top - ROW_GAP);
    expect(buses[0].busY).toBeLessThan(row2Top);
  });

  it('is deterministic', () => {
    const cards = {
      A: { cx: 300, row: 0 },
      B: { cx: 474, row: 0 },
      C: { cx: 648, row: 0 },
      k1: { cx: 100, row: 1 },
      k2: { cx: 400, row: 1 },
      k3: { cx: 700, row: 1 },
    };
    const edges = [
      ...couple('A', 'B', ['k1', 'k2']),
      parent('C', 'k3'),
      parent('C', 'k1'),
    ];
    const a = route(cards, edges);
    const b = route(cards, edges);
    expect(a).toEqual(b);
  });

  it('ignores spouse edges and edges to unplaced people', () => {
    const buses = route(
      { A: { cx: 300, row: 0 }, B: { cx: 474, row: 0 }, k: { cx: 387, row: 1 } },
      [
        { type: 'spouse', from: 'A', to: 'B' },
        parent('A', 'k'),
        parent('A', 'ghost'),
      ],
    );
    expect(buses).toHaveLength(1);
    expect(buses[0].childIds).toEqual(['k']);
  });
});
