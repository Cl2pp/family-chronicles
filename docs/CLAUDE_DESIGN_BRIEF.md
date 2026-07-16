# Familienwerk — Claude Design Brief (wireframe revision)

> **⚠️ Superseded (2026-07) — visual language rebranded.** The blue/Inter identity
> described in §0–1 was replaced by the **Familienwerk green** system: Werk Green
> `#12C24A` as the single accent, **Space Grotesk** (headings/wordmark) + **Outfit**
> (body), pill buttons, and the "Familienstimmen" voice-bars logo. §1 below is
> updated to the new tokens; the live source of truth is `app/theme.ts` +
> `app/globals.css` (`--fw-*`). The app **structure/layout** in §2–7 is still accurate.
>
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
> family tree.** See §5. All other screens get the new green/paper/ink look and the
> sidebar layout.

---

## 0. What's changing at a glance

1. **New visual language:** warm terracotta → **Familienwerk green / paper / ink**, **light
   mode only**, **fully sans** everywhere (Space Grotesk headings + Outfit body; no serif).
2. **New layout:** persistent **left sidebar** + center content (top-bar with a
   **family switcher**); mobile collapses to a **bottom tab bar**.
3. **Create flow is now a chat:** the old *Write / Speak* composer is replaced by a
   conversational **Chat** screen that produces stories.
4. **Family tab → family tree:** a visual tree of **people** (parent / spouse links),
   not a flat list of members.

---

## 1. Visual language (design tokens)

**Primary — Werk Green** (green is the *single* accent: primary action, active nav,
tags, links, record indicator):
`0 #E9FAE5 (tint) · 1 #C6F5D5 · 2 #97ECB2 · 3 #5FE08C · 4 #33D26E · 5 #1CC957 ·`
`6 #12C24A (primary) · 7 #0FA03D (hover) · 8 #0C8038 (deep — links/green text) · 9 #0A6B2E`
Plus **Lime `#7BE84B`** — highlights on dark surfaces only (not in the ramp).

**Neutrals (warm ink-green ramp, paper → ink):**
`paper/app-bg #FBFCFB · shade/panel #F3F6F4 · border #E6EBE8 · #CBD4CF · #9BA8A1 ·`
`muted-text #6E7C75 · body-text #4A554F · #333D38 · #232E28 · ink #17211C`

**Semantic:** success = green (`#12C24A`/`#0C8038`) · warning `#D97706` · error `#DC2626`.
**Story status:** draft = gray · processing = green (animated) · ready = green · failed = red.

**Type:** **Space Grotesk** — wordmark, headings, titles (weight 600, ~−2% tracking).
**Outfit** — body & UI (400/500, friendly-geometric, legible for older readers; UI ≥13px,
body 14–16px). No serif. Reading view uses body at ~18/1.7, ~68ch max measure.

**Shape & depth:** radius `card 14–16 · button 999 (pill) · icon 25% · sm 8 / md 12`.
Prefer **hairline borders + subtle shadow**. Motion 120–180ms ease-out; respect
reduced-motion. Icons: **Tabler**, 1.5–2px stroke (in-app); the landing uses bespoke
green SVGs.

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
- **Auth (login / signup / invite-accept):** centered card on paper `#FBFCFB`, green
  pill primary button, new palette + Space Grotesk/Outfit.

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
- Primitives: buttons (primary green pill / secondary / ghost / danger), inputs, badges
  (status + role), avatars, segmented control, toasts, skeletons, dialogs.
- **Every screen needs:** empty, loading/streaming, error/retry, and processing states.
