# Story Access Plan — relationship-based read access

Status: **agreed design, not yet implemented.** This documents the decisions made in
July 2026 and the implementation phases. Today, story read access is purely
chronicle-grained: any member of a chronicle a story is shared into can read it.
This plan restricts reads based on the viewer's position in the family graph.

## Goal

A story should be readable only by people it plausibly "belongs to": the author,
the people in it, and their close family — parents, children, grandparents,
grandchildren, siblings, spouses — while **not** leaking across a marriage to the
in-law side (my child's spouse's parents don't get my stories, and I don't get
theirs, unless our shared descendants are in them).

## The access rule

> A user may **read** a story iff any of:
>
> 1. they hold an `owner` membership in a chronicle the story is shared into, or
> 2. they wrote it (`stories.submitted_by`), or
> 3. the story is tagged (`story_people`) with at least one person in the
>    viewer's **visible-people set**.
>
> Contributors and viewers both follow this rule; only owners bypass it.
> **Edit** rights are unchanged (submitter or owner — `canUserEditStory`).

The rule runs on the **kinship graph** (`relationships`: `parent`/`spouse` edges),
never on surname strings — surnames collide, change at marriage, and are optional.
This mirrors how `lib/family-tags.ts` derives family tags.

### Visible-people set (decided: "blood + spouse + spouse's blood")

For the viewer's person node **P** (via `people.user_id`):

- **P** itself — being in a story always grants access;
- **spouses(P)**;
- **blood(P)** — everyone sharing a common ancestor with P, i.e. all descendants
  of all ancestors of P (self, parents, children, grandparents, grandchildren,
  siblings, aunts/uncles, cousins, nieces/nephews — any depth, capped at
  `MAX_GENERATIONS` like `familyTagsByPerson`);
