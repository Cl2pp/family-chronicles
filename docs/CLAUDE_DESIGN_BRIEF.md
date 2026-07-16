# Familienwerk — Claude Design Brief (wireframe revision)

> **Status: delivered.** The wireframes were produced from this brief
> (`Familienwerk Wireframes.dc.html`). This file is now **reference** for what was
> asked of design. Roadmap & current step: `~/.claude/plans/curious-gliding-dijkstra.md`.
> Full spec + data model: `docs/REDESIGN_SPEC.md`.
>
> **Use this to revise the existing wireframes.** It's the design-facing slice of the
> full spec (`docs/REDESIGN_SPEC.md`, §1–5/7). Engineering details (data model) live
> there and are *not* needed here.
>
> **Biggest change to apply:** the **Family tab is no longer a member list — it is a
> family tree.** See §5. All other screens get the new blue/white/black look and the
> sidebar layout.

---

## 0. What's changing at a glance

1. **New visual language:** warm terracotta → **modern blue / white / black**, **light
   mode only**, **fully sans (Inter)** everywhere (no serif).
2. **New layout:** persistent **left sidebar** + center content (top-bar with a
   **family switcher**); mobile collapses to a **bottom tab bar**.
3. **Create flow is now a chat:** the old *Write / Speak* composer is replaced by a
   conversational **Chat** screen that produces stories.
4. **Family tab → family tree:** a visual tree of **people** (parent / spouse links),
   not a flat list of members.

---

## 1. Visual language (design tokens)

**Primary — brand blue** (`#2563EB` family):
`50 #EFF4FF · 100 #DBE6FE · 200 #BFD3FE · 300 #93B4FD · 400 #609AFA · 500 #3B82F6 ·`
`600 #2563EB (primary) · 700 #1D4ED8 (hover) · 800 #1E40AF · 900 #1E3A8A`

**Neutrals (white → black, cool slate):**
`surface #FFFFFF · app/sidebar bg #F8FAFC · muted/well #F1F5F9 · border #E2E8F0 ·`
`border-strong #CBD5E1 · text-secondary #64748B · text-primary #0F172A · ink #020617`

**Semantic:** success `#16A34A` · warning `#D97706` · error `#DC2626` · info = brand.
**Story status:** draft = gray · processing = brand blue (animated) · ready = green ·
failed = red.

**Type:** Inter (system sans fallback). `display 32/40 · h1 24/32 · h2 20/28 ·
h3 16/24 · body 15/24 · small 13/20 · caption 12/16`; weights 400/500/600. Reading view
uses body at ~18/1.7, ~68ch max measure.

**Shape & depth:** radius `sm 8 / md 12 (default) / lg 16 / full`. Prefer **hairline
borders + subtle shadow** over heavy shadows. Motion 120–180ms ease-out; respect
reduced-motion. Icons: **Tabler**, 1.5–2px stroke.

---

## 2. App layout

**Desktop**
```
┌───────────┬──────────────────────────────────────────────┐
│  SIDEBAR  │  [Family switcher ▾]            [search] [👤] │
│ (~240px,  ├──────────────────────────────────────────────┤
│ collapsible│                                               │
│ to 64px)  │              CENTER CONTENT                    │
│           │            (active page, ~880–960px)           │
│ ◈ Brand   │                                                │
│ 💬 Chat   │                                                │
│ 📖 Stories│                                                │
│ 👪 Family │                                                │
│ ⚙ Settings│                                                │
│ ───────── │                                                │
│ 👤 Account│                                                │
└───────────┴──────────────────────────────────────────────┘
```
- **Sidebar:** brand top; nav items (icon+label) Chat / Stories / Family / Settings;
  **Account pinned bottom** (avatar + name + sign-out menu).
- **Top bar:** **family switcher** (current family + the user's role in it, e.g.
  "The Müllers · Son"; includes *All families* and *+ New family*); optional search;
  avatar menu.
- **Mobile / PWA:** sidebar → **bottom tab bar** (Chat · Stories · Family · Account);
  switcher moves into the top bar; chat goes full-screen; touch targets ≥44px.

---

## 3. Chat — primary create surface (`/chat`)

Standard assistant chat that turns a memory into a story.
- **Thread** (center): alternating user / assistant bubbles; assistant streams
  token-by-token; markdown supported.
- **Composer** (sticky bottom): multiline input, **mic** (voice), **+ attach** (photos),
  send. Voice & photos are inline attachments (no separate tab).
- **History rail** (desktop, optional): past conversations + "New conversation"; drawer
  on mobile.
- **Inline story-draft card** *(hero component)*: when the assistant proposes a story,
  render a distinct card in the thread with editable **title**, **styled body preview**,
  detected **date** (precision picker), **people tags**, and a **"share to families"
  multi-select** (defaults to active family). Actions: **Accept & save · Regenerate ·
  Edit · Discard**. On accept → collapses to "✓ Saved to [families] — view story".

**States to draw:** first-run empty (suggestion chips: "A childhood memory", "About
Grandma", "A trip"); streaming (stop button); voice recording (waveform + timer +
cancel/confirm); transcribing/styling progress; story-draft card; error/retry; photo
chips + lightbox.

