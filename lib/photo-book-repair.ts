import {
  isTextItem,
  photoBookTemplate,
  PHOTO_BOOK_TEMPLATES,
  PHOTO_BOOK_STYLES,
  PHOTO_PAGE_TEMPLATES,
  PHOTO_PAGE_TEMPLATE_SLOTS,
  templateRendersCaptions,
  type PhotoBookPlan,
  type PhotoBookStyle,
  type PhotoBookTemplate,
  type PhotoFlowItem,
  type PhotoPagePlan,
  type PhotoPageTemplate,
  type PhotoSectionPlan,
  type TextBlockPlan,
} from '@/lib/photo-book-plan';
import { templateFits, type LintPhoto } from '@/lib/photo-book-lint';
import {
  bestPhotoPageForGroup,
  MIN_AREA_RATIO_IMPROVEMENT,
  MIN_MULTI_PHOTO_AREA_RATIO,
  photoBookContentBox,
  photoPageAreaRatio,
} from '@/lib/photo-book-fit';
import { coverCropRetention, MIN_SAFE_COVER_RETENTION, TEMPLATE_ROW_ARRANGEMENT } from '@/lib/photo-book-layout';

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
  fallbackTemplate?: PhotoBookTemplate;
  /** The book's story chapters (unified-book plan). Story content is only accepted when
   *  the caller declares it: without this, a `storyId` (and any text run under it) the
   *  model invented is stripped rather than persisted — otherwise a hallucinated id
   *  would slip past `checkPhotoBookPlanConsistency` (which skips every text rule when
   *  it gets no `stories`) and make the renderer emit a TOC for chapters that
   *  don't exist. Only ids present here survive. */
  stories?: Array<{ storyId: string }>;
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
  const knownStoryIds = new Set((input.stories ?? []).map((s) => s.storyId));
  const changes: string[] = [];

  const styleValue = asString(obj.style);
  const style = (PHOTO_BOOK_STYLES as readonly string[]).includes(styleValue ?? '')
    ? (styleValue as PhotoBookStyle)
    : input.fallbackStyle;
  const templateValue = asString(obj.template);
  // When the caller supplies a template it is authoritative book metadata, not a model
  // design choice. Raw JSON is only consulted by generic import/repair callers that do
  // not already know the owning book's structural recipe.
  const bookTemplate = input.fallbackTemplate ??
    ((PHOTO_BOOK_TEMPLATES as readonly string[]).includes(templateValue ?? '')
      ? (templateValue as PhotoBookTemplate)
      : undefined);

  const rawCover = (obj.cover && typeof obj.cover === 'object' ? obj.cover : {}) as Record<string, unknown>;
  const cover: PhotoBookPlan['cover'] = { title: asString(rawCover.title) ?? input.fallbackTitle };
  const subtitle = asString(rawCover.subtitle);
  if (subtitle) cover.subtitle = subtitle;
  const hero = asString(rawCover.heroAssetId);
  if (hero) cover.heroAssetId = hero;
  const coverAssetIds = asArray(rawCover.assetIds)
    .map(asString)
    .filter((id): id is string => id != null)
    .filter((id, index, ids) => ids.indexOf(id) === index)
    .slice(0, 6);
  if (coverAssetIds.length > 0) cover.assetIds = coverAssetIds;
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
    const claimedStoryId = asString(s.storyId);
    // Only a story the CALLER declared may be referenced — see `stories` above.
    const storyId = claimedStoryId && knownStoryIds.has(claimedStoryId) ? claimedStoryId : null;
    if (claimedStoryId && !storyId) {
      changes.push(`stripped unknown story ${claimedStoryId} from "${title}"`);
    }

    const pages: PhotoFlowItem[] = [];
    for (const rawPage of asArray(s.pages)) {
      if (!rawPage || typeof rawPage !== 'object') continue;
      const p = rawPage as Record<string, unknown>;
      const templateValue = asString(p.template) ?? asString(p.type);

      // A flowing text run (unified-book plan). Tolerate sloppy ranges — the repair
      // pass re-covers paragraph ranges mechanically anyway — but only in a section
      // that names a story; text without a story has nothing to flow.
      if (templateValue === 'text') {
        if (!storyId) {
          changes.push(`dropped a text block in "${title}" (section names no story)`);
          continue;
        }
        const from = asIndex(p.from) ?? 0;
        const to = asIndex(p.to) ?? from;
        pages.push({ template: 'text', from, to: Math.max(from, to) });
        continue;
      }

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
        const fitted = templateForGroup(group, undefined, captionFor);
        pages.push(
          withCaptions(
            { template: fitted.template, assetIds: fitted.ordered.map((g) => g.assetId) } as PhotoPagePlan,
            captionFor,
          ),
        );
      }
    }

    if (pages.length === 0) return;
    sections.push({
      title,
      ...(dateLabel ? { dateLabel } : {}),
      ...(storyId ? { storyId } : {}),
      pages,
    });
  });

  return {
    plan: { kind: 'photo', ...(bookTemplate ? { template: bookTemplate } : {}), style, cover, sections },
    changes,
  };
}

function asIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
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
  photos: Array<LintPhoto & { storyId?: string | null }>;
  /** Photos the user explicitly re-included (`book_photos.user_decision = 'include'`) —
   *  these MUST end up somewhere in the plan; any that the incoming plan omits are
   *  appended (see `appendMissingPhotos` below). */
  mustInclude?: string[];
  /** The book's story chapters with text included (unified-book plan) — when provided,
   *  text coverage is repaired mechanically: every listed story ends up with exactly one
   *  section covering its paragraphs 0..n-1 gap-free (see `repairTextCoverage`). */
  stories?: Array<{ storyId: string; paragraphCount: number; title?: string }>;
  /** Actual book trim for aspect-aware fitting. Defaults to portrait 21x28. */
  trim?: { w: number; h: number };
}

export interface PhotoBookRepairResult {
  plan: PhotoBookPlan;
  /** One line per repair actually performed, for the log — empty when nothing changed. */
  changes: string[];
}

const rendersCaptions = templateRendersCaptions;

/**
 * The best template for a given set of photos — the shared aspect/area decision the
 * auto-layouter and linter use too, so a repaired page is lint-clean by construction.
 * It also returns the within-page order that makes the justified rows use the most area.
 *
 * Only ever called with 1-6 photos; `pageSizes` below is what guarantees that.
 */
export function templateForGroup(
  input: LintPhoto[],
  trim: { w: number; h: number } = { w: 210, h: 280 },
  captionFor?: Map<string, string | null>,
): { template: PhotoPageTemplate; ordered: LintPhoto[] } {
  // Deduplicate FIRST, and pick the template from what survives. A model that lists the
  // same photo twice on one page used to slip through here and come out as a `three-mixed`
  // holding only two ids (the landscape-promotion below filtered by assetId, which removed
  // both copies of the repeated one) — a schema-invalid page that failed validation and
  // took the entire design down with it, which is precisely the single-duplicate failure
  // this module exists to absorb.
  const seen = new Set<string>();
  const photos = input
    .filter((p) => !seen.has(p.assetId) && seen.add(p.assetId))
    .map((photo) => ({ ...photo, captioned: !!captionFor?.get(photo.assetId) }));
  const fitted = bestPhotoPageForGroup(photos, trim);
  return { template: fitted.template, ordered: fitted.ordered };
}

