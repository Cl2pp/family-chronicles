# In-App Checkout & Ordering — Implementation Plan

Today the book journey ends at an email hand-off: the order page shows the live Gelato
quote and a prefilled mailto to `BOOK_ORDER_CONTACT_EMAIL`; payment and print submission
happen manually. This plan takes it the rest of the way: **address → exact price → pay in
the app (Stripe) → the worker submits the order to Gelato automatically → the user gets
status + tracking**. The dormant pieces built for this (`book_orders` table, `ordered`
status, `lib/email.ts`) come alive here.

---

## 0. What exists and is reused as-is

| Piece | State today |
|---|---|
| `lib/gelato.ts` | Live `orders:quote` (verified in prod: 21×28 → €13.49 + €3.86 shipping, DE fulfillment); product UIDs resolve |
| `book_orders` table | Written never; has `quote` jsonb snapshot, `status text` |
| `books.status = 'ordered'` | Lock semantics implemented everywhere (mutations, tools, chat) but never set |
| `lib/email.ts` | nodemailer wrapper, logs when `SMTP_URL` unset |
| Print proof | `render-book` produces `print.pdf` (trim+3mm bleed, padded) — **not yet Gelato photo-book file spec**, see §5 |
| Order page | Quote breakdown + print-proof polling + mailto CTA |

## 1. Checkout flow (the happy path)

```
Order page (book preview_ready)
  1. shipping address form (in-app)          ← country determines shipping cost
  2. exact quote for THAT address            ← existing quoteBookPrice, real recipient
  3. "Zahlungspflichtig bestellen" → Stripe Checkout (hosted page, EUR)
  4. success URL → order status page         ← webhook is the source of truth, not the redirect
  5. webhook checkout.session.completed:
       book_orders → 'paid', book → 'ordered' (locked), confirmation email,
       enqueue submit-order job
  6. worker submit-order: POST Gelato /v4/orders (files = presigned print PDFs)
       → 'submitted'; failures retry, then alert admin + stay actionable
  7. Gelato order_status_updated webhooks: printed / shipped (+tracking) / delivered
       → status page timeline + shipped email with tracking link
```

