# DSGVO / GDPR Compliance Review — Familienwerk

**Stand:** Juli 2026 · Reviewed: code (branch `main` @ `8620031`), `INFRASTRUCTURE.md`,
`app/(legal)/datenschutz`, PostHog integration, auth, storage, AI pipelines.

This is an engineering review, not legal advice. It maps what the app/infra actually do
against what the DSGVO (and TDDDG for cookies) requires and against what our own
Datenschutzerklärung currently *claims* — the claims are the most urgent part, because a
privacy policy that contradicts observable behavior is indefensible.

---

## Summary verdict

The foundation is genuinely good: EU hosting (Hetzner Nürnberg), R2 in EU jurisdiction,
invite-only access, no ads, raw-input traceability, HTTPS everywhere, secrets outside the
repo, and an existing Impressum + Datenschutzerklärung. The gaps are concentrated in four
areas:

1. **The PostHog analytics rollout contradicts the privacy policy and has no consent.**
2. **Betroffenenrechte (Art. 15–20) have no implementation** — most importantly no account
   deletion (and several FK constraints would make one fail today).
3. **The policy's processor list is incomplete/unverified** (PostHog, Resend, Google
   missing; AVV/DPA status unconfirmed) and the controller (Swiss AG) likely needs an
   **Art. 27 EU representative**.
4. **Organisational artefacts are missing** (Art. 30 VVT, Art. 32 TOMs, Art. 33 breach
   process, backups).

---

## 🔴 Critical — fix before anything else

### C1. PostHog vs. Datenschutzerklärung §9 — direct contradiction, no consent

The policy states: *"Die Anwendung verwendet ausschließlich technisch notwendige Cookies …
Es werden keine Analyse-, Tracking- oder Werbe-Cookies eingesetzt."*

