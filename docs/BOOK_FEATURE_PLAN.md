# Book Creation & Ordering — Implementation Plan

Turn a chronicle's stories into a printed hardcover book: the user picks stories, the app
typesets them (photos included) into a book, shows a low-res PDF preview, lets the user refine
it — by hand or by prompting the AI agent — and ends on an **"Order at €X"** screen. For v1 the
order does **not** hit a payment or print API: it records the order and emails the admin
(Clemens), who follows up personally for payment and shipping. Stripe checkout and automatic
Gelato order submission are explicitly parked.

Print partner: **Gelato** (API access is free; you pay per order). Verified July 2026:
hardcover photo book 20×20 cm, 30 pages ≈ €13.38 excl. VAT + €3.86 shipping to Germany,
produced locally in Germany, 4–5 business days.

---

## 1. User journey

1. **Entry** — "Books" section (see §7 for desktop/mobile placement).
2. **Create** — pick the chronicle, select stories (default: all `ready` stories, ordered by
   `event_date`), set title/subtitle and a cover photo, pick a format.
3. **Preview** — the worker renders a low-res, watermarked PDF; the user pages through it
   in the app.
4. **Refine** — reorder/remove stories, tweak title/dedication, re-render. Or open the chat
   and tell the agent ("move grandma's wedding story to the front, drop the last photo") —
   the agent edits the same book through tools and triggers a re-render.
5. **Order** — the app quotes the price (Gelato cost + margin) and shows "Order at €X".
   Confirming stores the order and emails the admin with the user's name/email, the book spec,
   and the quoted price. The user sees a "we'll be in touch" confirmation.
6. **Later (parked)** — Stripe payment, shipping-address collection, automatic Gelato order
   submission, tracking-status webhooks.

## 2. Data model (`db/schema.ts`)

```ts
export const bookStatus = pgEnum('book_status', [
  'draft',          // being assembled, no current preview
  'rendering',      // render job queued/running
  'preview_ready',  // preview PDF in S3 matches current content
  'render_failed',
  'ordered',        // order requested; book locked read-only
]);

export const books = pgTable('books', {
  id: uuid().defaultRandom().primaryKey(),
  chronicleId: uuid().notNull().references(() => chronicles.id, { onDelete: 'cascade' }),
  createdBy: text().notNull().references(() => user.id, { onDelete: 'restrict' }),
  title: text().notNull(),
  subtitle: text(),
  dedication: text(),
  coverAssetId: uuid().references(() => assets.id, { onDelete: 'set null' }),
  /** Gelato product family + trim size; page count is computed at render time. */
  format: text().notNull().default('hardcover-21x28'),
  status: bookStatus().notNull().default('draft'),
  errorMessage: text(),
  pageCount: integer(),            // set by the renderer
  previewS3Key: text(),            // low-res watermarked PDF
  printS3Key: text(),              // print-ready PDF (bleed, 300dpi) — same job, used later
  createdAt / updatedAt,
});

/** Ordered story selection. */
export const bookStories = pgTable('book_stories', {
  id: uuid().defaultRandom().primaryKey(),
  bookId: uuid().notNull().references(() => books.id, { onDelete: 'cascade' }),
  storyId: uuid().notNull().references(() => stories.id, { onDelete: 'cascade' }),
  position: integer().notNull(),
  includePhotos: boolean().notNull().default(true),
}, (t) => [uniqueIndex().on(t.bookId, t.storyId)]);

/** One row per "Order at price" confirmation — grows Stripe fields later. */
export const bookOrders = pgTable('book_orders', {
  id: uuid().defaultRandom().primaryKey(),
  bookId: uuid().notNull().references(() => books.id, { onDelete: 'restrict' }),
  orderedBy: text().notNull().references(() => user.id, { onDelete: 'restrict' }),
  /** Quoted at order time: { productUid, currency, productCost, shippingCost, margin, total } */
  quote: jsonb().notNull(),
  status: text().notNull().default('requested'), // requested → (later: paid, submitted, shipped)
  createdAt,
});
```

Notes:
- A book belongs to one chronicle; access follows `memberships` like everything else.
- `ordered` books are immutable (renderer + tools refuse edits) so the admin sees exactly
  what was quoted.
