# Family Chronicle — Redesign & Feature Spec

> **Purpose.** A design + product brief to hand to **Claude Design** for a significant
> visual and structural redesign of Family Chronicle, plus the engineering notes
> (data model, AI chat pipeline) needed to implement it afterwards.
>
> **Audience.** UI/UX design first (sections 1–5), engineering second (sections 6–9).
>
> **Status.** Active spec. Design wireframes delivered; implementation pending.
> **Roadmap & current step:** `~/.claude/plans/curious-gliding-dijkstra.md`. Most data-model
> and product decisions are now resolved — see §8. Full data model + permissions in §6.

---

## 1. Overview

Family Chronicle is a private, multi-user **PWA** where families collect personal
stories and have them rewritten by AI into a shared, third-person family memoir on a
timeline.

This redesign does four things:

1. **Rebrand the visual language** from warm terracotta to a modern, clean
   **blue / white / black** app aesthetic.
2. **Restructure navigation** into a desktop app layout: a persistent **left
   vertical sidebar** + a **center content area**.
3. **Replace story creation** (today: Write / Speak tabbed composer) with a
   **conversational AI chat** — you talk to an assistant and it produces stories.
4. **Rework the data model** so a **Family is a simple family tree** (people + parent /
   spouse relationships), a **story can be shared across multiple families at once**,
   and a **person can belong to multiple families with a different role in each** —
   where that role is *derived from the tree* (e.g. *son* in Family A, *husband* in
   Family B). See §6.

### Design principles

- **Calm, modern, trustworthy.** This holds family memories — it should feel as
  considered as a good productivity app, not a scrapbook toy.
- **Conversation-first.** The chat is the front door for contributing. Everything
  else (browsing, reading) supports it.
- **Readable above all.** Long-form memoir text is the payload; typography and
  reading width are first-class.
- **One person, many families.** The UI must always make it clear *which family
  context* you are acting in, and let you switch effortlessly.

---

## 2. Design language

### 2.1 Color system — blue / white / black

Move from warm terracotta (`sienna`) to a cool, modern palette. **Blue** is the brand
and primary action color; **white / near-white** are surfaces; **black / slate** is
text and structure.

**Brand blue (primary).** A vivid, confident blue — think modern SaaS, not corporate
navy. Target the `#2563EB` family (around Mantine/Tailwind "blue 600").

| Token | Hex | Use |
|---|---|---|
| `brand/50` | `#EFF4FF` | tinted backgrounds, hover wash |
| `brand/100` | `#DBE6FE` | selected nav item background, soft chips |
| `brand/200` | `#BFD3FE` | borders on tinted surfaces |
| `brand/300` | `#93B4FD` | disabled primary, subtle accents |
| `brand/400` | `#609AFA` | hover for secondary blue elements |
| `brand/500` | `#3B82F6` | links, active icons |
| `brand/600` | `#2563EB` | **primary buttons, brand, focus ring** |
| `brand/700` | `#1D4ED8` | primary button hover/pressed |
| `brand/800` | `#1E40AF` | high-contrast accents on light |
| `brand/900` | `#1E3A8A` | deepest brand, rare |

**Neutrals (white → black).** Cool-gray ramp so neutrals feel related to the blue.

| Token | Hex | Use |
|---|---|---|
| `surface/base` | `#FFFFFF` | cards, content surfaces |
| `surface/subtle` | `#F8FAFC` | app background, sidebar |
| `surface/muted` | `#F1F5F9` | hover rows, inset wells, chat assistant bubble |
| `border/default` | `#E2E8F0` | hairlines, card borders |
| `border/strong` | `#CBD5E1` | inputs, dividers needing weight |
| `text/secondary` | `#64748B` | metadata, captions, dimmed |
| `text/primary` | `#0F172A` | body + headings (near-black slate) |
| `ink/black` | `#020617` | max-contrast headings, logo |

**Semantic.** `success #16A34A`, `warning #D97706`, `error #DC2626`, `info` = brand.

