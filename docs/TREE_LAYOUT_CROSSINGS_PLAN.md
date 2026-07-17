# Family-tree layout: crossings on wide/deep trees — diagnosis & fix plan

**Status:** investigation complete, fix not yet implemented. Handoff doc for the
next agent.

**Scope:** the pure layout engine `lib/tree-layout.ts` (`layoutFamilyTree`),
consumed only by `app/(app)/chronicle/family-tree.tsx`. Nothing else computes
tree layout; there is no server/worker/DB layout state.

---

## 1. Symptom

On a wide tree with **5–7 layers of ancestors**, the family tree renders with
**connector lines crossing and sibling groups split**, and adding people at the
top **reshuffles the whole tree**. A previously-good layout degrades after
ancestors are added — with **no change to the algorithm**. So this is an input
sensitivity / local-minimum problem, not a regression.

## 2. How to reproduce

A runnable benchmark is committed at **`scripts/tree-layout-bench.ts`**:

```
npx tsx scripts/tree-layout-bench.ts
```

Current output (baseline to beat):

| Case | People | Rows | Widest row | Crossings | Time |
|------|-------:|-----:|-----------:|----------:|-----:|
| nagore-repro | 40 | 4 | 14 | **3** | 54ms |
| tc=3 g=5 s=1 | 174 | 5 | 38 | **30** | 354ms |
| tc=4 g=6 s=1 | 373 | 6 | 72 | **37** | 1.7s |
| tc=5 g=7 s=1 | 763 | 7 | 143 | **174** | 8.5s |
| tc=4 g=6 s=3 | 379 | 6 | 80 | **57** | 2.1s |
| tc=5 g=7 s=9 | 609 | 7 | 108 | **98** | 4.9s |

The `nagore-repro` case is the minimal, human-readable reproduction: the
production family shape lays out at **0 crossings**, and adding **one marry-in's
parents** (`NopaN`+`NomaN` above `NagoreN`) takes it to **3**.

## 3. Root-cause diagnosis (with evidence)

The ordering stage of `layoutFamilyTree` is a local-search heuristic:
birthdate-sorted initial order → down/up **barycenter sweeps**
(`orderRowByNeighbors`/`sweep`) → adjacent-swap **transpose** → **relocate**
(a block jumps within a ±2 window around its kin barycenter, reflowing the rows
below). The objective is lexicographic: **(1) crossings, then (2) a
generation-weighted connector span**, the span weighted `2^(rows-1-childRow)`
i.e. doubling per row *upward* (`lib/tree-layout.ts` ~line 347).

Four things were established during investigation:

1. **The good layout exists — the engine just doesn't find it.** Replicating the
   engine's exact crossing metric over a hand-built ordering of the `nagore`
   graph gives **0 crossings**, where the engine settles at **3**. So these are
   genuine local minima, not the true optimum.

2. **Not a compute-budget problem.** Re-running with **10×** the iteration
   budgets (`ORDER_SWEEPS` 10→200, `TRANSPOSE_ROUNDS` 20→400, `PLACE_ROUNDS`
   40→800, `RELOCATE_WINDOW` 2→6) produces **identical or sometimes worse**
   results (e.g. 37→54). The search is fully converged; more iterations do not
   escape the basin.

3. **Depth and width alone are fine.** A *pure* upward pedigree (each ancestor
   couple has exactly one child in the tree, fanning up) lays out at **0
   crossings even at 256 people / 8 rows**. The trees that break are the ones
   that mix downward growth (siblings, descendants, cousin intermarriage) with
   **marry-ins that carry their own ancestor lines**.

4. **Naive structure-aware init does NOT fix it — it makes it worse.** A
   prototype that replaced the birthdate-sorted init with a DFS-descendant
   ordering (keep each subtree contiguous, traverse from the eldest top-gen
   root) scored **worse** on every non-trivial case (48 vs 37, 197 vs 174).
   Reason below.

### The specific mechanism

