ALTER TABLE "message_attachments" ADD COLUMN "story_id" uuid;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Backfill: an upload is claimed by the FIRST story that copied it. Until now every
-- story accepted from a conversation copied *all* of that conversation's uploads, so
-- the same s3_key can appear on several stories; the earliest one wins. Without this,
-- the next story accepted in an existing chat would re-claim photos already carried over.
UPDATE "message_attachments" ma
SET "story_id" = first_story.story_id
FROM (
  SELECT DISTINCT ON (a."s3_key") a."s3_key", a."story_id"
  FROM "assets" a
  ORDER BY a."s3_key", a."created_at" ASC
) AS first_story
WHERE ma."s3_key" = first_story."s3_key";--> statement-breakpoint

-- Drop any (story_id, s3_key) duplicates before the unique index can be created.
DELETE FROM "assets" a
USING "assets" b
WHERE a."story_id" = b."story_id"
  AND a."s3_key" = b."s3_key"
  AND a."id" > b."id";--> statement-breakpoint

CREATE UNIQUE INDEX "assets_story_key_uq" ON "assets" USING btree ("story_id","s3_key");