**Status mapping** (story lifecycle, replaces today's badge colors):
`draft` → neutral gray · `processing` → brand blue (animated) · `ready` → success green ·
`failed` → error red.

> **Mantine v9 implementation.** Replace the `sienna` tuple in `app/theme.ts` with a
> `brand` tuple (indices 0–9 = the 50–900 above), set `primaryColor: 'brand'`,
> `primaryShade: 6`. **Light-mode only** (decided) — black is text/structure on light
> surfaces; no dark theme in scope.
>
> ```ts
> const brand: MantineColorsTuple = [
>   '#EFF4FF','#DBE6FE','#BFD3FE','#93B4FD','#609AFA',
>   '#3B82F6','#2563EB','#1D4ED8','#1E40AF','#1E3A8A',
> ];
> ```

### 2.2 Typography

**Decision: fully modern sans everywhere** — drop the Georgia serif headings and the
memoir-book feel entirely. One typeface family across chrome, chat, cards, *and* the
story reading view, for a clean, consistent app look.

- **UI + reading:** `Inter` (or system `-apple-system, Segoe UI, Roboto…` as fallback),
  used everywhere including long memoir bodies.
- **Reading view tuning:** the story body still gets generous reading ergonomics —
  ~18px / 1.7 line-height, max ~68ch measure — just in sans, not serif.
- **Scale:** `display 32/40` · `h1 24/32` · `h2 20/28` · `h3 16/24` ·
  `body 15/24` · `small 13/20` · `caption 12/16`. Weights 400 / 500 / 600.

### 2.3 Shape, depth, motion

- **Radius:** `sm 8` · `md 12` (default) · `lg 16` · `full` for avatars/bubbles.
- **Elevation:** prefer **hairline borders + subtle shadow** over heavy shadows.
  `shadow/sm` = `0 1px 2px rgba(2,6,23,.06)`; `shadow/md` for popovers/menus.
- **Motion:** 120–180ms ease-out for hovers/selection; chat messages fade+rise in;
  streaming text appears token-by-token. Respect `prefers-reduced-motion`.
- **Icons:** continue with **Tabler Icons** (already a dependency), 1.5–2px stroke.

---

## 3. Information architecture & navigation

### 3.1 Desktop layout

```
┌───────────┬──────────────────────────────────────────────┐
│           │  Top bar: [Family switcher ▾]      [search] [👤]│
│  SIDEBAR  ├──────────────────────────────────────────────┤
│ (vertical)│                                                │
│           │                                                │
│  ◈ Brand  │              CENTER CONTENT                    │
│           │           (the active page)                    │
│  💬 Chat  │                                                │
│  📖 Stories│                                               │
│  👪 Family │                                               │
│  ⚙ Settings│                                               │
│           │                                                │
│  ─────────│                                                │
│  👤 Account│                                               │
└───────────┴──────────────────────────────────────────────┘
```

- **Left sidebar (persistent, ~240px; collapsible to ~64px icon rail).**
  - Brand mark at top.
  - Primary nav items (icon + label): **Chat**, **Stories**, **Family**, **Settings**.
  - Pinned to bottom: **Account** (avatar, name, sign out menu — replaces today's
    top-right `Menu`).
- **Top bar (within content area).**
  - **Family switcher** (left): dropdown showing the current family + the user's
    *relationship role* in it (e.g. "The Müllers · Son"); switching changes the active
    family context for Chat/Stories/Family. Includes "All families" and "+ New family".
  - Global **search** (stories, people) — optional v1.
  - Quick **avatar menu** (mirrors sidebar Account).
- **Center content:** the active route, max content width ~880–960px for browse views,
  wider for chat.

### 3.2 Mobile / PWA layout

This is a PWA — mobile must be first-class. Collapse the sidebar into a **bottom tab
bar** (Chat · Stories · Family · Account) and move the family switcher into the top
bar. Chat goes full-screen. Touch targets ≥44px.

### 3.3 The "active family" model

A single global concept: **current family context**. It is shown in the top-bar
switcher and governs what Chat writes into and what Stories/Family show. An **"All
families"** mode aggregates stories across every family the user belongs to (read +
browse), useful on the Stories timeline.

---

## 4. Screen specs

### 4.1 Chat — *primary create surface* (`/chat`)

The new front door for contributing. Replaces `stories/new` (Write/Speak tabs).

