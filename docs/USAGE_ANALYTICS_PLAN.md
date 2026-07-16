# Usage Analytics — Integration Plan

Status: proposal · Author: engineering · Date: 2026-07-16

## 0. TL;DR

Familienwerk currently has **no product analytics, no error monitoring, and no
event logging** — observability is `console.log` only. This plan adds usage
analytics in a way that respects the **binding constraint** below.

**Binding constraint — our own privacy policy.** `app/(legal)/datenschutz`
(§2, §9) publicly promises *"kein Tracking"* and *"keine Analyse-, Tracking-
oder Werbe-Cookies"*, and relies on the § 25 Abs. 2 TDDDG "strictly necessary"
exemption so that **no cookie-consent banner is needed**. Any analytics that
sets a non-essential cookie or ships data to an ad-tech vendor would break that
promise and legally force a consent banner we don't have. So the whole design
is **cookieless, first-party, self-hosted, no cross-site identifiers.**

Recommended stack (all self-hosted on the existing Hetzner box, all cookieless):

| Layer | Tool | Why |
|---|---|---|
| Web/traffic analytics | **Plausible (self-hosted)** or **PostHog (self-hosted, cookieless)** | Aggregate page/PWA usage without cookies or PII |
| Product events (the important part) | **First-party `events` table in our own Postgres** | Full control, no third party, joins to our data, GDPR-trivial |
| Error / crash monitoring | **GlitchTip** (Sentry-compatible, self-hosted) | We have zero error visibility today; this is the highest-value gap |
| AI cost & latency | **Same first-party `events` table** (token usage from `completion.usage`) | We currently discard `completion.usage` — real money is untracked |

If we want to move fast with one vendor instead of three, **self-hosted PostHog
covers web analytics + product events + session-level funnels in one tool** and
can run cookieless. The first-party table is still recommended for AI-cost and
anything we want to join against chronicle/story data in SQL.

---

## 1. Goals & non-goals

**Goals**
- Understand activation & retention: do invited family members actually
  contribute stories? Where do they drop off (signup → first story → book)?
- Track the core value-creation funnel: voice/typed input → transcription →
  styling → story ready → book.
- Surface **failures** (transcription errors, styling failures, book renders
  dying in Chromium) that today are invisible unless a user complains.
- Track **AI spend** per model / per event — currently completely untracked.
- Do all of this without breaking our privacy promises or adding a cookie
  banner.

**Non-goals**
- No advertising, no cross-site tracking, no fingerprinting, no session replay
  of PII, no third-party ad-tech.
- No per-keystroke or content-capturing analytics (we never send story text,
  names, audio, or photos to an analytics tool).
- Not building a full BI/warehouse — Postgres + a dashboard is enough at this
  scale.

---

## 2. What to track

Three tiers. Tier B (first-party product events) is where the real value is.

### Tier A — Web / traffic analytics (aggregate, anonymous)
Handled by Plausible/PostHog client snippet. Cookieless, no PII.
- Page views (landing, login, signup, key app routes), referrers, country,
  device/browser, PWA vs browser.
- **PWA install** — we already fire `capturePwaInstallPrompt()` in
  `app/providers.tsx`; emit an `pwa_installed` event.
- Web Vitals / basic performance (optional, Plausible has this).

### Tier B — Product / business events (first-party, keyed by user + chronicle)
Stored in our own `events` table. Each event carries `userId`, `chronicleId`,
`name`, timestamp, and a small non-PII `jsonb` props blob (ids, enums, counts,
durations — **never** free text/content). Instrument the `lib/*` domain
functions, not the `actions.ts` wrappers, so **both UI and AI-agent-driven
paths are captured** (agent tools call the same `lib/*` functions).

Auth & onboarding
- `signup`, `login`, `email_verified`, `google_linked`
- `invitation_sent`, `invitation_accepted` (activation!)
- `chronicle_created`

