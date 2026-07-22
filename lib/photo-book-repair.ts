import {
  PHOTO_BOOK_STYLES,
  PHOTO_PAGE_TEMPLATES,
  PHOTO_PAGE_TEMPLATE_SLOTS,
  photoOrientation,
  templateRendersCaptions,
  type PhotoBookPlan,
  type PhotoBookStyle,
  type PhotoPagePlan,
  type PhotoPageTemplate,
  type PhotoSectionPlan,
} from '@/lib/photo-book-plan';
import { templateFits, type LintPhoto } from '@/lib/photo-book-lint';

/**
 * Turns an *almost* valid photo-book plan into a valid one.
 *
 * Why this exists: the AI design pass used to be all-or-nothing — one duplicated assetId,
 * one page with 3 photos under a 4-slot template, one reference to a photo the user
 * excluded while the model was thinking, and `proposePhotoBookPlan` threw away the entire
 * design and silently fell back to the deterministic auto-layout. In production that is
 * what actually happened (the book we diagnosed this from was sitting on
 * `layout_source: 'auto'` despite the user having clicked "Buch erstellen"), so the user
 * never saw an AI design at all — they saw the mechanical layout and judged the AI by it.
 *
 * Every problem `checkPhotoBookPlanConsistency` (`lib/photo-book-plan.ts`) can report is
 * mechanically fixable without judgment: drop what can't be shown, renumber what's left,
 * and pick the template that fits the photos that survived. That's all this does — it never
 * invents structure, never reorders sections, and never touches a page it doesn't have to,
 * so a plan that comes in clean goes out byte-identical (`changes` empty).
 *
 * Pure: no I/O, no model calls. Callers: the AI design pass (both rounds) and the stale-plan
 * path in `lib/photo-book-content.ts`, which uses it to keep an AI/hand-edited plan alive
 * across a photo being excluded instead of regenerating the book from scratch.
 */

/* ──────────────────────────────────────────────────────────────────────────────
 * Lenient parsing (`coercePhotoBookPlan`) — the step BEFORE repair.
 *
 * `validatePhotoBookPlan`'s zod schema enforces each template's photo arity structurally
 * (`assetIds: z.array(z.string()).length(4)` for a `collage-4`, …). That is the right call
 * for a stored plan, but it means a model that puts three photos under a `collage-4`
 * produces something zod rejects outright — there is no plan object to hand to
 * `repairPhotoBookPlan` at all, and the whole design falls back to the auto layout over one
 * miscounted page. So the model's raw JSON goes through this first: it reads what the model
 * meant, re-groups anything with the wrong arity into legal pages, and emits a plan that is
 * schema-valid BY CONSTRUCTION. Content-level problems (unknown ids, duplicates, a missing
 * hero) are left for `repairPhotoBookPlan` below.
 * ────────────────────────────────────────────────────────────────────────────── */

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export interface PhotoBookCoerceInput {
  photos: LintPhoto[];
  fallbackTitle: string;
  fallbackStyle: PhotoBookStyle;
}

/**
 * Reads a model's raw plan JSON into a schema-valid `PhotoBookPlan`, keeping everything it
 * can and quietly fixing what it must. Returns `null` only when there is nothing
 * plan-shaped there at all (not an object, or no sections array).
 */