function pageFitsWell(
  page: PhotoPagePlan,
  photos: LintPhoto[],
  trim: { w: number; h: number },
): boolean {
  if (!templateFits(page.template, photos)) return false;
  if (page.template === 'full-bleed') {
    const photo = photos[0];
    return !!photo && coverCropRetention(photo.width / photo.height, trim.w / trim.h) >= MIN_SAFE_COVER_RETENTION;
  }
  if (!TEMPLATE_ROW_ARRANGEMENT[page.template]) return true;
  const captionFor = new Map(page.assetIds.map((id, index) => [id, page.captions?.[index] ?? null]));
  const measured = photos.map((photo) => ({ ...photo, captioned: !!captionFor.get(photo.assetId) }));
  const box = photoBookContentBox(trim);
  const current = photoPageAreaRatio(page.template, measured, box);
  const best = bestPhotoPageForGroup(measured, trim);
  return current >= MIN_MULTI_PHOTO_AREA_RATIO && best.areaRatio - current < MIN_AREA_RATIO_IMPROVEMENT;
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
function rebuildPage(
  page: PhotoPagePlan,
  survivors: LintPhoto[],
  trim: { w: number; h: number },
): PhotoPagePlan | null {
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
  if (intact && captionsOk && arityOk && pageFitsWell(page, survivors, trim)) return page;

  const captionFor = new Map<string, string | null>();
  page.assetIds.forEach((id, i) => captionFor.set(id, page.captions?.[i] ?? null));

  const { template, ordered } = templateForGroup(survivors, trim, captionFor);
  const next: PhotoPagePlan = { template, assetIds: ordered.map((p) => p.assetId) } as PhotoPagePlan;
  if (rendersCaptions(template)) {
    const captions = ordered.map((p) => captionFor.get(p.assetId) ?? null);
    if (captions.some((c) => c)) next.captions = captions;
  }
  return next;
}

/** Places photos the plan left out but must contain. Birthday photos return to their own
 * story section (creating it when a newly attached story is absent from the stale plan);
 * unowned uploads get a separate trailing photo section. */
function appendMissingPhotos(
  sections: PhotoSectionPlan[],
  missing: Array<LintPhoto & { storyId?: string | null }>,
  fallbackTitle: string,
  trim: { w: number; h: number },
  placeByStory: boolean,
  stories?: PhotoBookRepairInput['stories'],
): PhotoSectionPlan[] {
  if (missing.length === 0) return sections;
  if (placeByStory) {
    const out = sections.slice();
    const groups = new Map<string | null, Array<LintPhoto & { storyId?: string | null }>>();
    for (const photo of missing) {
      const key = photo.storyId ?? null;
      groups.set(key, [...(groups.get(key) ?? []), photo]);
    }
    for (const [storyId, photos] of groups) {
      const pages = pagesForPhotos(photos, trim);
      const index = storyId ? out.findIndex((section) => section.storyId === storyId) : -1;
      if (index >= 0) {
        out[index] = { ...out[index], pages: [...out[index].pages, ...pages] };
      } else {
        const story = storyId ? stories?.find((candidate) => candidate.storyId === storyId) : null;
        if (storyId && story) {
          out.push({
            title: story.title?.trim() || fallbackTitle,
            storyId,
            pages,
          });
          continue;
        }
        let unownedIndex = -1;
        for (let i = out.length - 1; i >= 0; i--) {
          if (!out[i].storyId) {
            unownedIndex = i;
            break;
          }
        }
        if (unownedIndex >= 0) {
          out[unownedIndex] = {
            ...out[unownedIndex],
            pages: [...out[unownedIndex].pages, ...pages],
          };
        } else {
          out.push({ title: fallbackTitle, pages });
        }
      }
    }
    return out;
  }
  const pages = pagesForPhotos(missing, trim);
  if (sections.length === 0) return [{ title: fallbackTitle, pages }];
  const last = sections[sections.length - 1];
  return [...sections.slice(0, -1), { ...last, pages: [...last.pages, ...pages] }];
}

function pagesForPhotos(
  photos: LintPhoto[],
  trim: { w: number; h: number },
): PhotoPagePlan[] {
  const pages: PhotoPagePlan[] = [];
  let offset = 0;
  for (const size of pageSizes(photos.length)) {
    const group = photos.slice(offset, offset + size);
    offset += size;
    const { template, ordered } = templateForGroup(group, trim);
    pages.push({ template, assetIds: ordered.map((p) => p.assetId) } as PhotoPagePlan);
  }
  return pages;
}

/**
 * Repairs `plan` against the book's current photos. Guarantees the returned plan satisfies
 * `checkPhotoBookPlanConsistency` for the same photo set, and that every `mustInclude`
 * photo is placed. Never throws.
 */
export function repairPhotoBookPlan(plan: PhotoBookPlan, input: PhotoBookRepairInput): PhotoBookRepairResult {
  const trim = input.trim ?? { w: 210, h: 280 };
  const byId = new Map(input.photos.map((p) => [p.assetId, p]));
  const changes: string[] = [];
  /** Every id already spoken for — the plan may place a photo at most once anywhere. */
  const used = new Set<string>();
  const birthday = photoBookTemplate(plan) === 'birthday';

  function claim(id: string): LintPhoto | null {
    if (used.has(id)) return null;
    const photo = byId.get(id);
    if (!photo) return null;
    used.add(id);
    return photo;
  }

  // ── Cover ────────────────────────────────────────────────────────────────────
  const cover: PhotoBookPlan['cover'] = { ...plan.cover };
  if (birthday) {
    const requested = cover.assetIds ?? (cover.heroAssetId ? [cover.heroAssetId] : []);
    const kept = requested
      .filter((id, index, ids) => byId.has(id) && ids.indexOf(id) === index)
      .slice(0, 6);
    if (kept.length !== requested.length) {
      changes.push(`dropped ${requested.length - kept.length} unusable Birthday cover photo(s)`);
    }
    if (kept.length > 0) {
      cover.assetIds = kept;
      cover.heroAssetId = kept[0];
    } else {
      delete cover.assetIds;
      delete cover.heroAssetId;
    }
  } else if (cover.heroAssetId && !claim(cover.heroAssetId)) {
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
    const pages: PhotoFlowItem[] = [];
    for (const page of section.pages) {
      // Text runs hold no photos — they pass through here untouched; their paragraph
      // coverage is repaired as a whole by `repairTextCoverage` below.
      if (isTextItem(page)) {
        pages.push(page);
        continue;
      }
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

      // Five/six very wide photos have no better legal same-count template: their
      // collage is necessarily two contact strips. Split those dense legacy pages into
      // a fitted trio plus pair/trio so existing books gain the same protection as newly
      // auto-laid-out books.
      const rows = TEMPLATE_ROW_ARRANGEMENT[page.template];
      if (survivors.length >= 5 && rows) {
        const captionFor = new Map<string, string | null>();
        page.assetIds.forEach((id, i) => captionFor.set(id, page.captions?.[i] ?? null));
        const measured = survivors.map((photo) => ({ ...photo, captioned: !!captionFor.get(photo.assetId) }));
        const current = photoPageAreaRatio(page.template, measured, photoBookContentBox(trim));
        if (current < MIN_MULTI_PHOTO_AREA_RATIO) {
          const splitAt = 3;
          for (const group of [survivors.slice(0, splitAt), survivors.slice(splitAt)]) {
            const fitted = templateForGroup(group, trim, captionFor);
            pages.push(
              withCaptions(
                {
                  template: fitted.template,
                  assetIds: fitted.ordered.map((photo) => photo.assetId),
                } as PhotoPagePlan,
                captionFor,
              ),
            );
          }
          changes.push(
            `split a poorly fitted ${page.template} page in "${section.title}" into two fuller pages`,
          );
          continue;
        }
      }

      const rebuilt = rebuildPage(page, survivors, trim);
      if (!rebuilt) continue;
      const refitted =
        rebuilt.template !== page.template ||
        rebuilt.assetIds.length !== page.assetIds.length ||
        rebuilt.assetIds.some((id, index) => id !== page.assetIds[index]);
      if (refitted) {
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
    .filter((p): p is LintPhoto & { storyId?: string | null } => p != null);
  let repaired = appendMissingPhotos(
    sections,
    missing,
    plan.sections[0]?.title ?? 'Weitere Fotos',
    trim,
    birthday,
    input.stories,
  );
  if (missing.length > 0) {
    changes.push(`placed ${missing.length} photo(s) the user re-included but the plan had left out`);
    for (const p of missing) used.add(p.assetId);
  }

  // ── Text coverage (unified-book plan) ────────────────────────────────────────
  repaired = repairTextCoverage(repaired, input.stories, changes);

  if (birthday) {
    repaired = repaired.map((section) => {
      if (!section.storyId) return section;
      const text = section.pages.filter(isTextItem);
      const photos = section.pages.filter((item) => !isTextItem(item));
      if (text.length === 0 || photos.length === 0) return section;
      const first = text[0];
      const last = text[text.length - 1];
      return {
        ...section,
        pages: [{ template: 'text' as const, from: first.from, to: last.to }, ...photos],
      };
    });
  }

  // ── Cover hero of last resort ────────────────────────────────────────────────
  // A book with PHOTO content must have a front-cover photo
  // (`checkPhotoBookPlanConsistency`) — a text-only book has no photo a hero could be.
  // Prefer an unplaced photo so no page has to be rebuilt; only borrow from page one when
  // every available photo is already spoken for.
  const hasContent = repaired.some((s) => s.pages.some((p) => !isTextItem(p) && p.assetIds.length > 0));
  if (birthday && hasContent && (!cover.assetIds || cover.assetIds.length === 0)) {
    const picks = input.photos.slice(0, 6).map((photo) => photo.assetId);
    cover.assetIds = picks;
    cover.heroAssetId = picks[0];
    changes.push(`picked ${picks.length} Birthday cover photo(s) (the plan had none)`);
  } else if (!birthday && hasContent && !cover.heroAssetId) {
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
      const holdsPhoto = (p: PhotoFlowItem) => !isTextItem(p) && p.assetIds.length > 0;
      const si = repaired.findIndex((s) => s.pages.some(holdsPhoto));
      const pi = si >= 0 ? repaired[si].pages.findIndex(holdsPhoto) : -1;
      if (si >= 0 && pi >= 0) {
        const donor = repaired[si].pages[pi] as PhotoPagePlan;
        const borrowedId = donor.assetIds[0];
        const remaining = donor.assetIds
          .slice(1)
          .map((id) => byId.get(id))
          .filter((p): p is LintPhoto => p != null);
        const rebuilt = remaining.length > 0 ? rebuildPage(donor, remaining, trim) : null;
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

/** Contiguous, gap-free split of paragraphs 0..n-1 into k ranges of near-equal size —
 *  consistent by construction, so a re-covered section always passes the text rules in
 *  `checkPhotoBookPlanConsistency`. */
function evenTextRanges(paragraphCount: number, blocks: number): TextBlockPlan[] {
  const k = Math.min(Math.max(1, blocks), paragraphCount);
  const ranges: TextBlockPlan[] = [];
  let from = 0;
  for (let i = 0; i < k; i++) {
    const size = Math.ceil((paragraphCount - from) / (k - i));
    ranges.push({ template: 'text', from, to: from + size - 1 });
    from += size;
  }
  return ranges;
}

/**
 * Mechanically repairs the plan's text coverage against the book's actual story
 * chapters (unified-book plan): after this pass, every listed story has exactly one
 * section whose text items cover paragraphs 0..n-1 in order with no gaps or overlaps —
 * the same "drop what can't be shown, renumber what's left" philosophy as the photo
 * repair above. Keeps the producer's text-break POSITIONS (how many runs, where photo
 * pages interleave) whenever coverage is broken, redistributing the paragraphs evenly
 * across the existing runs; only invents structure (one run covering everything) when a
 * story has no section or no runs at all. A no-op when `stories` is not provided.
 */
function repairTextCoverage(
  sections: PhotoSectionPlan[],
  stories: PhotoBookRepairInput['stories'],
  changes: string[],
): PhotoSectionPlan[] {
  if (!stories) return sections;
  const known = new Map(stories.map((s) => [s.storyId, s]));
  const claimed = new Set<string>();

  const out: PhotoSectionPlan[] = [];
  for (const section of sections) {
    if (!section.storyId) {
      const pages = section.pages.filter((p) => !isTextItem(p));
      if (pages.length !== section.pages.length) {
        changes.push(`dropped text block(s) in "${section.title}" (section names no story)`);
      }
      if (pages.length > 0) out.push({ ...section, pages });
      else changes.push(`dropped empty section "${section.title}"`);
      continue;
    }

    const story = known.get(section.storyId);
    if (!story || claimed.has(section.storyId)) {
      // Unknown story, or a second section for one already covered — degrade to a
      // plain photo section rather than double-print (or orphan) its text.
      changes.push(
        !story
          ? `stripped unknown story ${section.storyId} from "${section.title}"`
          : `merged duplicate section for story ${section.storyId} into a photo section`,
      );
      const pages = section.pages.filter((p) => !isTextItem(p));
      if (pages.length > 0) {
        out.push({
          title: section.title,
          ...(section.dateLabel ? { dateLabel: section.dateLabel } : {}),
          pages,
        });
      } else {
        changes.push(`dropped empty section "${section.title}"`);
      }
      continue;
    }
    claimed.add(section.storyId);

    if (story.paragraphCount === 0) {
      const pages = section.pages.filter((p) => !isTextItem(p));
      if (pages.length > 0) out.push({ ...section, pages });
      else changes.push(`dropped empty section "${section.title}" (story has no text)`);
      continue;
    }

    const textItems = section.pages.filter(isTextItem);
    let expected = 0;
    let intact = textItems.length > 0;
    for (const t of textItems) {
      if (t.from !== expected || t.from > t.to) {
        intact = false;
        break;
      }
      expected = t.to + 1;
    }
    if (intact && expected === story.paragraphCount) {
      out.push(section);
      continue;
    }

    const ranges = evenTextRanges(story.paragraphCount, textItems.length);
    let ri = 0;
    const pages: PhotoFlowItem[] = [];
    for (const item of section.pages) {
      if (!isTextItem(item)) {
        pages.push(item);
        continue;
      }
      if (ri < ranges.length) pages.push(ranges[ri++]);
      // More runs than paragraphs: the surplus runs simply disappear.
    }
    // No runs at all (ranges is then exactly one block covering everything): the story's
    // text opens the section, before its photo pages.
    if (textItems.length === 0) pages.unshift(ranges[0]);
    changes.push(
      `re-covered the text of "${section.title}" (${story.paragraphCount} paragraph(s) over ${ranges.length} run(s))`,
    );
    out.push({ ...section, pages });
  }

  // Stories the plan left out entirely get a plain text-only trailing section.
  for (const story of stories) {
    if (claimed.has(story.storyId) || story.paragraphCount === 0) continue;
    out.push({
      title: story.title?.trim() || 'Kapitel',
      storyId: story.storyId,
      pages: [{ template: 'text', from: 0, to: story.paragraphCount - 1 }],
    });
    changes.push(`added a section for story ${story.storyId} the plan had left out`);
  }

  return out;
}