Reality since the PostHog merge (`instrumentation-client.ts`, PR #93):

- `posthog-js` initializes **unconditionally** for every visitor (login/signup pages
  included) with default persistence → **analytics cookies/localStorage are set without
  consent**. § 25 Abs. 1 TDDDG requires prior consent for exactly this; the § 25 Abs. 2
  exemption the policy cites covers only *technisch notwendige* storage.
- Users are **identified with clear PII**: `posthog.identify(userId, { name, email })`
  (`components/posthog-identify.tsx`, login/signup pages).
- `capture_exceptions: true` ships error payloads (messages, URLs, stack context) that can
  contain personal data.
- Events are **reverse-proxied through `/ingest`** (`next.config.ts`) explicitly so
  ad-blockers don't catch them — defensible technically, but it defeats user
  self-protection while we simultaneously claim to do no tracking. In a complaint this
  reads badly.
- Server-side events (`lib/posthog-server.ts`) tie user IDs to behavior
  (`user_signed_up`, `voice_message_sent`, …) with no mention anywhere in the policy and
  no named legal basis.
- PostHog is **absent from the processors list** (§7) even though PostHog EU (hosted in
  Frankfurt, but PostHog Inc. is a US company) processes identified user data for us.

**Required actions (pick one of A/B for the client, then do the rest):**

- **Option A — consent banner (full feature set):** gate `posthog.init` (and `identify`)
  behind an opt-in consent banner; persist the choice; no events before opt-in.
  Legal basis: Einwilligung (Art. 6 Abs. 1 lit. a DSGVO + § 25 Abs. 1 TDDDG).
- **Option B — cookieless/anonymous mode (no banner):** `persistence: 'memory'`, no
  `identify`, no autocapture of person data, no exception capture, anonymous events only.
  Arguably exempt from § 25 consent (no terminal-equipment storage) and coverable by
  berechtigtes Interesse — but the policy must still disclose it and offer opt-out
  (Art. 21). Server-side events must be pseudonymized (hash the user id) or also covered.
- Either way: **update Datenschutzerklärung** (§7 add PostHog as processor incl. EU
  hosting; rewrite §9 cookies; add an analytics section with legal basis + opt-out),
  and **sign PostHog's DPA** (available self-service in their EU cloud).
- Until a decision is made, the fastest compliant state is: unset
  `NEXT_PUBLIC_POSTHOG_KEY` in prod (both apps) — the integration is built to no-op.

### C2. No account deletion (Art. 17) — and the schema would currently block it

There is **no self-service deletion and no admin deletion routine**. better-auth's
`user.deleteUser` feature is not enabled in `lib/auth.ts`. The policy (§10) promises
*"Löschst du dein Konto …, werden die betroffenen Daten gelöscht"* — a flow that does not
exist. Email-based manual handling is legally acceptable, but there is currently no
procedure that could even execute it, because several FKs are `onDelete: 'restrict'`:

- `stories.submitted_by`, `people.created_by`, `chronicles.created_by`,
  `books.created_by`, `book_orders.ordered_by` → a plain `DELETE FROM "user"` fails.

**Required actions:**

- Implement a `deleteAccount` routine (server action + optionally better-auth
  `user: { deleteUser: { enabled: true } }` with verification): reassign or anonymize the
  `restrict` references (e.g. a sentinel "Gelöschtes Mitglied" pattern or nulling via
  schema change to `set null` where the domain allows), delete sessions/accounts,
  unlink `people.user_id` (already `set null`), delete the user's avatar object,
  `posthog.reset()` + PostHog person deletion (if Option A), and log the erasure.
- Decide the content question deliberately: contributed stories are shared family
  material — keeping styled stories while anonymizing authorship (contributions already
  go `set null`) is defensible under Art. 17 Abs. 3 / the other members' interests, but
  the policy must say so explicitly.
- Add deletion for the other aggregates that currently have none: **chronicles**
  (no delete exists; must cascade to R2 objects) and **people** (no `deletePerson`;
  relevant for Art. 17 requests from non-user family members).

### C3. Signup collects data with no privacy notice at the point of collection (Art. 13)

The signup page has no link to (or acknowledgment of) the Datenschutzerklärung; the legal
pages are only linked from the landing footer. Art. 13 requires the information *at the
time of collection*.

**Required actions:** add "Mit der Registrierung akzeptierst du unsere
Datenschutzerklärung" (+ link, ideally + AGB/Nutzungsbedingungen) to signup — and because
we rely on **explicit consent** for Art. 9 special-category content (§5 of the policy) and
Art. 49 Abs. 1 lit. a US transfers (§8), an **explicit checkbox** at signup (or a one-time
in-app consent screen) is strongly recommended; implied "consent by contributing" is weak
for Art. 9, which requires *ausdrückliche* Einwilligung.

---

## 🟠 High

### H1. Processor list incomplete / AVV & transfer basis unverified

The policy (§7) asserts Art. 28 AVVs with Hetzner, Cloudflare, OpenRouter, Groq. To be
defensible we must actually hold/verify each, and the list is missing entries:

| Processor | Data | Status / action |
|---|---|---|
| Hetzner (DE) | everything (hosting) | AVV available self-service in Hetzner console — **confirm signed/archived** |
| Cloudflare R2 (EU jurisdiction) | audio, photos, PDFs | Cloudflare DPA (incl. SCCs) — **confirm accepted, archive** |
| OpenRouter (US) | story text, chat incl. photos (vision), style guides | **Verify a DPA exists at our tier**; see H2 for data-retention controls |
| Groq (US) | voice recordings | **Verify DPA / retention terms** |
| **Resend (US)** — SMTP (`SMTP_URL`) | name, email of every verified user | **Missing from policy §7**; sign Resend DPA; US transfer → SCC/DPF check |
| **PostHog (US co., EU cloud)** | user id, name, email, usage events | **Missing from policy** — see C1 |
| **Google** (OAuth sign-in) | OAuth profile (name, email) | Not a processor but a data source/recipient — **missing from policy §4**; add a Google-Sign-In section |
| Gelato | book quotes | Currently quote-only (format/pages, no PII per `lib/gelato.ts`) — likely not a processor yet; re-check when real ordering ships |
| Let's Encrypt / registrar / DNS | none personal | no action |

For every US processor, name the concrete transfer mechanism (SCC and/or EU-US Data
Privacy Framework certification — check DPF status for Cloudflare, OpenRouter, Groq,
Resend, PostHog) instead of the current generic §8 wording.

### H2. AI pipeline: no data-retention/training controls at OpenRouter

`lib/ai/openrouter.ts` and the chat agent send full story content (potentially Art. 9
data, plus **photos** when `AGENT_VISION=true`) to OpenRouter with **no provider
restrictions**. OpenRouter routes to arbitrary upstream providers whose logging/training
policies differ.

**Required actions:**

- Set OpenRouter provider preferences on every request:
  `provider: { data_collection: 'deny' }` (and consider `zdr: true` / pinning specific
  providers). Also verify the OpenRouter *account-level* privacy settings (logging off,
  training opt-out).
- In our OpenRouter account settings, disable prompt logging.
- Groq: verify their zero-retention posture for the Whisper endpoint and reference it.
- Document in the policy which model/provider class handles content (currently vague).

### H3. Swiss controller → Art. 27 EU representative

The Verantwortlicher is **MTX Studio AG, Zug (Schweiz)** — a non-EU controller offering a
service to people in the EU (German-language product, German users). Art. 27 DSGVO
requires a **designated representative in the EU**, named in the privacy policy, unless
the Art. 27(2) exemption applies (only for *occasional* processing without large-scale
Art. 9 data — hard to claim for a product whose core is continuous processing of family
life data). Also note the Swiss revDSG applies in parallel to the controller itself.

**Action:** appoint an EU representative (services exist for ~€100–200/yr) and add them to
Impressum/Datenschutzerklärung — or get a legal opinion that Art. 27(2) applies.

### H4. Third-party content: people who never consented

The product's core is data about **third parties** — living relatives who never signed up
(the `people` graph, birth dates, kinship, notes, photos, health/religion details inside
stories, invitees' emails in `invitations`). Contributors may be covered by the household
exemption (Art. 2 Abs. 2 lit. c), but **the operator is not** — MTX Studio processes this
data as a service.

**Actions (risk reduction — this can't be fully "solved" in code):**

- Nutzungsbedingungen obliging contributors to only add material about relatives they may
  share, and to relay objections.
- A documented takedown/objection process (Art. 21) reachable without an account
  (contact address is already in the policy — add an explicit "Inhalte über dich" section).
- Keep access tight (already good: invite-only, kinship-gated story access mode).
- Person deletion/anonymization tooling (see C2) so an Art. 17 request from a non-user
  relative can actually be executed.

### H5. Betroffenenrechte tooling: export (Art. 15/20)

No data-export exists. Manual fulfilment is fine at this scale, but we should have at
least an **internal script/runbook**: per user, dump their `user` row, memberships,
stories/contributions authored, conversations, assets (R2 object list), in a
machine-readable format (Art. 20). A self-service "Meine Daten exportieren" button on the
Settings → Account tab is the comfortable end state.

---

## 🟡 Medium

### M1. Retention & cleanup jobs (Art. 5 Abs. 1 lit. e)

- **Sessions**: `session.ip_address` + `user_agent` are stored per session (30-day
  expiry). Verify expired rows are actually purged (better-auth cleans lazily); add a
  periodic worker sweep for `session`, `verification`, and **expired `invitations`**
  (invitee emails of people who never joined should not live forever).
- **Conversations/messages**: kept indefinitely, including free-text chat with the agent.
  Fine while the account exists, but they must fall under C2's deletion.
- Orphaned uploads: already handled (`lib/orphans.ts`, 24 h grace) ✅.
- Story deletion already removes R2 objects incl. thumbnails ✅ — extend the same rigor
  to chronicle/person/account deletion when built (C2).

### M2. Logs (Art. 32 / Art. 5)

- Configure **Docker log rotation** on the host (`log-driver` max-size/max-file or
  daemon.json) — unbounded stdout logs on a 40 GB disk are both a retention and an
  availability problem.
- Traefik access logs: check whether enabled and IP-retention duration; the policy's §3
  (server logs, berechtigtes Interesse) covers them, but keep retention short (e.g. 7–14 d).
- `lib/email.ts` logs full email bodies incl. address when `SMTP_URL` is unset — fine in
  dev, but guard with a NODE_ENV check so a prod misconfiguration doesn't write PII to logs.
- Avoid logging story content/transcripts in worker error paths (spot-check `worker/`).

### M3. Backups (Art. 32 Abs. 1 lit. c — availability & restore)

`INFRASTRUCTURE.md` §12 lists Postgres backups as outstanding. Losing families' memoirs
is itself a personal-data incident (integrity/availability). Enable Coolify scheduled
dumps to R2 (EU), define retention (e.g. 30 d), **encrypt the dumps**, and note that
deleted accounts persist in backups for that window (say so in the policy's retention
section — standard practice).

### M4. Organisational paperwork

- **Verzeichnis von Verarbeitungstätigkeiten (Art. 30)** — the <250-employee exemption
  does *not* apply (processing is non-occasional and includes Art. 9 categories). One
  short document listing purposes/categories/processors/retention — much of it can be
  derived from this review.
- **TOMs (Art. 32)** — write down what already exists (key-only SSH, firewalled admin
  ports, hashed passwords via better-auth/scrypt, membership checks, `assertOwnedKey`,
  TLS, presigned-URL scoping, EU storage). Add: disk/database-at-rest encryption is
  currently **absent** on the Hetzner VPS — acceptable risk-based, but record the decision
  (or move backups/dumps to encrypted form, M3).
- **Breach process (Art. 33/34)** — one page: who detects → assess → 72 h notification to
  the supervisory authority (for the Swiss AG via the EU representative / lead authority
  question) → user notification threshold.
- **Datenschutz-Folgenabschätzung (Art. 35)**: large-scale Art. 9 processing is a DSFA
  trigger; at family-and-friends scale "large-scale" is arguable — document a short
  threshold assessment concluding either way.

### M5. Policy text fixes (beyond C1)

- §4: mention session IP/User-Agent storage and Google sign-in.
- §7/§8: add Resend + PostHog; name SCC/DPF per processor (H1).
- §10: describe backup retention window (M3) and the "styled stories survive account
  deletion in anonymized form" rule if chosen (C2).
- Add a "content about you (non-users)" section (H4) and the EU representative (H3).
- Impressum: verify it meets § 5 DDG (formerly TMG) requirements for the Swiss AG
  (Vertretungsberechtigte, Handelsregister) — not re-reviewed here.

---

## 🟢 Already in good shape (keep it that way)

- EU hosting end-to-end for storage: Hetzner Nürnberg + R2 EU jurisdiction (with the
  `.eu.` endpoint gotcha handled).
- Invite-only, membership-checked access (`requireMembership`/`requireEditor`), kinship-
  gated story reads, `assertOwnedKey` against cross-chronicle object references.
- Passwords hashed by better-auth; secrets only in Coolify env; admin ports not exposed.
- Presigned, short-lived upload/download URLs; private bucket.
- Raw-input traceability with per-contribution attribution (helps Art. 15 answers).
- Orphaned-object sweeping; story deletion cleans R2.
- Existing Impressum + Datenschutzerklärung with sensible structure and legal bases.
- PostHog EU ingestion hosts configured (both client and server) — right region, wrong
  consent story (C1).

---

## Suggested implementation order

| # | Item | Effort |
|---|---|---|
| 1 | C1: consent banner chosen and **✅ implemented** (opt-in banner, consent cookie honored client- and server-side, withdrawal widget on /datenschutz, policy §4/§7/§9 updated) | S–M |
| 2 | C3: **✅ implemented** (signup consent checkbox gating email and Google signup, legal links on auth pages) | S |
| 3 | H2: OpenRouter `data_collection: 'deny'` **✅ implemented** on all completion calls; still open: account-level logging off (admin), Groq retention check | S |
| 4 | C2: account deletion routine (incl. FK strategy, R2 cleanup, PostHog erasure) + chronicle/person deletion | M–L |
| 5 | H1: collect/sign all DPAs (Hetzner, Cloudflare, PostHog, Resend, OpenRouter, Groq); update policy processor list | S (admin) |
| 6 | H3: EU representative for the Swiss AG; add to policy | S (admin) |
| 7 | M3: encrypted Postgres backups to R2 | S–M |
| 8 | H5/M1: export runbook; retention sweeps (sessions, verifications, invitations); log rotation | M |
| 9 | M4: VVT, TOMs, breach one-pager, DSFA threshold note | M (writing) |

Items 1–3 are pure code and could ship this week; 4 is the largest code item; 5–6 are
admin tasks with outsized legal value.