---

## 4. Stories (`/stories`) & Story detail

**Stories list:** segmented control **Timeline (default) · Bubbles**; respects the
active family or **All families** (cross-family cards show a small **family chip**).
- **Timeline:** stories grouped by year (ascending) along a vertical time spine; undated
  group trails. **Bubbles:** year bubbles sized by count → selecting reveals cards.
- **Story card:** title, contributor + date, affordance icons (🎙 voice-sourced,
  🖼 N photos, 🔗 shared-to-N-families), 2-line excerpt, status badge.

**Story detail (`/stories/[id]`):** header (title, date, contributor, status, "shared
with" family chips, actions) → **"What it's about"** abstract + tags → **photo gallery**
(lightbox) → **the story** (reading view) → **Dive deeper → Source material**
(collapsible: original transcript / typed text, **audio player**, link to the source
**conversation**).

---

## 5. ⭐ Family tab — REVISE: member list → **family tree**

> This is the screen to change most. The old wireframe (a flat list of members with
> role badges) is **replaced**. A Family is now a **tree of people**.

Tabbed screen: **Tree · People · Access · Settings**.

### 5.1 Tree (primary tab)
A visual **family tree** on a pan/zoom canvas (vertical scroll on mobile).
```
                 ┌───────────────┐   ═══   ┌───────────────┐
                 │  ◐ Hans M.    │═════════│  ◑ Erika M.   │      ═══ = spouse
                 │  1948–2019    │         │  1951–        │      ─┬─ = parent→child
                 └───────┬───────┘         └───────┬───────┘
                         └────────────┬────────────┘
              ┌────────────┐    ┌─────┴──────┐
              │ ◐ Lars M.  │════│ ◑ You       │  ← "you" node subtly highlighted
              │ 1978–      │    │ (Son here)  │
              └────────────┘    └─────────────┘
```
- **Person node card:** circular avatar (initials if none), name, birth–death years,
  and a **small badge when linked to an app account** (most nodes are *not* accounts —
  deceased relatives, kids, etc. are fine).
- **Edges:** **parent→child** (vertical connector) and **spouse** (horizontal double
  line). Keep it readable; this is a *simple* tree.
- **The signed-in user's node** is subtly highlighted; their **role is derived from the
  tree** (e.g. shown as "Son here") — it is **not** a field anyone types.
- **Add / connect affordances:** selecting a node reveals **"+ add parent / + add child /
  + add partner"**; a top-level **"+ Add person"**. Adding a person asks for name, dates
  (optional, with precision), photo (optional), and optionally **link to an account**.
- **Select a node → Person detail panel** (side panel / drawer): the person's info plus
  **"Stories about them"** (the stories tagged with this person).
- **Empty tree state:** a single "You" node with a clear "Add your first relative" CTA.

### 5.2 People
Flat list of everyone in this family for fast editing — row = avatar, name, years,
account-linked badge, edit / remove. Good for bulk cleanup the tree canvas is clumsy for.

### 5.3 Access (authz — keep separate from the tree)
Which **app accounts** can see/edit this family. Row = account avatar + name + **access
role badge (Owner / Editor / Viewer)**. Owners manage roles, remove access, and **invite**
(email invite modal; an invite may pre-link the new account to a person node).

> Keep **people in the tree** (genealogy, includes non-users) visually distinct from
> **accounts with access** (authz). They are different lists on purpose.

### 5.4 Settings
Family **name**, **description**, **Writing style** (free-text guide that shapes the AI's
prose). Switch / create / leave family.

---

## 6. Auth & account
- **Account:** profile (name, avatar, email), **"My families"** with the user's role in
  each + quick switch, sign out.
- **Auth (login / signup / invite-accept):** centered card on `#F8FAFC`, brand-blue
  primary button, new palette + Inter.

---

## 7. Component checklist for this revision

Restyle/redraw in the new system, and add the new ones (★):
- App frame: sidebar (expanded + 64px rail), top bar, mobile bottom tabs, **family
  switcher ★**.
- Chat ★: thread, user/assistant bubble (streaming + markdown), composer (text + mic +
  attach), voice-recording state, photo chips + lightbox, history rail, suggestion chips,
  **inline story-draft card ★**.
- Stories: view switcher, timeline (year spine), bubbles, story card (+ cross-family
  chip), empty states.
- Story detail: header + "shared with" chips, "what it's about" + tags, photo gallery +
  lightbox, reading view, **source-material drill-down ★**.
- **Family tree ★:** tree canvas (pan/zoom), **person node ★**, parent/spouse **edges ★**,
  add/connect affordances, **person detail panel ★** (with "stories about them"), people
  list row, empty tree state.
- Family access & settings: access row (account + role badge), invite modal, settings
  form.
- Account & auth: account page, "my families" list, login/signup/invite cards.
- Primitives: buttons (primary blue / secondary / ghost / danger), inputs, badges
  (status + role), avatars, segmented control, toasts, skeletons, dialogs.
- **Every screen needs:** empty, loading/streaming, error/retry, and processing states.