The killer structure is an **ancestor stub**: a subtree whose only connection to
the rest of the tree is a **single downward edge into a marry-in** (the
marry-in's parents, grandparents, …). In the base layout a marry-in has no
parents, so their block is placed *freely* by their blood spouse's barycenter and
sits happily mid-row. Add their ancestors and that block suddenly has an
**upward anchor too**, tied to a subtree rooted at *old founders* several layers
up. Now:

- The barycenter sweep tries to satisfy the new upward pull by dragging the
  marry-in toward the stub — and because the marry-in is spouse-locked to a blood
  person who is child-locked to *their* parents and sibling-locked to *their*
  siblings (whose spouses may have their own stubs…), **the whole interlocked
  cluster cascades**. That cascade is the "whole tree reshuffled" symptom, and it
  lands in a crossing-heavy basin.
- The move-set cannot express the correct move: **park a whole multi-layer stub
  as a rigid unit directly above its one descendant, disturbing nothing else.**
  `transpose` only swaps adjacent blocks; `relocate` has a ±2 window and only
  reflows *downward* (`for (q = r+1 …)`), so it can neither move a stub far
  enough nor coordinate the move across the stub's several rows.
- A DFS-descendant init makes it worse because stub founders are the *oldest*
  people, so an eldest-first traversal roots at a stub and drags its deep
  descendant subtree to the wrong side before the main tree is even placed.

## 4. Recommended fix — anchor ancestor stubs to their descendant

Add a **stub-anchoring pass** to the ordering stage that treats each ancestor
stub as a pendant unit hung above its single connection point.

**Sketch:**

1. **Identify stubs.** A stub is a connected set of blocks in the generations
   *above* a marry-in whose only edge into the rest of the graph is the one
   parent→marry-in edge. Concretely: from each marry-in that has parents in the
   tree, walk upward through parent edges; the walk is a stub iff no block on it
   has a child edge to anyone outside the walk. (Multi-layer stubs are common in
   a 5–7 layer tree — handle the whole chain, not just the immediate parents.)
2. **Anchor + align.** After the main ordering settles the dense core, place each
   stub's blocks so every stub row-block sits directly above its child link
   (vertical stack over the marry-in), as one rigid unit, inserted into the
   already-good core order without permuting the core.
3. **Re-score with the existing objective** and keep the move only if it does not
   increase crossings (it should reduce them). This mirrors how `relocate`
   already accepts moves on the lexicographic score.

This is the one approach that directly targets the mechanism in §3. It is a
focused change to the ordering stage — **not** a rewrite of generation
assignment or X-placement, both of which are working correctly.

### Alternatives considered (and why they lose)

- **More iterations / wider relocate window** — ruled out by evidence #2.
- **Structure-aware DFS init** — ruled out by evidence #4 (makes it worse).
- **Stability / warm-start term** (prefer the previous layout so small edits
  don't re-solve globally) — worth doing *as well* for the "adding one person
  reshuffles everything" complaint and ties into the recomputation theme, but it
  does not by itself fix the crossings; the stub-anchoring pass is the primary
  fix. Consider as a fast-follow.
- **Softening the `2^depth` top-weighting of the span term** — the exponential
  makes the sparse top generations dominate the objective and is complicit in the
  global reshuffle; worth revisiting, but crossings are the *primary* objective
  and the crossing basin is the real problem, so re-weighting span alone will not
  fix it.

## 5. Secondary issue — runtime at scale

`relocate` clones and reflows the rows below for every candidate slot, making the
ordering stage roughly O(n²); the 763-person tree takes **~8.5s**. Because the
layout is recomputed **from scratch client-side in a `useMemo` on every
people/edges change** (`family-tree.tsx:194`), a real 5–7 layer tree will feel
sluggish on every edit. Options: cap/short-circuit `relocate` candidates,
memoize `scoreOf` deltas instead of full re-scores, or (bigger) warm-start from
the previous layout. Decide with the requester whether to fold this into the same
change.

## 6. Acceptance criteria

- `nagore-repro` in `scripts/tree-layout-bench.ts` drops from **3 → 0** crossings.
- The generated benchmark cases drop **substantially** (target: large trees under
  ~a handful of crossings; ideally 0 where planar).
- All existing tests in `lib/tree-layout.test.ts` stay green (they encode the
  hard-won invariants: spouses adjacent, marry-in on the outer side, sibling
  groups contiguous, generation leveling by kinship, deterministic/stable output,
  no overlaps).
- Add regression tests derived from `nagore-repro` and at least one generated
  benchmark shape.
- No regression in wall-clock on the benchmark (ideally an improvement if §5 is
  addressed).

## 7. Key files

- `lib/tree-layout.ts` — the engine. Ordering stage is ~lines 299–596; the
  relocate pass ~485–554; the span objective ~320–359.
- `lib/tree-layout.test.ts` — invariants / regression guard.
- `lib/tree-routing.ts` — draws the connector buses; **not** where crossings are
  decided, but where they become visible. Out of scope for the fix.
- `scripts/tree-layout-bench.ts` — reproduction + measurement harness.
- `app/(app)/chronicle/family-tree.tsx:194` — the sole caller (client `useMemo`).