- Editing an ordered book = duplicating it into a new draft (later; not v1).

## 3. Book domain library — one API for UI *and* agent

**`lib/books.ts`** owns all mutations; UI route handlers/server actions and AI tools are both
thin wrappers around it. This is what makes the book "agent-editable" for free:

```
createBook({ chronicleId, title, storyIds? })     // default: all ready stories by event date
getBook(bookId)                                   // incl. ordered story list + status
updateBook({ title, subtitle, dedication, coverAssetId, format })
setBookStories(bookId, orderedStoryIds)           // add/remove/reorder in one call
requestPreview(bookId)                            // status → rendering, enqueue render job
quoteBook(bookId)                                 // Gelato quote + margin (see §5)
placeOrder(bookId)                                // insert book_orders, email admin, lock book
```

**`lib/ai/tools/books.ts`** (registered in `lib/ai/tools/index.ts`, same `Tool`/zod pattern):

| Tool | Maps to | Notes |
|---|---|---|
| `list_books` / `get_book` | read | returns TOC so the model can reason about order |
| `create_book` | `createBook` | |
| `update_book` | `updateBook` | title, subtitle, dedication, cover, format |
| `set_book_stories` | `setBookStories` | full ordered list — idempotent, no fiddly move ops |
| `render_book_preview` | `requestPreview` | agent ends its turn telling the user a preview is coming |
| `quote_book_price` | `quoteBook` | lets the user ask "what would it cost?" in chat |

`place_order` is deliberately **not** a tool — ordering stays a human click on the order screen.

## 4. Rendering pipeline (worker)

New pg-boss queue **`render-book`** next to `style`/`transcode` in `lib/queue.ts`, handled in
`worker/index.ts`.

**Typesetting: HTML/CSS → Chromium → PDF.** The layout is an HTML template
(`lib/book-layout.ts`) using CSS paged media (`@page` size/margins, `break-inside: avoid`,
running page numbers). Chromium (Puppeteer) prints it to PDF. Rationale: we already write
HTML/CSS all day, photos/captions/TOC are trivial, and the same template serves both render
modes. Alternative considered: Typst (faster, deterministic, no browser in the image) — better
long-term, but a new language for every layout tweak; revisit if Chromium hurts.

One job, two outputs from the same layout:
- **`preview.pdf`** — images downscaled (~96 dpi via resized S3 fetches), diagonal "Vorschau /
  Preview" watermark, no bleed. Small enough to stream to the phone.
- **`print.pdf`** — 300 dpi images, +3 mm bleed on the page box, no watermark. Stored now,
  used when real Gelato submission lands.

