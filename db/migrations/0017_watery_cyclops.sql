CREATE TYPE "public"."book_kind" AS ENUM('story', 'photo');--> statement-breakpoint
CREATE TYPE "public"."photo_analysis_status" AS ENUM('pending', 'analyzing', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "book_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"excluded_reason" text,
	"taken_at" timestamp,
	"gps_lat" double precision,
	"gps_lng" double precision,
	"phash" text,
	"blur_score" double precision,
	"analysis_status" "photo_analysis_status" DEFAULT 'pending' NOT NULL,
	"analysis" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "story_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "book_id" uuid;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "kind" "book_kind" DEFAULT 'story' NOT NULL;--> statement-breakpoint
ALTER TABLE "book_photos" ADD CONSTRAINT "book_photos_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_photos" ADD CONSTRAINT "book_photos_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "book_photos_book_asset_uq" ON "book_photos" USING btree ("book_id","asset_id");--> statement-breakpoint
CREATE INDEX "book_photos_book_idx" ON "book_photos" USING btree ("book_id");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_book_idx" ON "assets" USING btree ("book_id");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_story_or_book_ck" CHECK ("assets"."story_id" is not null or "assets"."book_id" is not null);