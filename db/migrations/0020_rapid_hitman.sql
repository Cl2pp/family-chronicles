CREATE TYPE "public"."book_cover_type" AS ENUM('hardcover', 'softcover');--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "cover_type" "book_cover_type" DEFAULT 'hardcover' NOT NULL;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "generated_at" timestamp;--> statement-breakpoint
-- One-time backfill for rows that predate `generated_at`: any photo book that already has
-- a `layout_plan` was either designed before this column existed, or got an auto plan
-- silently persisted by `getPhotoBookStyle`/`loadOrBuildPhotoPlan` on a normal page load.
-- Either way, from the builder's Step 2 perspective it has already "been generated" and
-- must not get stuck behind the configure-only screen. This is a one-time data fix for
-- EXISTING rows only — it runs once, at migration time; books inserted after this
-- migration runs correctly start with `generated_at = NULL` until the explicit "Create
-- book" design job stamps it (see `books.generated_at`'s comment in db/schema.ts).
UPDATE "books" SET "generated_at" = "updated_at" WHERE "kind" = 'photo' AND "layout_plan" IS NOT NULL;