Layout v1 (keep it beautiful but boring): cover page (title, subtitle, cover photo) → title
page → table of contents → one chapter per story (title, formatted `event_date`, `bodyStyled`,
photos as full-width or half-width figures with captions) → colophon page ("Created with
Family Chronicle", date). Chapters start on a right-hand page. Pad final blanks to Gelato's
page-count rules (photo books: 30–200 pages; exact multiples to be confirmed against the API
in implementation).

Infra impact: the worker image needs Chromium (`Dockerfile`: install chromium + fonts
(`fonts-noto`, emoji) ≈ +300 MB; set `PUPPETEER_EXECUTABLE_PATH`). Renders are memory-heavy —
run one at a time (`batchSize: 1`, `teamSize: 1`).

## 5. Gelato integration (`lib/gelato.ts`)

New env vars in `lib/env.ts`:

```
GELATO_API_KEY            # dashboard → API keys; free plan includes API access
GELATO_PRODUCT_UID_21x28  # e.g. photobooks-hardcover_pf_210x280-mm-8x11-inch_pt_170-gsm-…
GELATO_PRODUCT_UID_20x20
BOOK_MARGIN_EUR           # flat margin added to Gelato cost, e.g. 15
BOOK_ORDER_NOTIFY_EMAIL   # Clemens
```

v1 uses exactly one endpoint — **quote**:
`POST https://order.gelatoapis.com/v4/orders:quote` with header `X-API-KEY`, body
`{ products: [{ productUid, quantity: 1, pageCount }], recipient: { country: 'DE', … } }`.
Returns product + shipping cost. We quote against a default German address until real
shipping-address collection exists; the order screen states "Preis inkl. Versand innerhalb
Deutschlands". Quotes are cached on the book (`bookOrders.quote` at order time) so the email
matches what the user saw. Fallback: if the quote call fails, show "price on request" and
still allow ordering (admin prices it manually).

Parked for the Stripe phase: `POST /v4/orders` (files as presigned `print.pdf` URL),
order-status webhooks, VAT handling.

## 6. Order screen & admin email

- **`lib/email.ts`** — the app currently has **no** email sending (better-auth has a TODO).
  Add a minimal SMTP transport (nodemailer + `SMTP_URL`/`SMTP_FROM` env) used for this
  notification first; invitations can adopt it later.
- `placeOrder(bookId)`: re-quote → insert `book_orders` → set book `ordered` → email
  `BOOK_ORDER_NOTIFY_EMAIL`: user name + email, chronicle, book title, format, page count,
  quoted breakdown, S3 link to the current preview PDF. Then render a confirmation screen:
  "Bestellung eingegangen — wir melden uns für Zahlung & Versand."

## 7. UI & navigation

Routes under `app/(app)/books/`:

| Route | Purpose |
|---|---|
| `/books` | list of the chronicle's books + "Create book" |
| `/books/[id]` | the builder (see below) |
| `/books/[id]/order` | quote + "Order at €X" + confirmation |

**Builder** (`/books/[id]`): desktop = two panes — left: story checklist with drag-reorder +
book settings (title, subtitle, dedication, cover photo picker, format); right: preview pane
(embedded PDF via `<iframe>`/native viewer, with a "Render preview" / "Re-render" button and
status chip driven by `book.status` polling). Mobile = the same as stacked steps
(Stories → Settings → Preview) with a sticky bottom "Continue" button. An "Edit with AI"
button deep-links to `/chat` — the agent picks the book up via its tools.

**Navigation:**
- **Desktop**: fifth sidebar item **"Books" / „Bücher"** (e.g. `IconBookmarks` — `IconBook2`
  is taken by Stories) in `components/app-shell.tsx` `NAV`.
- **Mobile**: **no fifth tab** (per requirement). Entry points instead:
  1. a "Create a book" card/button in the **Stories** tab header — books are made *from*
     stories, so this is where the intent arises; and
  2. a "Books" row on the **Settings** page for finding existing books again.
  `/books/*` renders as a normal full-screen page with a back arrow; the bottom bar keeps
  its four tabs (none highlighted while inside `/books`).

**i18n**: every new string in both `lib/i18n/en.ts` and `de.ts`, German in du-form.

## 8. Delivery plan (PRs)

1. **Schema + domain + skeleton UI** — enums/tables, `lib/books.ts`, `/books` list/create,
   builder without preview (story selection, ordering, settings). Ends with a book persisted.
2. **Render pipeline** — queue + worker job, Chromium in the Docker image, HTML layout,
   preview PDF in S3, preview pane in the builder. Ends with a viewable book preview.
3. **Agent tools** — `lib/ai/tools/books.ts` + prompt note in `lib/ai/prompts.ts`. Ends with
   "swap chapter 2 and 3" working in chat.
4. **Quote + order + email** — `lib/gelato.ts`, `lib/email.ts`, order screen, admin
   notification. Ends the v1 journey.

Each PR is independently deployable; 2 requires an infra touch (image size, worker memory —
check against `INFRASTRUCTURE.md` before deploying).

## 9. Open decisions

1. **Default format**: 21×28 cm portrait (memoir-like) vs 20×20 cm square (album-like)?
   Plan assumes 21×28 default, square selectable.
2. **Margin**: flat `BOOK_MARGIN_EUR` on top of Gelato cost — amount?
3. **Preview embed**: iframe'd PDF is fine on desktop; iOS PWA PDF embedding is quirky —
   accept "opens in viewer" on mobile v1, or invest in per-page image previews?
4. **Gelato product**: confirm exact `productUid`s + page-count rules against the live
   catalog API once the API key exists.
5. **Email transport**: SMTP (nodemailer) vs Resend — plan assumes SMTP for no-vendor-lock.