export function coercePhotoBookPlan(
  raw: unknown,
  input: PhotoBookCoerceInput,
): PhotoBookRepairResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const rawSections = asArray(obj.sections);
  if (rawSections.length === 0 && !obj.cover) return null;

  const byId = new Map(input.photos.map((p) => [p.assetId, p]));
  const changes: string[] = [];

  const styleValue = asString(obj.style);
  const style = (PHOTO_BOOK_STYLES as readonly string[]).includes(styleValue ?? '')
    ? (styleValue as PhotoBookStyle)
    : input.fallbackStyle;

  const rawCover = (obj.cover && typeof obj.cover === 'object' ? obj.cover : {}) as Record<string, unknown>;
  const cover: PhotoBookPlan['cover'] = { title: asString(rawCover.title) ?? input.fallbackTitle };
  const subtitle = asString(rawCover.subtitle);
  if (subtitle) cover.subtitle = subtitle;
  const hero = asString(rawCover.heroAssetId);
  if (hero) cover.heroAssetId = hero;
  const backIds = asArray(rawCover.backAssetIds)
    .map(asString)
    .filter((id): id is string => id != null)
    .slice(0, 3);
  if (backIds.length > 0) cover.backAssetIds = backIds;

  const sections: PhotoSectionPlan[] = [];
  rawSections.forEach((rawSection, si) => {
    if (!rawSection || typeof rawSection !== 'object') return;
    const s = rawSection as Record<string, unknown>;
    const title = asString(s.title) ?? `Kapitel ${si + 1}`;
    const dateLabel = asString(s.dateLabel);

    const pages: PhotoPagePlan[] = [];
    for (const rawPage of asArray(s.pages)) {
      if (!rawPage || typeof rawPage !== 'object') continue;
      const p = rawPage as Record<string, unknown>;
      const templateValue = asString(p.template);
      const template = (PHOTO_PAGE_TEMPLATES as readonly string[]).includes(templateValue ?? '')
        ? (templateValue as PhotoPageTemplate)
        : null;
      const assetIds = asArray(p.assetIds)
        .map(asString)
        .filter((id): id is string => id != null);
      const rawCaptions = asArray(p.captions);
      const captionFor = new Map<string, string | null>();
      assetIds.forEach((id, i) => captionFor.set(id, asString(rawCaptions[i])));

      // A model-emitted `divider` page is never kept as one: the real section-title page
      // is added automatically per section, so a photo-less divider renders as a BLANK
      // page (the empty-pages bug this guards against), and one with a photo is better
      // shown as a real photo page — fall through to the generic re-grouping below.
      if (template === 'divider' && assetIds.length === 0) {
        changes.push(`dropped a blank divider page in "${title}" (sections get their title page automatically)`);
        continue;
      }
      if (assetIds.length === 0) {
        changes.push(`dropped a page in "${title}" that listed no photos`);
        continue;
      }

      const slots = template && template !== 'divider' ? PHOTO_PAGE_TEMPLATE_SLOTS[template] : null;
      const arityOk = slots != null && assetIds.length >= slots.min && assetIds.length <= slots.max;
      if (arityOk && template) {
        pages.push(withCaptions({ template, assetIds } as PhotoPagePlan, captionFor));
        continue;
      }

      // Wrong (or missing) template for this many photos — re-group into legal pages
      // instead of throwing the page away. This is the single most common model slip.
      if (template) {
        changes.push(
          `re-grouped a "${template}" page in "${title}" that listed ${assetIds.length} photo(s)`,
        );
      }
      let offset = 0;
      for (const size of pageSizes(assetIds.length)) {
        const group = assetIds
          .slice(offset, offset + size)
          .map((id) => byId.get(id))
          .filter((photo): photo is LintPhoto => photo != null);
        offset += size;
        if (group.length === 0) continue;
        const fitted = templateForGroup(group);
        pages.push(
          withCaptions(
            { template: fitted.template, assetIds: fitted.ordered.map((g) => g.assetId) } as PhotoPagePlan,
            captionFor,
          ),
        );
      }
    }

    if (pages.length === 0) return;
    sections.push(dateLabel ? { title, dateLabel, pages } : { title, pages });
  });

  return { plan: { kind: 'photo', style, cover, sections }, changes };
}

/** Attaches the captions a page's photos carry, dropping them where the template won't
 *  render them and always keeping the schema's "one caption per photo" arity. */
function withCaptions(page: PhotoPagePlan, captionFor: Map<string, string | null>): PhotoPagePlan {
  if (!rendersCaptions(page.template)) return page;
  const captions = page.assetIds.map((id) => captionFor.get(id) ?? null);
  return captions.some((c) => c) ? ({ ...page, captions } as PhotoPagePlan) : page;
}

export interface PhotoBookRepairInput {
  /** Every photo currently available to the layout (`book_photos.excluded = false`), with
   *  dimensions — the same set `checkPhotoBookPlanConsistency` calls `availableAssetIds`,
   *  plus the shapes needed to re-pick a template. */
  photos: LintPhoto[];
  /** Photos the user explicitly re-included (`book_photos.user_decision = 'include'`) —
   *  these MUST end up somewhere in the plan; any that the incoming plan omits are
   *  appended (see `appendMissingPhotos` below). */
  mustInclude?: string[];
}

export interface PhotoBookRepairResult {
  plan: PhotoBookPlan;
  /** One line per repair actually performed, for the log — empty when nothing changed. */
  changes: string[];
}

