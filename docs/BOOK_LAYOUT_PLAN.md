# Book Layout v2 — Designed Pages, Live HTML Preview, AI Art Direction

The v1 renderer (shipped in PR #43) typesets books mechanically: full-bleed cover, one
photo per figure, all photos stacked after the chapter text. This plan upgrades the book
to *designed* pages — multi-photo compositions, text wrapping around images, a proper
cover — and restructures the pipeline so that layouts are **data**, previews are **live
HTML**, and an **AI design pass** (or the chat agent) can art-direct the book.

---

## 1. The core architectural change: layout is data, not code

Today the layout lives as hard-coded HTML generation in `lib/book-layout.ts` — the only
way to change how a page looks is to change code. The v2 source of truth is a **layout
plan**: a JSON document stored on the book (`books.layout_plan jsonb`) that says *what
goes where*, rendered by a deterministic template. Sketch:

```jsonc
{
  "theme": "classic",            // CSS theme (see §5)
  "cover": { "style": "framed", "heroAssetId": "…" },
  "chapters": [
    {
      "storyId": "…",
      "blocks": [                // reading order; the renderer flows them
        { "type": "paragraphs", "from": 0, "to": 2 },
        { "type": "figure", "assetId": "a1", "size": "float-right" },
        { "type": "paragraphs", "from": 3, "to": 5 },
        { "type": "photo-row", "assetIds": ["a2", "a3"] },          // two-up
        { "type": "photo-grid", "assetIds": ["a4", "a5", "a6"] },   // 1 large + 2 small
        { "type": "photo-page", "assetId": "a7" }                   // own full page
      ]
    }
  ]
}
```

Why this shape wins:

- **Editing is a data operation.** The builder UI, the chat agent, and an AI design pass
  all edit the same JSON — no HTML parsing, no code changes. "Make the wedding photo full
  page" = one array mutation.
- **Rendering stays deterministic and testable.** One template maps any valid plan to
  HTML; a zod schema validates plans no matter who produced them (heuristics, AI, user).
- **Custom designs become themes.** The plan is design-agnostic; a theme is a CSS file
  (fonts, colors, margins, figure styling). New look = new stylesheet, zero pipeline work.
- **Re-renders are stable.** Same plan → same book. The AI proposes once; we don't
  re-roll the dice on every render.

## 2. Start in HTML, PDF only at the end (the format question)

We already generate HTML — v1 just prints it to PDF immediately and shows the PDF. v2
flips that: **the book lives as HTML until the moment print-grade output is needed.**

```
book data + layout plan ──► renderBookHtml(plan, theme)
        │
        ├── builder preview:  same HTML served to the browser, paginated
        │                     client-side with Paged.js → instant, interactive
        │
        └── order time:       server Chromium prints the same HTML → print.pdf
                              (bleed, 300dpi images, padded pages) → Gelato
```

What this buys us:

- **Instant iteration.** Today every tweak costs a full worker render (Chromium + photo
  processing, ~15s+) before the user sees anything. With an HTML preview, changing the
  title, reordering chapters, or moving a photo re-renders in the browser in milliseconds.
  The "Update preview" button disappears for most edits.
- **Editing hooks.** HTML pages can be interactive: click a figure to cycle its size,
  drag a photo to another block — things a PDF iframe can never do. (Interactive editing
  is a later phase, but only this architecture makes it possible at all.)
- **Custom designs stay cheap** — themes are stylesheets shared by preview and print.

**[Paged.js](https://github.com/pagedjs/pagedjs)** does the client-side pagination: it
polyfills CSS Paged Media in the browser, chunking the HTML into real page boxes — the
user leafs through actual pages, with the same `@page` geometry the printer uses. It's a
mature community project used by real publishing workflows (footnotes, running heads,
cross-page refs). Caveats, honestly held:

- The user's browser (Safari/iOS!) isn't the print engine; minor pagination drift vs.
  server Chromium is possible. Mitigation: the **order screen keeps showing the true
  server-rendered PDF** as the binding artifact — HTML preview is for iteration, the PDF
  for confirmation. Page counts/quotes always come from the server render.
- Paged.js processes the whole book at once; for very photo-heavy books we lazy-load
  images (thumbnails in preview) to keep it snappy.

**Alternatives researched, and why not:**

| Option | Verdict |
|---|---|
| Direct-PDF libs (`pdf-lib`, pdfkit, react-pdf) | Hand-placing every box; no text flow around figures; we'd rebuild a layout engine ourselves. Keep `pdf-lib` only for page padding. |
| Typst | Beautiful typesetting, fast, even compiles to WASM — but a second template language for every design tweak, no interactive DOM preview, and image-heavy grid layouts are its weak spot. Revisit only if Chromium print quality disappoints. |
| WeasyPrint / Prince / PDFreactor | Python stack / commercial licenses; no advantage over Chromium we'd pay for. |
| Chromium print (status quo) | Keeps working as the **print** back-end. Bonus discovered: Chromium ≥131 supports [`@page` margin boxes](https://developer.chrome.com/blog/print-margins) — real **page numbers** (`counter(page)`) and running headers land for free, both in print and in Paged.js. |

So: **no engine switch.** HTML/CSS stays the single design language; we add Paged.js in
the browser for live preview and keep server Chromium for the deliverable.

## 3. Cover redesign (quick win, independent of everything else)

Replace the full-bleed cover with a classic framed composition:

```
┌────────────────────────┐
│      (light beige)     │
│   ┌───────────────┐    │   • background: warm paper tone (e.g. #f4efe6)
│   │               │    │   • photo: portrait-framed, ~55–65% of page width,
│   │  cover photo  │    │     centered, thin border + subtle shadow,
│   │               │    │     object-fit: cover with 4:5-ish crop
│   └───────────────┘    │   • title: black serif, centered BELOW the photo
│                        │   • subtitle + chronicle name smaller, muted
│    Die Familie Demo    │   • print variant: beige extends into the bleed
│      1954 – 1972       │
└────────────────────────┘
```

Ship this first — it's a `lib/book-layout.ts`-only change and immediately visible. The
cover style becomes the first `cover.style` value (`framed`); `full-bleed` (v1 look)
stays available as a second option.

## 4. The layout vocabulary (what the renderer can do)

A small, composable set of block types — enough variety for good pages, small enough to
validate and for an AI to reason about:

| Block | Use | CSS mechanism |
|---|---|---|
| `paragraphs` | a run of story text | normal flow, justified |
| `figure` `size: full` | one landscape hero | full column width |
| `figure` `size: float-left/right` | portrait beside text | `float` + shape margins; only chosen when ≥ ~120 words of text remain to wrap |
| `photo-row` | 2 images side by side | grid `1fr 1fr`, heights equalized via `aspect-ratio` + `object-fit: cover` |
| `photo-grid` | 3–4 images | grid: one dominant + 2 small, or 2×2; dominant slot picked by aspect ratio |
| `photo-page` | one standout image on its own page | `break-before: page`, generous margins, caption beneath |
| `quote` (later) | pull-quote from the story | styled aside |

Rules the renderer enforces regardless of who authored the plan: figures never break
across pages (`break-inside: avoid`), captions stay with their image, chapters start on a
right-hand page, every image keeps its aspect ratio (crops only via `object-fit: cover`
inside a slot, never distortion).

`assets.width/height` already exist; the layouter needs them, so the render job
backfills missing dimensions via sharp on first use.

## 5. Who writes the layout plan

Three producers, one schema, strict priority:

1. **Deterministic auto-layouter** (`lib/book-autolayout.ts`) — always runs, zero cost,
   good defaults. Heuristics: pair portraits into `photo-row`s; landscape → `full`
   figure; 3+ leftover images → `photo-grid`; exactly one striking image (largest
   resolution) in a photo-heavy chapter → `photo-page`; intersperse image blocks after
   every 2–4 paragraphs instead of appending at the end; float a portrait only when
   enough text remains.
2. **AI design pass** (optional, per book): one model call (existing OpenRouter client)
   gets each chapter's paragraphs, image metadata (id, aspect ratio, caption) **and the
   photo thumbnails as vision input**, plus the block-type schema; it returns a layout
   plan, validated with zod exactly like agent tool args. The vision part is what
   heuristics can't do: pick the emotional hero image for the `photo-page`, keep a
   portrait's faces uncropped, order photos to follow the narrative. Invalid or failed
   output → fall back to (1) silently. Cost: one call per render-worthy change, same
   model as story styling.
3. **Explicit edits** — the builder UI and the chat agent (extended `update_book_layout`
   tool with targeted ops: `set_cover_style`, `set_figure_size`, `promote_to_photo_page`,
   `regenerate_layout(styleHint)`). Edits mark the plan `source: 'edited'`; subsequent
   auto/AI regeneration requires explicit consent so user intent is never overwritten.

`books` grows: `layout_plan jsonb`, `layout_source text` (`auto | ai | edited`),
`layout_stale boolean` (content changed since the plan was made → builder offers
"refresh layout").

## 6. Delivery phases

1. **Cover + vocabulary + auto-layouter** — new cover, block renderer, heuristic plans,
   page numbers via `@page` margin boxes. Still PDF-preview UX. *Every book immediately
   looks substantially better; no schema change beyond `layout_plan`.*
2. **Live HTML preview** — builder's preview pane becomes Paged.js-paginated HTML fed by
   the same template (thumbnail-resolution images); server PDF render moves to the order
   screen ("final proof") + stays available on demand. The 4s status polling loop mostly
   disappears.
3. **AI design pass** — opt-in "Design my book" button + agent tool `regenerate_layout`;
   vision input; zod-validated output; heuristic fallback.
4. **Fine editing** — per-figure controls in the builder (size cycle, move up/down),
   agent ops for targeted tweaks, second theme (e.g. "modern" sans/large-photo look).

Phases 1–2 are pure engineering; 3 adds one prompt + validation; each ships alone.

## 7. Open questions

1. **Theme direction** for the second theme — classic serif (current) is the default;
   what should "modern" look like? (Can be decided at phase 4.)
2. **AI pass default**: run automatically on first render of every book, or behind a
   "Design my book" button? (Plan assumes button — predictable costs, user stays in
   control.)
3. **Hero-crop safety**: object-fit crops mechanically; do we want face-aware cropping
   (sharp + a small detector) before photo books with people get tight crops? (Later
   phase candidate.)
4. **Preview fidelity bar**: is "HTML preview for iteration + server PDF as binding
   proof at order time" acceptable, or must the iteration preview itself be
   pixel-identical to print? (Plan assumes the former.)