**Layout:** a standard assistant chat.
- **Conversation thread** (center, scrollable): alternating user / assistant messages.
- **Composer** (bottom, sticky): multiline text input; **mic button** (voice); **+
  attach** (photos); send. Voice and photos are inline message attachments now, not a
  separate tab.
- **Left rail inside Chat (optional, desktop):** list of past conversations (like
  ChatGPT history), "New conversation" button. On mobile this is a drawer.

**Conversation flow:**
1. Assistant opens with a warm prompt: *"Tell me a memory — type it, record it, or
   drop in a photo. I'll turn it into a story for the family."*
2. User contributes (text / voice / photos). The assistant asks light follow-ups to
   enrich: *who was there, roughly when, where.*
3. When there's enough, the assistant proposes a **Story draft** rendered as a
   distinct **story card inline in the thread** (title, styled body preview, detected
   date, suggested family/families to share to).
4. User can **edit, regenerate, accept**. On accept → the story is created and enters
   the existing `processing → ready` pipeline; a link to the finished story appears.

**Key states to design:**
- Empty / first-run (suggestion chips: "A childhood memory", "About Grandma", "A trip").
- Streaming assistant response (token-by-token, stop button).
- Voice recording (waveform, timer, cancel/confirm — reuse `audio-recorder` UX).
- Transcribing / styling (inline progress; maps to `transcribe` + `style` jobs).
- Inline **story-draft card** (the most important new component — see §5.3).
- Error / retry (transcription or styling failed).
- Photo attachment chips + lightbox preview.

### 4.2 Stories (`/stories`)

Browse the family memoir. Keep the existing **view switcher** but restyle, and add a
family filter.

- **View modes (segmented control):** **Timeline** (default) and **Bubbles**. (Today
  there's also a plain "List" — recommend folding List into Timeline; see §8 Q5.)
- **Timeline:** stories grouped by year, ascending, with a clear vertical time spine;
  undated stories in a trailing group. Each entry is a **story card**.
- **Bubbles:** year bubbles sized by story count; selecting a year reveals its cards.
- **Family context:** respects the active family, or "All families" to see the merged
  timeline. Cards show a small **family chip** when viewing across families.
- **Story card** (restyled from current `StoryCard`): title, contributor + date,
  small affordance icons (🎙 voice-sourced, 🖼 N photos, 🔗 shared-to-N-families),
  2-line excerpt, status badge.

### 4.3 Story detail (`/stories/[id]`)

Read one story and drill into its origins.

**Sections (top → bottom):**
1. **Header:** title, event date (with precision), contributor, status, "shared with"
   family chips. Actions: edit, share-to-family, more.
2. **What it's about:** a short AI summary / subtitle + tags (people, place, theme) —
   a scannable abstract above the full text.
3. **Photos:** responsive gallery; click → lightbox with captions.
4. **The story:** the styled, third-person memoir body in the **reading view**
   (constrained measure, comfortable type).
5. **Dive deeper → Source material** (collapsible / secondary panel): the raw inputs
   kept for traceability —
   - original **transcript** or typed text (`bodyOriginal`),
   - the **original voice recording** (audio player),
   - the **chat conversation** this story came from (link/preview),
   - uploaded originals.
   This makes the "AI rewrote it, but here's exactly what was said" promise visible.

### 4.4 Family (`/family`) — now a **family tree**

The current family is a **tree of people**. This screen has a few tabs:

- **Tree (primary):** a visual **family tree** — people as cards/nodes (avatar, name,
  birth–death years), connected by **parent–child** and **spouse** edges. Pan/zoom on
  desktop; vertical scroll on mobile. Selecting a node opens that person's detail
  (their info + "stories about them"). Add-person and connect-people affordances
  (e.g. "+ add parent / child / partner").
  - People are not necessarily app users — you can add a deceased grandparent who never
    logs in. A node shows a subtle badge when it's linked to an actual account.
  - Roles like *son / husband* are **derived from the tree's edges**, not typed in (see
    §6.5).
- **People:** flat list of everyone in this family for quick editing (name, dates,
  photo, link-to-account, remove).
- **Access:** which **user accounts** can see/edit this family, each with an **access
  role** badge (Owner / Editor / Viewer). Owners manage access and send invites.