/** The shared definitions — see `photoOrientation`'s doc comment in
 *  `lib/photo-book-plan.ts` for why these live in exactly one place. */
const orientationOf = photoOrientation;
const rendersCaptions = templateRendersCaptions;

/**
 * The best template for a given set of photos — the shared "which layout fits these
 * shapes" decision, encoding exactly the rules `TEMPLATE_SHAPE_RULES`
 * (`lib/photo-book-lint.ts`) checks for, so a repaired page is always lint-clean by
 * construction. Also returns the photo ORDER the template wants (`three-mixed` needs its
 * landscape first — that slot is the dominant one).
 *
 * Only ever called with 1-6 photos; `pageSizes` below is what guarantees that.
 */
export function templateForGroup(input: LintPhoto[]): { template: PhotoPageTemplate; ordered: LintPhoto[] } {
  // Deduplicate FIRST, and pick the template from what survives. A model that lists the
  // same photo twice on one page used to slip through here and come out as a `three-mixed`
  // holding only two ids (the landscape-promotion below filtered by assetId, which removed
  // both copies of the repeated one) — a schema-invalid page that failed validation and
  // took the entire design down with it, which is precisely the single-duplicate failure
  // this module exists to absorb.
  const seen = new Set<string>();
  const photos = input.filter((p) => !seen.has(p.assetId) && seen.add(p.assetId));
  const shapes = photos.map(orientationOf);
  // Index-based, so promotion can never depend on assetId uniqueness again.
  const landscapeIndex = shapes.indexOf('landscape');

  switch (photos.length) {
    case 1:
      // Mirrors `singleTemplate` in `lib/photo-book-autolayout.ts`: a landscape fills an
      // edge-to-edge page well, a portrait reads better matted.
      return { template: shapes[0] === 'landscape' ? 'full-bleed' : 'full-framed', ordered: photos };
    case 2:
      // All landscape/square → stacked full-width; anything with a portrait in it → the
      // justified side-by-side row, which handles a mixed pair gracefully.
      return shapes.every((s) => s !== 'portrait')
        ? { template: 'two-horizontal', ordered: photos }
        : { template: 'two-vertical', ordered: photos };
    case 3:
      // A single landscape ruins a 3-up justified row (see `three-column`'s rule) — those
      // trios become `three-mixed` with the landscape promoted to the dominant slot.
      return landscapeIndex >= 0
        ? {
            template: 'three-mixed',
            ordered: [photos[landscapeIndex], ...photos.filter((_, i) => i !== landscapeIndex)],
          }
        : { template: 'three-column', ordered: photos };
    case 4:
      // Exactly one landscape among four reads best as the dominant full-width photo with
      // the other three justified below it; any other mix balances fine as a 2+2 grid.
      return shapes.filter((s) => s === 'landscape').length === 1
        ? {
            template: 'four-mixed',
            ordered: [photos[landscapeIndex], ...photos.filter((_, i) => i !== landscapeIndex)],
          }
        : { template: 'collage-4', ordered: photos };
    case 5:
      return { template: 'collage-5', ordered: photos };
    default:
      return { template: 'collage-6', ordered: photos };
  }
}

/** Splits n photos into page-sized groups of 1-6, never leaving a group of exactly 1 when
 *  it can be avoided — the same "never strand a lone leftover" rule `paceSection`
 *  (`lib/photo-book-autolayout.ts`) applies. */
function pageSizes(n: number): number[] {
  const sizes: number[] = [];
  let left = n;
  while (left > 0) {
    if (left <= 6) {
      sizes.push(left);
      break;
    }
    // Leaves a remainder of 0, 3, 4 or 5 — never 1 or 2 stranded on their own.
    const take = left % 3 === 1 ? 4 : 3;
    sizes.push(take);
    left -= take;
  }
  return sizes;
}

/** Rebuilds one page around the photos that survived filtering: re-picks the template for
 *  the new count/shapes and carries the captions of the surviving photos along (dropped
 *  entirely when the new template can't render them). Returns `null` when nothing is left
 *  to show.
 *
 *  A page whose photo set is intact AND whose template already fits those shapes comes back
 *  untouched — the producer's own choice wins wherever it isn't broken. `full-bleed` vs
 *  `full-framed` for a single photo is exactly that kind of judgment call: both render a
 *  portrait fine, and a design pass that deliberately chose the edge-to-edge one shouldn't
 *  have it quietly rewritten. */
