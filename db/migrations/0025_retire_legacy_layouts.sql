-- Retire the legacy story-book layout engine (unified-book plan, PR F).
--
-- Until now a book still holding an old story-book `layout_plan` was rendered by the
-- retired engine so it kept its exact look. That engine is deleted in this release, so
-- any such plan is now unreadable — clearing it hands the book to the unified engine,
-- which rebuilds a layout from the SAME content on the next open (`loadOrBuildPhotoPlan`).
--
-- Deliberately clears the PLAN only: the book row, its title/subtitle/dedication/format,
-- its chapters, its photos and its cover pin are all untouched. Layout is regenerable
-- data — that is the whole premise the plan/`layout_stale` design rests on.
--
-- Legacy plans are identified structurally: the unified plan is a JSON object carrying
-- `"kind": "photo"`, the legacy one never did. Ordered books are left alone — they are
-- locked, and their print PDFs of record live in S3 regardless of this column.
UPDATE "books"
SET "layout_plan" = NULL,
    "layout_source" = 'auto',
    "layout_stale" = true,
    -- A converted book has content already, so it must not fall back to the builder's
    -- "not generated yet" view (the same stamp `convertBookToUnifiedLayout` applied).
    "generated_at" = COALESCE("generated_at", "updated_at"),
    "updated_at" = now()
WHERE "layout_plan" IS NOT NULL
  AND "layout_plan" ->> 'kind' IS DISTINCT FROM 'photo'
  AND "status" <> 'ordered';
