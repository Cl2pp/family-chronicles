import type { PhotoAnalysis } from '@/lib/photo-analysis';
import {
  CAPTION_LESS_TEMPLATES,
  photoOrientation,
  type PhotoBookPlan,
  type PhotoOrientation,
  type PhotoPageTemplate,
} from '@/lib/photo-book-plan';

/**
 * Deterministic design review of a finished `PhotoBookPlan` — "does this layout actually
 * WORK for these photos", as opposed to `checkPhotoBookPlanConsistency`
 * (`lib/photo-book-plan.ts`), which only asks "is this plan structurally legal".
 *
 * The distinction matters because the two feed different machinery: a consistency problem
 * makes a plan unusable (it gets repaired or discarded), whereas a lint finding describes
 * a plan that renders fine but reads badly — three landscape photos crammed into a
 * `three-column` row (the concrete complaint this module was written for: a landscape in a
 * justified 3-up row renders as a letterboxed sliver), six identical page templates in a
 * row, a book that left its best photo on the cutting-room floor.
 *
 * Two consumers, both in `lib/photo-book-ai-layout.ts`:
 *  1. The **self-review round**: the findings are handed straight back to the model
 *     alongside screenshots of its own laid-out pages, so it can fix them itself with the
 *     judgment a rule can't have (which photo to move, whether a section should split).
 *  2. **Scoring**: `lintScore` below reduces the findings to one number so the review
 *     round's output can be compared against its input and the WORSE one thrown away —
 *     without that, a review pass can silently make a book worse.
 *
 * Pure (no I/O, no model calls, no DB) — same reasoning as `lib/photo-book-autolayout.ts`:
 * everything here is unit-testable without a database or an API key.
 */

export type PhotoBookLintCode =
  /** A page's template needs a photo shape it didn't get (the three-column complaint). */
  | 'template-orientation'
  /** A page that renders with no photo on it — a blank page in a printed book. */
  | 'empty-page'
  /** The same page template repeated too many times back to back. */
  | 'monotonous-pacing'
  /** A section so short it doesn't earn its own divider/opener. */
  | 'section-too-short'
  /** Captions on a template whose renderer deliberately drops them. */
  | 'caption-not-rendered'
  /** A photo the vision pass rated highly that the plan never places. */
  | 'strong-photo-unplaced'
  /** A photo the vision pass rated poorly that the plan places anyway. */
  | 'weak-photo-placed';

export interface PhotoBookLintFinding {
  code: PhotoBookLintCode;
  /** Human-readable, written to be pasted straight into the review prompt. */
  message: string;
  /** Where the problem is, when it's tied to one page — 0-based, matching the plan's own
   *  array indices so the model can address `section 2, page 3` unambiguously. */
  sectionIndex?: number;
  pageIndex?: number;
}

/** The minimum a photo has to expose for this module — a subset of `AutoLayoutPhoto`
 *  (`lib/photo-book-autolayout.ts`) so both producers can pass their existing rows
 *  straight in. */
export interface LintPhoto {
  assetId: string;
  width: number;
  height: number;
  analysis?: PhotoAnalysis | null;
}

type Orientation = PhotoOrientation;

/** The one shared definition (`photoOrientation`, `lib/photo-book-plan.ts`) — see its doc
 *  comment for why the layouter, this check, the repair pass and the prompt must not each
 *  keep their own copy of the thresholds. */
const orientationOf = photoOrientation;

/**
 * Which photo shapes each template actually renders well, and why — the single source of
 * truth for both this linter and the vocabulary the model is given
 * (`lib/photo-book-ai-layout.ts`'s `templateVocabularyText`), so the prompt can never drift
 * from the rule the output is checked against.
 *
 * `null` means "any shape works": `collage-*` tiles and `full-framed`'s mat crop or letterbox
 * gracefully at any aspect ratio, and `divider` renders its photo as a muted full-page
 * backdrop.
 */
export interface TemplateShapeRule {
  allowed: Orientation[];
  /** Which slots the rule applies to — `'first'` for templates where only the dominant
   *  photo's shape matters (`three-mixed`). */
  slots: 'all' | 'first';
  /** `'any'` — one wrong-shaped photo already breaks the page (a landscape in a 3-up row
   *  squashes all three). `'all'` — the template is only the wrong choice when EVERY photo
   *  disagrees with it (a mixed portrait+landscape pair is genuinely fine in a justified
   *  row; two landscapes there are not, they belong stacked). */
  flagWhen: 'any' | 'all';
  why: string;
}