Core content funnel (the product's heart)
- `voice_note_uploaded` (duration, bytes) — `chat/actions.ts:sendVoiceMessage`
- `transcription_completed` / `transcription_failed` (latency, char count) —
  inline in `sendVoiceMessage` via `lib/ai/groq.ts`
- `chat_message_sent` (agent turn) — `lib/ai/agent.ts`
- `story_created` — `lib/story-save.ts:saveProposalAsStory`
- `story_styled` / `story_style_failed` — worker `handleStyle` → `styleStory`
- `story_ready`, `story_retried`, `story_revised`, `story_deleted`
- `story_shared` (cross-chronicle) — `stories/[storyId]/actions.ts:shareStory`
- `photos_added` (count) — `lib/stories.ts`

Genealogy
- `person_added`, `people_related` — `chronicle/actions.ts`

Books (highest-intent, revenue-adjacent)
- `book_created`, `book_preview_requested`, `book_preview_ready`,
  `book_ai_design_requested`, `book_ai_design_completed` / `..._failed`
- `book_order_started` — ⚠️ **today the order is a client `mailto:` only; the
  `bookOrders` table is never written.** This plan should add a tiny server
  action that (a) inserts the intended order and (b) emits `book_order_started`,
  so we can actually measure conversion to the highest-value action.

### Tier C — Backend / worker / cost & reliability
Emitted server-side into the same `events` table (and errors into GlitchTip).
- Per pg-boss job (`style`, `transcode`, `render-book`, `design-book`,
  `thumbnail`): `job_started` / `job_succeeded` / `job_failed` with duration and
  retry count. `worker/index.ts` is the single choke point.
- **AI usage/cost**: capture `completion.usage` (prompt/completion tokens) —
  currently discarded at all three call sites (`lib/ai/openrouter.ts`,
  `lib/ai/agent.ts`, `lib/book-ai-layout.ts`). Emit `ai_call` events with
  `model`, `promptTokens`, `completionTokens`, `latencyMs`, `feature`. This is
  literally untracked spend today.
- `book_render_failed` (Chromium OOM/timeout) — the most failure-prone job.

---

## 3. First-party event model (Tier B/C)

New Drizzle table (migration after current `0015_*`):

```ts
// db/schema.ts
export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),                 // e.g. 'story_created'
  userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
  chronicleId: uuid('chronicle_id')
    .references(() => chronicles.id, { onDelete: 'cascade' }),
  props: jsonb('props').$type<Record<string, unknown>>().default({}), // ids/enums/counts only
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  byName: index('events_name_created_idx').on(t.name, t.createdAt),
  byChronicle: index('events_chronicle_idx').on(t.chronicleId, t.createdAt),
}));
```

A thin helper keeps call sites one-liners and makes it a **no-op when disabled**
(so local dev/CI/`SKIP_ENV_VALIDATION` builds never break):

```ts
// lib/analytics.ts  (server)
export async function track(name: string, opts: {
  userId?: string; chronicleId?: string; props?: Record<string, unknown>;
}) {
  try {
    await db.insert(events).values({ name, ...opts });
    // optionally also forward to PostHog server SDK here
  } catch (e) {
    console.error('[analytics] failed', name, e); // never throw into business logic
  }
}
```

Rules:
- **Never** put content in `props` — no story text, names, emails, transcripts,
  filenames. Only ids, enums, counts, durations, booleans.
- `track()` never throws — analytics failure must not break a user flow.
- Retention: a nightly job (reuse the existing `sweep-orphans` cron pattern in
  `worker/index.ts`) deletes `events` older than N months to keep the promise
  of data minimisation.

---

## 4. Recommended tooling — detail & rationale

**Web analytics: Plausible (self-hosted) — recommended default.**
- Cookieless by design, no consent banner, GDPR-friendly, lightweight script,
  no PII. Fits §9 of our policy almost verbatim.
- Alternative: **PostHog self-hosted, cookieless** (`persistence: 'memory'`,
  `disable_cookie: true`) if we want funnels/retention in the same tool as
  product events. Heavier to operate.
- Rejected: **Google Analytics / any cookie-mode SaaS** — would violate §2/§9
  and require a consent banner. Do not use.

**Product events: first-party Postgres `events` table — recommended.**
- Zero third parties, trivial DPA/GDPR story, joins directly against
  chronicles/stories/memberships for real product questions
  ("% of invited members who wrote ≥1 story in 30 days"). We already run
  Postgres; marginal cost ~0.

**Errors: GlitchTip (self-hosted, Sentry SDK-compatible) — recommended.**
- We have **no** crash/error visibility today. Highest ROI item on the list.
- Wire `@sentry/nextjs` pointed at a self-hosted GlitchTip DSN; scrub PII in
  `beforeSend`. Covers both `web` and `worker` processes.

**Dashboard: Metabase (self-hosted) — optional, later.**
- Point-and-click charts over the `events` table for the funnels above. Or just
  ship a few SQL views + an internal `/admin/metrics` page initially.

Everything self-hosts on the existing Hetzner + Coolify setup (add services;
see `INFRASTRUCTURE.md`), keeping data in EU and under our control.

---

## 5. Env vars (mirror the existing optional-integration pattern)

Add to `lib/env.ts` (server) — all **optional**, no-op when unset, exactly like
SMTP/Google today:

```ts
POSTHOG_KEY: z.string().optional(),           // if using PostHog server-side
SENTRY_DSN: z.string().url().optional(),      // GlitchTip DSN
ANALYTICS_ENABLED: z.enum(['true','false']).default('false').transform(v => v === 'true'),
EVENTS_RETENTION_DAYS: z.coerce.number().default(180),
```

Client-exposed keys must use `NEXT_PUBLIC_` (read directly, not via `lib/env.ts`):
```
NEXT_PUBLIC_PLAUSIBLE_DOMAIN=familienwerk.co
NEXT_PUBLIC_POSTHOG_KEY=...   # only if PostHog client used, cookieless config
```
Keep everything gated so `SKIP_ENV_VALIDATION` Docker builds and local dev boot
without any analytics config.

---

## 6. Privacy / legal — required before shipping

1. **Update `app/(legal)/datenschutz`.** Add a section describing: first-party
   analytics, what's collected (no content, only usage events/ids/counts),
   retention window, cookieless nature, and any processor added (if we host
   Plausible/GlitchTip ourselves and keep data in EU, no new sub-processor is
   introduced — a genuine advantage of self-hosting).
2. **Keep the cookieless guarantee true.** If we ever switch to a tool that sets
   a non-essential cookie, we must add a consent banner (CMP) first. The whole
   point of this design is to avoid that.
3. **PII hygiene in code review**: the `props`-has-no-content rule and Sentry
   `beforeSend` scrubbing are review-gates, not suggestions.
4. Update `INFRASTRUCTURE.md` with the new self-hosted services.

---

## 7. Rollout phases

- **Phase 0 — Errors first (½ day, highest ROI).** Stand up GlitchTip, add
  `@sentry/nextjs` to `web` + `worker`, PII scrubbing. We immediately see what's
  breaking in production.
- **Phase 1 — First-party events core.** Add `events` table + migration +
  `lib/analytics.ts` `track()` helper. Instrument the content funnel
  (Tier B core: signup, invite_accepted, voice→transcription→story→ready,
  book_created) at the `lib/*` layer. Add retention cron.
- **Phase 2 — AI cost & jobs.** Capture `completion.usage` at the three AI call
  sites; emit `ai_call` + per-job success/failure/duration in `worker/index.ts`.
- **Phase 3 — Web analytics.** Add Plausible (or cookieless PostHog) snippet in
  `app/layout.tsx` / `app/providers.tsx`; emit `pwa_installed`.
- **Phase 4 — Book order hook.** Add the server action that writes `bookOrders`
  and emits `book_order_started` (fixes the current measurement blind spot).
- **Phase 5 — Dashboards.** Metabase or an internal `/admin/metrics` page over
  the `events` table; define the activation/retention funnels.
- **Phase 6 — Update datenschutz + INFRASTRUCTURE.md**, then ship.

## 8. Key North-Star questions this should answer
- **Activation:** of invited members, what % write ≥1 story within 7/30 days?
- **Funnel health:** voice_note_uploaded → transcription_completed →
  story_ready — where's the drop-off and how often does it fail?
- **Retention:** weekly active contributors per chronicle over time.
- **Cost:** €/story and €/book in AI spend, per model.
- **Reliability:** job failure rates, esp. `render-book` (Chromium).
- **Value moment:** how many chronicles reach a rendered/ordered book?