function rebuildPage(page: PhotoPagePlan, survivors: LintPhoto[]): PhotoPagePlan | null {
  if (survivors.length === 0) return null;
  const intact = survivors.length === page.assetIds.length;
  const captionsOk = !page.captions || page.captions.length === page.assetIds.length;
  // Arity is checked HERE and not assumed: this function's whole promise is that what it
  // returns satisfies `checkPhotoBookPlanConsistency`, and an incoming page can already
  // violate its template's slot count (a hand-edited stored plan, or a page an earlier
  // coercion mis-grouped). Without this the fast path below waved such a page straight
  // through and repair silently failed to repair it.
  const slots = PHOTO_PAGE_TEMPLATE_SLOTS[page.template];
  const arityOk = survivors.length >= slots.min && survivors.length <= slots.max;
  if (intact && captionsOk && arityOk && templateFits(page.template, survivors)) return page;

  const captionFor = new Map<string, string | null>();
  page.assetIds.forEach((id, i) => captionFor.set(id, page.captions?.[i] ?? null));

  const { template, ordered } = templateForGroup(survivors);
  const next: PhotoPagePlan = { template, assetIds: ordered.map((p) => p.assetId) } as PhotoPagePlan;
  if (rendersCaptions(template)) {
    const captions = ordered.map((p) => captionFor.get(p.assetId) ?? null);
    if (captions.some((c) => c)) next.captions = captions;
  }
  return next;
}

/** Places photos the plan left out but must contain, as extra pages on the last section
 *  (or a new trailing one when the plan has no sections at all). */
function appendMissingPhotos(
  sections: PhotoSectionPlan[],
  missing: LintPhoto[],
  fallbackTitle: string,
): PhotoSectionPlan[] {
  if (missing.length === 0) return sections;
  const pages: PhotoPagePlan[] = [];
  let offset = 0;
  for (const size of pageSizes(missing.length)) {
    const group = missing.slice(offset, offset + size);
    offset += size;
    const { template, ordered } = templateForGroup(group);
    pages.push({ template, assetIds: ordered.map((p) => p.assetId) } as PhotoPagePlan);
  }
  if (sections.length === 0) return [{ title: fallbackTitle, pages }];
  const last = sections[sections.length - 1];
  return [...sections.slice(0, -1), { ...last, pages: [...last.pages, ...pages] }];
}

/**
 * Repairs `plan` against the book's current photos. Guarantees the returned plan satisfies
 * `checkPhotoBookPlanConsistency` for the same photo set, and that every `mustInclude`
 * photo is placed. Never throws.
 */