export const TEMPLATE_SHAPE_RULES: Record<PhotoPageTemplate, TemplateShapeRule | null> = {
  'full-bleed': null,
  'full-framed': null,
  // Two photos stacked, each rendered full-width at its true shape — a portrait one
  // towers over the page and forces the whole stack to shrink into a narrow column.
  'two-horizontal': {
    allowed: ['landscape', 'square'],
    slots: 'all',
    flagWhen: 'any',
    why: 'both photos render full-width, stacked — a portrait one is taller than wide, so the pair has to shrink into a narrow centered column. Use "two-vertical" instead when a portrait is involved',
  },
  // A justified side-by-side row. Shared row height = pageWidth / sum(aspect ratios), so a
  // pair of landscapes here renders as a short strip; they belong stacked instead. A mixed
  // portrait+landscape pair still reads fine, hence `flagWhen: 'all'`.
  'two-vertical': {
    allowed: ['portrait', 'square'],
    slots: 'all',
    flagWhen: 'all',
    why: 'the photos stand side by side sharing one height, so two landscapes render as a thin strip — stack them with "two-horizontal" instead',
  },
  // The one this module was written for: three photos justified into a single row. Shared
  // row height = pageWidth / sum(aspects), so ONE landscape (aspect ~1.5 vs a portrait's
  // ~0.75) drags the whole row's height down until every photo is a sliver.
  'three-column': {
    allowed: ['portrait', 'square'],
    slots: 'all',
    flagWhen: 'any',
    why: 'three photos share one row height, which only works when they are all portrait — a single landscape squashes the entire row into a thin strip. Use "three-mixed" (landscape first) for any trio containing a landscape',
  },
  // One dominant photo across the top, a justified pair below it.
  'three-mixed': {
    allowed: ['landscape', 'square'],
    slots: 'first',
    flagWhen: 'any',
    why: 'the FIRST photo spans the full width across the top, so it must be landscape (or square) — put the landscape first',
  },
  // Same dominant-on-top arrangement with a trio below.
  'four-mixed': {
    allowed: ['landscape', 'square'],
    slots: 'first',
    flagWhen: 'any',
    why: 'the FIRST photo spans the full width across the top, so it must be landscape (or square) — put the landscape first',
  },
  'collage-4': null,
  'collage-5': null,
  'collage-6': null,
  divider: null,
};

/**
 * Whether `photos` are the right shapes for `template` — the single predicate behind both
 * the `template-orientation` finding below and `lib/photo-book-repair.ts`'s decision about
 * when it may overrule a producer's template choice. Photos whose shape isn't known to the
 * caller simply don't count against the template (same "no opinion ≠ a bad score" rule the
 * rest of the pipeline follows for missing analysis).
 */
export function templateFits(template: PhotoPageTemplate, photos: LintPhoto[]): boolean {
  const rule = TEMPLATE_SHAPE_RULES[template];
  if (!rule) return true;
  const relevant = rule.slots === 'first' ? photos.slice(0, 1) : photos;
  if (relevant.length === 0) return true;
  const offenders = relevant.filter((p) => !rule.allowed.includes(orientationOf(p)));
  if (offenders.length === 0) return true;
  return rule.flagWhen === 'any' ? false : offenders.length !== relevant.length;
}

/** A photo this good should not be sitting unused. */
const STRONG_AESTHETIC = 7.5;
/** A photo this weak shouldn't be taking a slot when better ones went unplaced. */
const WEAK_AESTHETIC = 3.5;
/** More than this many identical templates back to back reads as generated, not designed. */
const MAX_TEMPLATE_RUN = 2;
/** A section with fewer pages than this doesn't earn its own divider. */
const MIN_SECTION_PAGES = 2;

/** Every assetId the plan places anywhere — a local copy of `referencedPhotoAssetIds`
 *  (`lib/photo-book-content.ts`), which can't be imported here without dragging `@/db` and
 *  `@/lib/s3` into a pure module (see the module header of `lib/photo-analysis.ts` for the
 *  same constraint). */
function placedAssetIds(plan: PhotoBookPlan): Set<string> {
  const ids = new Set<string>();
  if (plan.cover.heroAssetId) ids.add(plan.cover.heroAssetId);
  for (const id of plan.cover.backAssetIds ?? []) ids.add(id);
  for (const section of plan.sections) {
    for (const page of section.pages) {
      for (const id of page.assetIds) ids.add(id);
    }
  }
  return ids;
}

/**
 * Reviews a plan against the photos it places. Returns every finding, in plan order
 * (cover → section 0 page 0 → …), then the book-wide coverage findings — the order the
 * review prompt reads best in.
 */