- **blood(spouse)** for each spouse — the person who married in sees the family
  they married into (same spirit as family tags: "an Ortlepp with a Hartwick
  spouse is a Hartwick too"). This extension applies to the spouse **only** —
  it is computed per viewer and never traverses a second marriage edge, so it
  does not leak to the spouse's parents.

**Explicitly excluded (decided):** spouses of blood relatives. A story tagged only
with my son-in-law is his family's material, not mine. Consequence: step-relations
with no `parent` edge (grandma's second husband) are invisible to the grandchildren
unless a blood relative is also tagged; shared events should tag both spouses.
If this pinches later, "spouses of blood relatives" can be added as a toggle.

### Worked example (the rule-3 fixture)

Anna Ortlepp ⚭ Ben Hartwick, children Clara & Max. Anna's parents Otto & Olga
Ortlepp; Ben's parents Hans & Helga Hartwick; Ben's grandfather Gustav.

| Story tagged with…    | Otto sees? | Anna sees? | Why                                    |
| --------------------- | ---------- | ---------- | -------------------------------------- |
| Hans & Helga          | no         | yes        | Otto: no common ancestor. Anna: blood(spouse). |
| Hans, Helga, Gustav   | no         | yes        | grandparent extension of rule above    |
| Hans, Helga, Clara    | yes        | yes        | Clara is Otto's descendant             |
| Hans, Helga, Anna     | yes        | yes        | Anna is Otto's descendant              |
| Ben only              | no         | yes        | spouses-of-blood excluded              |
| Clara's brother Max   | yes        | yes        | blood (sibling/descendant)             |

These rows become the unit-test fixtures for `lib/story-access.ts`.

## Decided policies

| Question | Decision |
| --- | --- |
| Visible-set scope | blood(P) ∪ spouses(P) ∪ blood(spouses) |
| Stories with **zero** tagged people | **author + owners only** (in `family` mode) |
| Spouses of blood relatives / step-relations | excluded (revisit as toggle if needed) |
| Books | **per-viewer** filtering (see below) |
| Users not linked to a person | see only stories they wrote, plus a banner asking an owner to place them in the tree |
| Rollout | per-chronicle setting `story_access: 'open' \| 'family'`, default `open` (opt-in; prod must not hide stories overnight) |

The zero-tagged-people decision makes people-tagging an **access-control act**:
the save/edit UI must say so, and saving a story with no tagged people should
warn ("only you and owners will see this").

## Prerequisite: user ↔ person linking

The rule needs "the viewer's person," but today `people.user_id` is only set by
`createChronicle` for the creator (`lib/people.ts` `ensurePersonForUser`).
Invited users get a membership and **no person link** (`lib/invitations.ts`
`acceptInvitation` only inserts a `memberships` row).

Changes:

1. **Invitations carry a person.** Add `invitations.person_id` (nullable FK →
   `people`). The invite UI (chronicle settings) lets the inviter pick the tree
   node the invitee *is*, or create the person inline. On accept, set
   `people.user_id = userId` on that person (guarded: skip if the person was
   claimed meanwhile, or if the user already has a person — `people_user_uq` is
   unique on both sides in effect).
2. **Owner repair UI.** Settings/tree surface for owners to link or unlink an
   existing member's account to a person node — needed to backfill current
   accounts (incl. prod) before a chronicle flips to `family` mode.
3. **Fallback.** A member whose account has no person link, in a `family`-mode
   chronicle, sees only their own submissions + the banner.

## Access core: `lib/story-access.ts` (new)

- `visiblePersonIdsForUser(userId): Promise<Set<string>>` — one recursive CTE in
  the shape of `familyTagsByPerson` (`lib/family-tags.ts`): walk `parent` edges
  up from P and each spouse (ancestors), then all `parent` edges down from those
  ancestors (descendants), union spouses(P). Global graph, `MAX_GENERATIONS` cap.
- A reusable Drizzle/SQL predicate (or a `storyIds` filter helper) implementing
  the three-clause rule, parameterized by `userId` + the chronicle's
  `story_access` mode, so every read surface applies the identical logic.
- Unit tests seeded with the worked-example family above.

Per-request CTE cost is fine at family scale; add caching only if it ever shows
up in traces.

## Enforcement inventory

Nearly everything funnels through two functions in `lib/stories.ts`; the
predicate lands there and covers most surfaces transitively.

| Surface | Where | Change |
| --- | --- | --- |
| Stories list (page + all chat tools: `list_stories`, `get_story`, `resolveStory`) | `listStoriesForUser` (`lib/stories.ts`) | apply predicate |
| Story detail (gates assets, contributions, presigned URLs downstream) | `getStoryForUser` (`lib/stories.ts`) | apply predicate |
| Duplicate-check text feed | `listChronicleStoryTexts` (`lib/stories.ts`) | filter by the *acting user's* access |
| Styling context (worker prompt includes other stories' text — leak vector) | `styleContextForStory` (`lib/stories.ts`) | filter context to stories the *submitter* can read |
| Books | `lib/books.ts`, `lib/book-content.ts`, `app/api/books/*` | see below |
| Story save/tagging UI + chat draft warnings | story page, `lib/ai/tools/stories.ts` | surface access implications of (un)tagging; warn on zero people |

Not affected: presigned-URL minting (`presignGet`) stays gated by the page that
mints it; `canUserEditStory` unchanged; write paths already role-gated.

### Books (decided: per-viewer)

- **Assembly:** the story picker (`readyStoriesForChronicle`) shows only stories
  the *builder* can read; `setBookStories` re-validates the same.
- **Viewing:** the builder preview (`preview-html` route) filters chapters to
  those the *viewer* can read — Paged.js repaginates client-side, so partial
  content still lays out. The book list/detail stay visible; hidden chapters are
  simply absent (with a count note, e.g. "2 chapters not visible to you").
- **PDFs:** the rendered `preview`/`print` PDFs are single artifacts containing
  every chapter. Downloading either requires access to **all** stories in the
  book (or owner). Order flow implicitly inherits this (it needs the print PDF).

## Phases

1. **Person linking** — `invitations.person_id` migration, invite-as-person UI,
   accept-flow linking, owner link/unlink UI, prod backfill.
2. **Access core** — `lib/story-access.ts` + fixture tests; `chronicles.story_access`
   column (default `'open'`) + settings toggle (owner-only, with a "check that
   every member is linked" preflight warning).
3. **Wire reads** — `listStoriesForUser`, `getStoryForUser`,
   `listChronicleStoryTexts`, `styleContextForStory`; unlinked-user banner.
4. **Books** — picker filtering, per-viewer preview filtering, all-or-nothing PDF
   gate.
5. **Tagging UX** — prominent people-tagging at save/edit, zero-people warning,
   chat-tool messaging when names don't match tree members (today they're
   silently dropped — under `family` mode that silently narrows the audience).
