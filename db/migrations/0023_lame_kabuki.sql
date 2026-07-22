ALTER TABLE "book_photos" ADD COLUMN "story_id" uuid;--> statement-breakpoint
ALTER TABLE "book_stories" ADD COLUMN "include_text" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "book_photos" ADD CONSTRAINT "book_photos_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_photos_book_story_idx" ON "book_photos" USING btree ("book_id","story_id");--> statement-breakpoint
-- Backfill (unified-book plan, PR A): mirror every attached story's photo assets into
-- book_photos, so existing story books' photos flow through the same analysis + layout
-- pipeline as uploads. Positions follow (chapter order, asset creation order); a story
-- attached with include_photos = false mirrors as excluded ('story-setting'), matching
-- what syncStoryPhotoMirrors (lib/books.ts) writes for live attachments. analysis_status
-- stays at its 'pending' default — analysis jobs are enqueued lazily by
-- ensureBookPhotoAnalysis when a builder actually needs the data (a migration cannot
-- enqueue pg-boss jobs).
INSERT INTO "book_photos" ("book_id", "asset_id", "story_id", "position", "excluded", "excluded_reason")
SELECT
  bs."book_id",
  a."id",
  bs."story_id",
  (ROW_NUMBER() OVER (PARTITION BY bs."book_id" ORDER BY bs."position", a."created_at", a."id") - 1),
  NOT bs."include_photos",
  CASE WHEN NOT bs."include_photos" THEN 'story-setting' END
FROM "book_stories" bs
JOIN "assets" a ON a."story_id" = bs."story_id" AND a."kind" = 'photo'
ON CONFLICT ("book_id", "asset_id") DO NOTHING;