export function lintPhotoBookPlan(plan: PhotoBookPlan, photos: LintPhoto[]): PhotoBookLintFinding[] {
  const byId = new Map(photos.map((p) => [p.assetId, p]));
  const findings: PhotoBookLintFinding[] = [];

  plan.sections.forEach((section, sectionIndex) => {
    if (section.pages.length > 0 && section.pages.length < MIN_SECTION_PAGES) {
      findings.push({
        code: 'section-too-short',
        sectionIndex,
        message: `Section ${sectionIndex} ("${section.title}") has only ${section.pages.length} page — either merge it into a neighbouring section or give it more photos.`,
      });
    }

    let runTemplate: PhotoPageTemplate | null = null;
    let runLength = 0;

    section.pages.forEach((page, pageIndex) => {
      const where = `Section ${sectionIndex} ("${section.title}"), page ${pageIndex}`;

      // Only `divider` can legally have zero photos (schema-wise) — and photo-less
      // dividers render as a completely BLANK page, because the real section-title page
      // is emitted automatically per section; a printed book must never contain one.
      if (page.assetIds.length === 0) {
        findings.push({
          code: 'empty-page',
          sectionIndex,
          pageIndex,
          message: `${where} has no photos on it and renders as a blank page — remove it (every section already gets its own title page automatically).`,
        });
      }

      const rule = TEMPLATE_SHAPE_RULES[page.template];
      const known = page.assetIds.map((id) => byId.get(id)).filter((p): p is LintPhoto => p != null);
      if (rule && !templateFits(page.template, known)) {
        const relevant = rule.slots === 'first' ? known.slice(0, 1) : known;
        const listed = relevant
          .filter((p) => !rule.allowed.includes(orientationOf(p)))
          .map((p) => `${p.assetId} (${orientationOf(p)}, ${p.width}x${p.height})`)
          .join(', ');
        findings.push({
          code: 'template-orientation',
          sectionIndex,
          pageIndex,
          message: `${where} uses "${page.template}", but ${rule.why}. Wrong-shaped photo(s): ${listed}. Either move those photos to a template that fits their shape, or swap in photos that fit this one.`,
        });
      }

      if (page.captions?.some((c) => c) && CAPTION_LESS_TEMPLATES.includes(page.template)) {
        findings.push({
          code: 'caption-not-rendered',
          sectionIndex,
          pageIndex,
          message: `${where} is a "${page.template}" page with captions, but that template never renders captions — drop them or move the photo to a page that can show one.`,
        });
      }

      if (page.template === runTemplate) {
        runLength += 1;
        if (runLength === MAX_TEMPLATE_RUN + 1) {
          findings.push({
            code: 'monotonous-pacing',
            sectionIndex,
            pageIndex,
            message: `${where} is the ${runLength}th "${page.template}" page in a row — vary the rhythm so the book doesn't read as mechanically generated.`,
          });
        }
      } else {
        runTemplate = page.template;
        runLength = 1;
      }
    });
  });

  const placed = placedAssetIds(plan);
  const unplacedStrong = photos.filter(
    (p) =>
      !placed.has(p.assetId) &&
      p.analysis != null &&
      !p.analysis.eyesClosed &&
      (p.analysis.coverCandidate || p.analysis.aestheticScore >= STRONG_AESTHETIC),
  );
  if (unplacedStrong.length > 0) {
    const listed = unplacedStrong
      .slice(0, 10)
      .map((p) => `${p.assetId} (aesthetic ${p.analysis!.aestheticScore.toFixed(1)}${p.analysis!.coverCandidate ? ', cover candidate' : ''})`)
      .join(', ');
    findings.push({
      code: 'strong-photo-unplaced',
      message: `${unplacedStrong.length} strong photo(s) are not in the book at all: ${listed}. Place the ones that add something; leaving out a genuinely redundant shot is still fine.`,
    });
  }

  const weakPlaced = photos.filter(
    (p) =>
      placed.has(p.assetId) &&
      p.analysis != null &&
      (p.analysis.aestheticScore <= WEAK_AESTHETIC || p.analysis.eyesClosed),
  );
  if (weakPlaced.length > 0 && unplacedStrong.length > 0) {
    const listed = weakPlaced
      .slice(0, 10)
      .map((p) => `${p.assetId} (aesthetic ${p.analysis!.aestheticScore.toFixed(1)}${p.analysis!.eyesClosed ? ', eyes closed' : ''})`)
      .join(', ');
    findings.push({
      code: 'weak-photo-placed',
      message: `The book places ${weakPlaced.length} weak photo(s) while stronger ones sit unused: ${listed}. Consider swapping them.`,
    });
  }

  return findings;
}

/** Relative weight per finding kind — a squashed row of photos is a real visual defect,
 *  a slightly repetitive rhythm is a nitpick. Used only for the better/worse comparison in
 *  `lintScore`, never shown to anyone. */
const CODE_WEIGHT: Record<PhotoBookLintCode, number> = {
  'empty-page': 12,
  'template-orientation': 10,
  'caption-not-rendered': 4,
  'monotonous-pacing': 3,
  'section-too-short': 2,
  'strong-photo-unplaced': 2,
  'weak-photo-placed': 1,
};

/** Total severity of a set of findings — lower is better, 0 is clean. Lets the AI design
 *  pass keep whichever of {first draft, reviewed draft} actually scores better, so a
 *  review round can only ever improve the book (see `lib/photo-book-ai-layout.ts`). */
export function lintScore(findings: PhotoBookLintFinding[]): number {
  return findings.reduce((sum, f) => sum + CODE_WEIGHT[f.code], 0);
}

/** The findings as a numbered list for the review prompt — empty string when the plan is
 *  already clean, so the caller can skip the round entirely. */
export function formatLintFindings(findings: PhotoBookLintFinding[]): string {
  return findings.map((f, i) => `${i + 1}. [${f.code}] ${f.message}`).join('\n');
}