- **Settings:** name, description, **Writing style** (the free-text guide injected into
  the styling prompt). Switch / create / leave family.

> Two distinct ideas live here: **people in the tree** (genealogy, incl. non-users) vs
> **accounts with access** (authz). The UI should keep them clearly separate — see §6.2.

### 4.5 Account & auth

- **Account:** profile (name, avatar, email), **"My families"** list with the user's
  relationship role in each + quick switch, sign out.
- **Auth screens** (login / signup / invite-accept): restyle to the new palette;
  centered card on `surface/subtle`, brand blue primary button.

---

## 5. The AI chat feature — deep dive

### 5.1 UX requirements

- Familiar messenger pattern (we are not reinventing chat).
- First-class **voice** (record → transcribe) and **photo** attachments inline.
- Assistant is a **story-making collaborator**, not a generic chatbot: it interviews,
  enriches, then proposes a structured story draft.
- **Multiple stories per conversation** allowed (a long chat about a trip might yield
  several).
- Conversations persist and are browsable.

### 5.2 Recommended libraries

The repo is **Next.js 16 (App Router) + Mantine v9**, AI via **OpenRouter**
(`STYLING_MODEL`) and **Groq Whisper** for transcription.

- **Data/streaming layer — Vercel AI SDK** (`ai` + `@ai-sdk/react`'s `useChat`).
  Industry-standard streaming, tool-calling, message state, attachments. Pairs with
  OpenRouter via `@openrouter/ai-sdk-provider`. **Recommended.**
- **Chat UI surface — build with Mantine primitives** (decided) for visual consistency
  with the rest of the app (bubbles, composer, `ScrollArea`, `Skeleton` for streaming).
  One design system, full visual control. (Rejected alternative: `assistant-ui` —
  faster to rich features but a second styling model to reconcile with Mantine.)
- **Voice:** keep current MediaRecorder-based `components/audio-recorder.tsx`; send
  audio as a message attachment → existing **Groq Whisper** transcription job.
- **Markdown rendering** for assistant text: `react-markdown` + `remark-gfm`.
- **Family-tree rendering** (for §4.4): use a genealogy-layout library rather than
  hand-rolling layout. Options: **`relatives-tree` / `react-family-tree`** (purpose-built
  genealogy layout, handles spouses + multiple generations) — recommended for a *simple*
  tree; or **`@xyflow/react`** (React Flow) for a more general node/edge canvas if we want
  custom interactions. Style nodes with Mantine to match the system. See §8 Q10.

> Keep the **split-provider rule** from `AGENTS.md`: transcription → Groq, styling →
> OpenRouter. Anthropic has no audio API — never route transcription through it.

### 5.3 Inline story-draft card (new hero component)

The pivotal new component. Rendered inside the chat thread when the assistant proposes
a story:

- Editable **title**, **styled body preview**, detected **event date** (with precision
  picker), **people/tags**, and a **"share to" family multi-select** (defaults to the
  active family).
- Actions: **Accept & save** · **Regenerate** · **Edit** · **Discard**.
- On accept → creates the story, kicks the pipeline, and collapses into a compact
  "✓ Saved to [families] — view story" confirmation.

### 5.4 How chat maps onto the existing pipeline

The current lifecycle stays; chat is a new front-end onto it:

```
Chat message(s)  ──►  Story draft (accept)  ──►  story row (processing)
   │  (voice attach)                                  │
   └─► transcribe job (Groq) ─► style job (OpenRouter) ─► ready
```

Raw inputs (audio, photos, and now the **conversation transcript**) are kept forever
in `assets` / new chat tables for the "source material" drill-down (§4.3).

---

## 6. Data model redesign

**Decisions baked into this model:** a **Family is a sharing circle rendered as a family
tree**; tree nodes are **people** (including non-users — deceased relatives, kids
without accounts); kinship relationships are **global per person** (not per-family); a
**story can belong to several families at once**; access is governed by a **lightweight
per-family role** (§6.6); and the genealogy graph is modelled **relationally in
Postgres, not in a graph database** (§6.2a).

### 6.1 Problems with today's model

- `stories.chronicleId` is a **single non-null FK** → a story lives in exactly one
  family and **cannot be shared**.
- There is **no concept of a person or of relationships** — only `user` accounts and a
  flat `memberships` table. You can't put Grandma in a tree, or express parent/spouse
  links.
- `memberships.role` is only an **access role** (owner/editor/viewer).
- No tables for **conversations / chat messages**.
- Terminology split: code says **chronicle**; product now says **family**.

### 6.2 The model in three layers

The redesign separates three things that today's schema conflates:

1. **Genealogy layer (global, family-agnostic).** `people` are the nodes; `relationships`
   are **global** edges between people (`parent`, `spouse`). A person exists once and is
   reused everywhere. This layer doesn't know about families.
2. **Family / tree layer.** A `family` is a **named sharing circle** — a `family_members`
   set of people plus a vault of stories. The tree you render for a family = its member
   people + whichever *global* edges connect two members of that same family. One person
   in several families, with different neighbours in each, produces different roles —
   this is how "son in one, husband in another" works (see §6.5).
   - **A family name is a label, not an identity.** Two distinct families can both be
     called "Ortlepp" (your parents' family *and* the new family you start with your
     wife and child). They are separate rows; the `id` is the key. No name uniqueness.
   - **You belong to a family through a connection, not a coincidence of surname.** You
     are in your *family of origin* (your parents), in the *family you found*, and — via
     marriage — in your *spouse's family* (the Hartwigs). Each is a separate family
     circle you're a member of; the kinship graph explains *how* you connect inside each.
3. **Access layer (authz).** `memberships` map *user accounts* to families with a role
   (§6.6). Being able to *log in and read/contribute* to a family is independent of being
   a *person node* in its tree (Grandma is a node but may never log in; a son-in-law may
   be granted contributor access to his wife's family without anyone editing the tree).

> **Key distinction: `user` vs `person`.** `user` = an authentication account (better-auth).
> `person` = a node in the genealogy. A person *optionally links to* a user
> (`person.userId`), but most people (ancestors, children) have no account.

### 6.2a Why Postgres, not a graph database

The kinship layer *is* a graph, so a graph DB (Neo4j, Memgraph) is a fair question. The
decision is **stay on PostgreSQL** and model the graph as an **edge table**
(`relationships` = adjacency list), for these reasons:

- **Scale is tiny.** A family memoir spans tens — at most low hundreds — of people. This
  is nowhere near the scale where a native graph engine earns its keep.
- **The queries are shallow.** Rendering a family tree needs only the edges among one
  family's members; "is X related to Y / how" is a handful of hops. Postgres handles
  this with `WITH RECURSIVE` CTEs, or by loading a family's edges and walking them in
  memory (cheap at this size).
- **One source of truth.** Stories, auth (better-auth), and the job queue (pg-boss) are
  all already in Postgres and transactional together. A second datastore would split the
  truth, complicate backups, and add a service to run on the single Hetzner VPS + Coolify.
- **Reversible.** It's an edge table; if deep graph queries ever become a real need we
  revisit Postgres `ltree`/recursive CTEs first, and a dedicated graph DB only if that
  fails. Nothing here paints us into a corner.

**Decision: relational edge model in Postgres.** Revisit only if genealogy depth/scale
ever demands it (unlikely for this product).

### 6.3 Entities (ERD)

```
user ──1:0..1── person ──< relationship >── person        (relationships are GLOBAL)
  │                 │
  │                 └──< family_member >── family
  │                                          │
  └──< membership >──────────────────────────┤   (USER access: owner/editor/viewer)
                                             └──< invitation

story ──< story_family >── family            (a story shared to MANY families)
  │   └──< story_person >── person            (who the story is about)
  ├──< asset            (audio / photo, the finished artifact)
  └──? conversation                           (the chat it came from)

conversation ──< message ──< message_attachment   (in-chat voice/photo uploads)
```

### 6.4 Tables, one by one

**`people`** (NEW — genealogy node).
- `id uuid pk`, `displayName text`, `givenName text?`, `familyName text?`
- `userId text? → user.id` (nullable; links a node to an app account)
- `bornOn timestamp?`, `bornPrecision`, `diedOn timestamp?`, `diedPrecision`
- `avatarS3Key text?`, `notes text?`, `createdBy → user.id`, timestamps
- index on `userId`.

**`relationships`** (NEW — **global** edges between people).
- `id uuid pk`, `type enum('parent','spouse')`
- `personFromId → people.id`, `personToId → people.id`
- Convention: for `parent`, `from` = parent, `to` = child. For `spouse` (symmetric),
  store one row with a canonical ordering (smaller id as `from`) to dedupe.
- `unique(type, personFromId, personToId)`; indexes on both person columns.
- Parent + spouse edges are enough to render a simple tree and to derive any role
  (child/parent/sibling-via-shared-parent/partner). No per-family scoping.

**`families`** (rename of `chronicles` — a named tree).
- Keep `name`, `description`, `styleGuide` (relabel UI → "Writing style"), `createdBy`,
  timestamps. Pure rename of the table + columns retained.

**`family_members`** (NEW — which people are nodes in this tree).
- `id`, `familyId → families.id`, `personId → people.id`
- `roleLabel text?` — optional human label for display, normally **derived** from the
  tree (§6.5) but overridable ("Matriarch").
- `unique(familyId, personId)`; index on `familyId`.

**`memberships`** (KEEP — repurposed for **access only**; see §6.6).
- `id`, `familyId`, `userId`, `accessRole enum('owner','contributor','viewer')` (rename
  of today's `role`; `editor` → `contributor`), timestamps. `unique(familyId, userId)`.
- No relationship label here anymore — that lives in the genealogy layer.
- This is the row the Hartwigs create to "let you add stories": a `(user=you,
  family=Hartwig, role=contributor)` membership.

**`invitations`** (KEEP). Restyle; an invite grants a `membership` and may pre-create /
link a `person` + `family_member`.

**`stories`** — decouple from a single family.
- **Remove `chronicleId`.** A story is standalone, owned by `submittedBy`.
- add `conversationId uuid?` → the chat it came from.
- add `summary text?` → the "what it's about" abstract (§4.3).
- keep `bodyOriginal`, `bodyStyled`, `status`, `eventDate(+precision)`, `eventId`.
- `inputType`: see §8 Q7.

**`story_families`** (NEW join — **the core "belongs to several families" mechanism**).
- `id`, `storyId → stories.id`, `familyId → families.id`, `sharedBy → user.id`,
  `sharedAt`, `unique(storyId, familyId)`.
- A story appears in **every** family it's linked to. ≥1 link required at creation.

**`story_people`** (NEW — who/what the story is about).
- `id`, `storyId`, `personId`, `unique(storyId, personId)`.
- Drives "all stories about Grandma" and **auto-suggesting which families to share to**
  (the families those tagged people belong to).

**`conversations`** (NEW). `id`, `familyId?` (context started in), `userId`, `title`,
timestamps.

**`messages`** (NEW). `id`, `conversationId`, `role enum('user','assistant','system','tool')`,
`content text`, `createdAt`. Index by conversation.

**`message_attachments`** (NEW). `id`, `messageId`, `kind audio|photo`, `s3Key`,
`mimeType`, … (mirrors `assets`). Keep `assets` bound to the finished **story**; on
accept, copy/link the relevant attachments into the story's `assets`. (See §8 Q8.)

**`events`** — currently `chronicle`-scoped. Make `familyId` nullable / global since
stories are now cross-family; keep as optional grouping. (Low priority.)

### 6.5 Worked example — the Ortlepp / Hartwig case

You (**C**) are one global `person`. Your wife is **W**; your parents **Mp/Fp**; your
child **K**; your wife's parents **Mh/Fh**. Global kinship edges: `C child-of Mp/Fp`,
`C spouse-of W`, `K child-of C` & `K child-of W`, `W child-of Mh/Fh`.

Three separate `families` (note two share the name "Ortlepp"):

- **"Ortlepp" — family of origin.** Members `{C, Mp, Fp, …}`. The `C child-of Mp/Fp`
  edges are present → C renders as a **son**.
- **"Ortlepp" — the family you founded.** Members `{C, W, K}`. The `C spouse-of W` and
  `K child-of C/W` edges are present → C renders as a **parent/husband**. (Same surname,
  different family row.)
- **"Hartwig" — your wife's family.** Members `{W, Mh, Fh, C, …}`. Among these, the
  `W child-of Mh/Fh` and `C spouse-of W` edges are present → W is a **daughter**, and C
  appears connected via the spouse edge — a **son-in-law / husband-of-member**. C's
  `child-of Mp/Fp` edge is *skipped here* because Mp/Fp aren't members of the Hartwig
  circle.

So a person's role is **computed per family from membership + the global edges**, with
no per-family role column (though `family_members.roleLabel` can override for display).
The same surname appearing twice is fine — families are identified by `id`, not name.

### 6.6 Permissions (lightweight v1)

Access is governed by the **per-family `memberships.accessRole`**. Three roles, simple
matrix:

| Action | viewer | contributor | owner |
|---|:--:|:--:|:--:|
| Read this family's stories & tree | ✓ | ✓ | ✓ |
| Add a story to this family / tag people | | ✓ | ✓ |
| Edit own stories | | ✓ | ✓ |
| Share an existing story **into** this family | | ✓ | ✓ |
| Add/connect people in the tree | | ✓ | ✓ |
| Edit others' stories, manage members, invites, settings | | | ✓ |
| Delete the family | | | ✓ |

Rules that follow:

- **"See stories from families I'm connected to"** = in v1, *connected* means you hold a
  `membership` (any role) in that family. All access is **explicit**. So you see Ortlepp
  (owner), the family you founded (owner), and Hartwig **only because** the Hartwigs
  added you (even as `viewer`).
- **"Hartwigs let me add stories"** = they grant you `contributor` on the Hartwig family.
- **Cross-family sharing is target-gated.** To share a story into family X you need
  `contributor`+ **in X**. A story stays readable in *every* family it's linked to via
  `story_families`, to that family's members.
- **Story authorship** stays with `stories.submittedBy` regardless of how many families
  it's shared into.

**Deliberately deferred (v2+), noted so we don't design them out:**

- **Implicit "kinship" access** — auto-granting *view* to someone whose person node is
  closely connected (e.g. spouse/child/parent of a member) without an explicit membership.
  Powerful but needs careful traversal + privacy rules; v1 keeps access explicit.
- **Per-story visibility** (a private story not shared to the whole circle), finer roles,
  and request-to-join / approval flows.

### 6.7 Migration notes

- Rename `chronicles` → `families`; rename `memberships.role` → `access_role` and remap
  the enum value `editor` → `contributor`.
- **Backfill the genealogy layer:** create one `person` per existing `user` (link via
  `person.userId`); create a `family_member` for each existing `membership`. Existing
  trees start flat (no edges) — relationships get added in-app afterward.
- **Backfill `story_families`** with one row per existing `stories.chronicleId`, then
  drop the column.
- New tables: `people`, `relationships`, `family_members`, `story_families`,
  `story_people`, `conversations`, `messages`, `message_attachments`.
- Drizzle: edit `db/schema.ts` → `db:generate` → `db:migrate`. Then refactor every
  `chronicleId`/`chronicle` reference across `app/`, `lib/`, `worker/`.
- This is a **breaking schema change**; the app is live in production
  (`family.clepp.de`) — coordinate a migration window and read `INFRASTRUCTURE.md`
  before deploying.

---

## 7. Component inventory for Claude Design

Concrete components to design in the new blue/white/black system:

- **App frame:** left sidebar (expanded + collapsed rail), top bar, mobile bottom tab
  bar.
- **Family switcher** dropdown (shows relationship role per family; All families; new).
- **Chat:** conversation thread, user bubble, assistant bubble (with streaming +
  markdown), composer (text + mic + attach + send), voice-recording state, photo chips
  + lightbox, conversation history rail/drawer, suggestion chips, **inline story-draft
  card**.
- **Stories:** view switcher, timeline (year spine + cards), bubbles view, **story
  card**, cross-family chip, empty states.
- **Story detail:** header, "what it's about" abstract + tags, photo gallery +
  lightbox, reading view, **source-material drill-down** (transcript, audio player,
  source conversation).
- **Family tree:** the **tree canvas** (pan/zoom), **person node** card (avatar, name,
  birth–death years, account-linked badge), parent–child + spouse **edges**, add/connect
  affordances ("+ add parent / child / partner"), **person detail** panel (info +
  "stories about them"), people list row, empty tree state.
- **Family access & settings:** access row (account + access-role badge), invite modal,
  settings form (name / description / writing-style).
- **Account & auth:** account page, "my families" list, login/signup/invite cards.
- **Primitives:** buttons (primary blue / secondary / ghost / danger), inputs, badges
  (status + role), avatars, tabs/segmented control, toasts, skeletons, dialogs.
- **States everywhere:** empty, loading/streaming, error/retry, processing.

---

## 8. Open questions / decisions

**Resolved (locked in):**

1. ✅ **Naming** — rename the entity `Chronicle` → `Family` everywhere. App stays named
   *Family Chronicle*; a "family" is the group, the memoir is its collected stories.
2. ✅ **Dark mode** — **light only** for v1. Black = text/structure on light surfaces;
   no dark theme in scope.
3. ✅ **Reading typography** — **fully modern sans** (Inter) everywhere, including the
   memoir reading view. No serif.
4. ✅ **Chat UI build** — **Mantine-native** components + Vercel AI SDK. One design
   system; `assistant-ui` rejected.
5. ✅ **Family = sharing circle + tree** — nodes are **people** (incl. non-users),
   kinship edges are **global per person**, roles are **derived from the tree**. Family
   names are labels (not unique). See §6.2.
6. ✅ **Graph database?** No — model the kinship graph **relationally in Postgres**
   (edge table + recursive CTEs). Revisit only if depth/scale ever demands it. See §6.2a.
7. ✅ **Permissions (v1)** — per-family role `owner / contributor / viewer`; access is
   **explicit membership** (no implicit kinship access yet); cross-family sharing is
   **target-gated** (contributor+ in the destination). See §6.6.
8. ✅ **Access roles renamed** — `editor` → `contributor` (matches "can add stories").

**Still open:**

9. **Stories views.** Fold the current plain **List** into **Timeline**, keeping just
   Timeline + Bubbles? **→ confirm.**
10. **`inputType`.** Add `chat` to the enum, or derive input type from attachments and
    leave it implicit? **→ confirm.**
11. **Chat attachments storage.** Separate `message_attachments` table vs reuse
    `assets` directly for in-chat uploads. **→ confirm.**
12. **Tree library.** `relatives-tree`/`react-family-tree` (purpose-built, simple,
    recommended) vs `@xyflow/react` (general canvas, more custom work). **→ confirm.**
13. **Relationship depth.** Is `parent` + `spouse` enough (siblings/grandparents derive
    from these), or do we need explicit sibling/other edge types? *Recommended: just
    parent + spouse for "simple."* **→ confirm.**

---

## 9. Suggested delivery phases

1. **Design system & shell.** New blue/white/black theme (`app/theme.ts`), typography,
   sidebar + top-bar app frame, family switcher, mobile bottom nav. *(No data changes.)*
2. **Data model migration.** `families` rename; genealogy layer (`people`,
   `relationships`, `family_members`); access-only `memberships`; `story_families` +
   `story_people` sharing; conversation/message tables. Backfill (person per user,
   story_families per old chronicleId), Drizzle migrate, refactor references.
   *(Breaking — coordinate prod.)*
3. **Stories & detail redesign.** Restyled timeline/bubbles, new story card,
   story-detail with "what it's about" + source-material drill-down + cross-family
   sharing UI.
4. **AI chat.** Chat surface (Vercel AI SDK + Mantine), voice/photo inline,
   conversation persistence, **inline story-draft card** (with people-tagging +
   share-to-families), wire accept → existing transcribe/style pipeline. Retire the
   Write/Speak composer.
5. **Family tree & management.** Tree visualization (relatives-tree), person nodes +
   add/connect people, person detail with "stories about them", access/invites UI,
   account "my families", empty/loading/error states.

---

*Hand sections 1–5 + 7 to Claude Design for the visual work; sections 6, 8–9 guide the
implementation that follows.*