**Why address before Stripe (not Stripe's own address collection):** the Gelato shipping
price depends on the destination, and we must charge the *exact* total. Collecting the
address first lets us quote precisely, and hands Gelato a clean structured recipient.
Stripe Checkout still validates the card holder side; we pass the collected address as
metadata/display only.

**Why hosted Stripe Checkout (not Elements):** no card data ever touches the app (minimal
PCI scope SAQ-A), Apple/Google Pay for free, localized UI (de), built-in receipts. A
custom Elements form is a later polish option, not a requirement.

## 2. Data model

`book_orders` grows (migration; existing columns stay):

```ts
orderStatus: pgEnum('book_order_status', [
  'pending_payment',   // checkout session created
  'paid',              // webhook confirmed; book locked
  'submitted',         // accepted by Gelato
  'in_production',     // Gelato: printed
  'shipped',           // tracking available
  'delivered',
  'cancelled',         // payment abandoned/expired or refunded before submission
  'failed',            // Gelato submission failed after retries — admin intervenes
]),
// new columns
shippingAddress: jsonb        // { name, line1, line2?, postCode, city, country, email, phone? }
stripeSessionId: text unique
stripePaymentIntentId: text
gelatoOrderId: text
trackingUrl: text, trackingCode: text, carrier: text
paidAt / submittedAt / shippedAt: timestamp
```

Rules:
- One open order per book (`unique where status not in (delivered, cancelled, failed)`).
- The **quote snapshot already stored** on the order is what Stripe charges — never
  re-derived after payment.
- `books.status → 'ordered'` only on `paid` (not on session creation); expired sessions
  release nothing because nothing was locked.
- The **print PDF the user paid for is pinned**: copy `books/{id}/print.pdf` to
  `orders/{orderId}/…` at payment time so later re-renders can't change what gets printed.

## 3. Stripe integration

- Deps: `stripe` (server SDK only — hosted Checkout needs no client library).
- Env (`lib/env.ts`, all optional so deploys don't break before setup): `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`. In-app checkout renders only when configured — the mailto flow
  stays as the fallback CTA, so this ships dark and activates by env.
- `lib/stripe.ts`: `createBookCheckoutSession(order)` — `mode: 'payment'`, `currency: eur`,
  one line item (book title + format + pages, cover thumbnail as product image),
  `client_reference_id = orderId`, `customer_email`, `locale: 'de'`, 30-min expiry,
  success/cancel URLs on the order page.
- Webhook route `app/api/stripe/webhook/route.ts`: raw-body signature verification
  (`stripe.webhooks.constructEvent` — Next route handlers must read `req.text()`, not
  json). Handle `checkout.session.completed` (→ paid pipeline, idempotent on
  `stripeSessionId`) and `checkout.session.expired` (→ cancelled). Everything else 200-OK
  ignored.
- Amounts in **cents**, computed from the stored quote; Stripe receipt enabled.
- Local dev: `stripe listen --forward-to localhost:3000/api/stripe/webhook` (Stripe CLI)
  + test cards; no tunnel needed in prod (public HTTPS exists).

## 4. Gelato order submission (worker)

New `submit-order` pg-boss job (enqueued by the paid-webhook):

- `POST https://order.gelatoapis.com/v4/orders` with `orderType: 'order'`,
  `orderReferenceId = orderId`, the stored recipient, product UID + `pageCount`, and
  `files`: presigned URLs (long expiry, from the pinned `orders/{orderId}/` copies).
- Store `gelatoOrderId`; job is idempotent (skip if already submitted — pg-boss retries).
- On repeated failure: order → `failed`, admin email with full context. The admin can
  retry from a small admin action once the cause is fixed (money already taken — this
  state must be loud, not silent).
- **Test path**: Gelato supports test orders that are auto-cancelled and drafts
  (`orderType: 'draft'`) — e2e verification without printing a real book. A
  `GELATO_ORDER_TYPE` env (default `order`, `draft` in dev) makes every environment safe.
- Gelato **webhooks** (`order_status_updated`, configured in their dashboard →
  `app/api/gelato/webhook/route.ts`): map their statuses to ours (`printed →
  in_production`, `shipped → shipped` + tracking code/URL, `delivered`). Fallback for lost
  webhooks: a lazy status poll (`GET order`) when the user opens the order page and the
  order is non-terminal + stale.

## 5. Print-file compliance (the real typesetting work in this plan)

Gelato photo books do NOT take our current single sequential PDF. Per their
[design requirements](https://support.gelato.com/en/articles/8996349-what-are-the-design-requirements-for-pdf-uploads)
and [photo-book template](https://support.gelato.com/en/articles/8996282-how-do-i-design-a-photo-book):

- Page 1 must be a **cover spread**: back cover + **spine** + front cover as one wide
  page, spine width a function of page count (their
  [cover-dimensions doc](https://dashboard.gelato.com/docs/products/product/cover-dimensions/)
  has the tables — implement as a lookup in `lib/book-layout.ts`).
- Page 2 and the last page are **blank endpapers** (non-printable).
- Inner pages follow as single pages with bleed.

Changes: a new `print-cover` render pass (the framed/full-bleed cover re-laid-out as a
spread with spine text = title + year range) and an adjusted inner sequence (drop the
screen cover page, insert blank endpapers, keep padding rules). The existing combined
`print.pdf` stays as the human-readable proof; the order pins `cover.pdf` + `inner.pdf`.
Verification like the layout phases: render, rasterize, eyeball spine alignment; then one
real `draft` order against Gelato's preflight.

## 6. Money, VAT & German consumer law (owner tasks + small app tasks)

- **Prices to consumers must display incl. VAT.** Gelato quotes are excl. VAT. Decide the
  merchant setup (Kleinunternehmer §19 UStG vs. VAT-registered) — it changes the checkout
  line copy ("inkl. MwSt." vs "gem. §19 UStG ohne MwSt.") and Stripe Tax usage. App-side
  this is a formatting/env concern (`BOOK_VAT_MODE`), not architecture.
- **No withdrawal right** for personalized goods (§312g Abs. 2 Nr. 1 BGB) — must be
  explicitly acknowledged at checkout (checkbox + sentence) to actually stick.
- Checkout needs links to **Impressum, AGB, Widerrufsbelehrung, Datenschutz** — pages the
  site (public marketing side) mostly needs anyway; the German-market legal texts are an
  owner task.
- Refund path: manual via Stripe dashboard (v1); order → `cancelled` if before
  submission. No self-service refunds.

## 7. UI

- **Order page** becomes a stepper: `Proof → Address → Pay` (existing proof/quote UI is
  step 0); after payment it renders the **order status timeline** (paid → printing →
  shipped + tracking link → delivered) driven by `book_orders`. The mailto block remains
  the fallback when Stripe env is absent.
- **Books list**: ordered books get their status chip (already exists) plus tracking
  shortcut once shipped.
- **Emails** (activates `lib/email.ts`; needs `SMTP_URL` or a provider decision):
  order confirmation (user), shipped w/ tracking (user), submission-failed (admin).
  German templates first, en fallback — same i18n discipline as the UI.
- Chat agent: unchanged policy — the agent can quote but **never** orders or pays;
  ordering stays human clicks on authenticated screens.

## 8. Delivery phases (each independently shippable)

1. **Address + exact quote + order rows** — address form, per-country quote,
   `book_orders` lifecycle columns, order created as `pending_payment` (no payment yet:
   the mailto CTA sends the order id). Ships value alone: exact prices + structured
   orders instead of freeform emails.
2. **Stripe Checkout + paid pipeline** — session creation, webhook, book lock, pinned
   print files, confirmation email, status page. Gelato submission still manual (admin
   gets the pinned files + address by email). *In-app payment live.*
3. **Print-file compliance** — cover spread + spine + endpapers renders; validated via a
   Gelato draft/test order.
4. **Automatic Gelato submission** — `submit-order` job, Gelato webhooks, tracking,
   shipped email, lazy status poll, admin-retry for failures. *Fully hands-off.*
5. **Polish** — VAT mode copy, invoices (Stripe), refunds runbook, multi-country
   shipping (quote already supports it; open the country list), Stripe Tax if registered.

Phases 1–2 and 4 are app/queue engineering in the existing patterns; phase 3 is layout
work (the same render-rasterize-review loop as layout v2).

## 9. Open questions (owner)

1. **Merchant setup**: who sells (Clemens privat / Gewerbe / UG)? Determines VAT mode,
   Impressum, AGB. Blocks phase 2 go-live, not development (test mode).
2. **Pricing**: keep flat `BOOK_MARGIN_EUR` (currently €15) or per-format/per-page margin?
   Display as one total or itemized (print + shipping + service) as today?
3. **Ship-to countries** for launch: DE only (plan default) or DE/AT/CH?
4. **Email provider**: SMTP creds for `SMTP_URL` vs. adding a provider SDK (Resend) —
   the wrapper hides either; needs one decision + DNS (SPF/DKIM) work.
5. **Failure stance**: if Gelato submission fails after payment, is admin-email + manual
   retry acceptable for v1 (plan assumes yes)?