export function repairPhotoBookPlan(plan: PhotoBookPlan, input: PhotoBookRepairInput): PhotoBookRepairResult {
  const byId = new Map(input.photos.map((p) => [p.assetId, p]));
  const changes: string[] = [];
  /** Every id already spoken for — the plan may place a photo at most once anywhere. */
  const used = new Set<string>();

  function claim(id: string): LintPhoto | null {
    if (used.has(id)) return null;
    const photo = byId.get(id);
    if (!photo) return null;
    used.add(id);
    return photo;
  }

  // ── Cover ────────────────────────────────────────────────────────────────────
  const cover: PhotoBookPlan['cover'] = { ...plan.cover };
  if (cover.heroAssetId && !claim(cover.heroAssetId)) {
    changes.push(`dropped cover hero ${cover.heroAssetId} (not an available photo)`);
    delete cover.heroAssetId;
  }
  if (cover.backAssetIds) {
    const kept = cover.backAssetIds.filter((id) => claim(id) != null).slice(0, 3);
    if (kept.length !== cover.backAssetIds.length) {
      changes.push(`dropped ${cover.backAssetIds.length - kept.length} unusable back-cover photo(s)`);
    }
    if (kept.length > 0) cover.backAssetIds = kept;
    else delete cover.backAssetIds;
  }

  // ── Sections / pages ─────────────────────────────────────────────────────────
  const sections: PhotoSectionPlan[] = [];
  for (const section of plan.sections) {
    const pages: PhotoPagePlan[] = [];
    for (const page of section.pages) {
      const survivors = page.assetIds.map(claim).filter((p): p is LintPhoto => p != null);
      // A page with nothing left to show is dropped, dividers included: a photo-less
      // divider renders as a completely blank page (the section's real title page is
      // emitted automatically), and a printed book must never contain blank pages.
      if (survivors.length === 0) {
        changes.push(
          page.template === 'divider'
            ? `dropped a blank divider page in "${section.title}"`
            : `dropped a ${page.template} page in "${section.title}" (no usable photos left)`,
        );
        continue;
      }
      if (page.template === 'divider') {
        pages.push({ template: 'divider', assetIds: [survivors[0].assetId] });
        continue;
      }
      const rebuilt = rebuildPage(page, survivors);
      if (!rebuilt) continue;
      if (rebuilt.template !== page.template || rebuilt.assetIds.length !== page.assetIds.length) {
        changes.push(
          `re-fitted a page in "${section.title}": ${page.template} (${page.assetIds.length} photos) → ${rebuilt.template} (${rebuilt.assetIds.length} photos)`,
        );
      }
      pages.push(rebuilt);
    }
    if (pages.length === 0) {
      changes.push(`dropped empty section "${section.title}"`);
      continue;
    }
    sections.push({ ...section, pages });
  }

  // ── Force-included photos ────────────────────────────────────────────────────
  const missing = (input.mustInclude ?? [])
    .filter((id) => !used.has(id))
    .map((id) => byId.get(id))
    .filter((p): p is LintPhoto => p != null);
  let repaired = appendMissingPhotos(sections, missing, plan.sections[0]?.title ?? 'Weitere Fotos');
  if (missing.length > 0) {
    changes.push(`placed ${missing.length} photo(s) the user re-included but the plan had left out`);
    for (const p of missing) used.add(p.assetId);
  }

  // ── Cover hero of last resort ────────────────────────────────────────────────
  // A book with content must have a front-cover photo (`checkPhotoBookPlanConsistency`).
  // Prefer an unplaced photo so no page has to be rebuilt; only borrow from page one when
  // every available photo is already spoken for.
  const hasContent = repaired.some((s) => s.pages.length > 0);
  if (hasContent && !cover.heroAssetId) {
    const spare = input.photos.find((p) => !used.has(p.assetId));
    if (spare) {
      cover.heroAssetId = spare.assetId;
      used.add(spare.assetId);
      changes.push(`picked ${spare.assetId} as the cover hero (the plan had none)`);
    } else {
      // Borrow from the first page that actually HOLDS a photo — not simply the first page,
      // which may be a photo-less `divider`. Taking `assetIds[0]` off one of those set the
      // hero to `undefined` while the book still had content, so the plan failed the
      // "content needs a cover" consistency rule and was thrown away — in the stale-plan
      // path that meant the AI design got overwritten by the auto layout, the exact
      // destruction this module exists to prevent.
      const si = repaired.findIndex((s) => s.pages.some((p) => p.assetIds.length > 0));
      const pi = si >= 0 ? repaired[si].pages.findIndex((p) => p.assetIds.length > 0) : -1;
      if (si >= 0 && pi >= 0) {
        const donor = repaired[si].pages[pi];
        const borrowedId = donor.assetIds[0];
        const remaining = donor.assetIds
          .slice(1)
          .map((id) => byId.get(id))
          .filter((p): p is LintPhoto => p != null);
        const rebuilt = remaining.length > 0 ? rebuildPage(donor, remaining) : null;
        const pages = rebuilt
          ? repaired[si].pages.map((p, i) => (i === pi ? rebuilt : p))
          : repaired[si].pages.filter((_, i) => i !== pi);
        repaired =
          pages.length > 0
            ? repaired.map((s, i) => (i === si ? { ...s, pages } : s))
            : repaired.filter((_, i) => i !== si);
        cover.heroAssetId = borrowedId;
        changes.push(`promoted ${borrowedId} from a section page to the cover hero (the plan had none)`);
      } else {
        // Every remaining page is a photo-less divider, so there is no hero to be had and
        // nothing to show. Drop those pages rather than return a plan that claims content
        // it can't cover — an empty plan is at least a legal one, and the caller treats it
        // as "nothing usable here" (`photoBookPlanHasContent`, `lib/photo-book-plan.ts`).
        changes.push('dropped section openers that had no photos left to open');
        repaired = [];
      }
    }
  }

  return { plan: { ...plan, cover, sections: repaired }, changes };
}
