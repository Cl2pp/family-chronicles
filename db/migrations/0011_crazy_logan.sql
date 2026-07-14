CREATE TYPE "public"."book_format" AS ENUM('hardcover-21x28', 'hardcover-20x20');--> statement-breakpoint
CREATE TYPE "public"."book_status" AS ENUM('draft', 'rendering', 'preview_ready', 'render_failed', 'ordered');--> statement-breakpoint
CREATE TABLE "book_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" uuid NOT NULL,
	"ordered_by" text NOT NULL,
	"quote" jsonb NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "book_stories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" uuid NOT NULL,
	"story_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"include_photos" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chronicle_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"dedication" text,
	"cover_asset_id" uuid,
	"format" "book_format" DEFAULT 'hardcover-21x28' NOT NULL,
	"status" "book_status" DEFAULT 'draft' NOT NULL,
	"error_message" text,
	"page_count" integer,
	"preview_s3_key" text,
	"print_s3_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "book_orders" ADD CONSTRAINT "book_orders_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_orders" ADD CONSTRAINT "book_orders_ordered_by_user_id_fk" FOREIGN KEY ("ordered_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_stories" ADD CONSTRAINT "book_stories_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_stories" ADD CONSTRAINT "book_stories_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_chronicle_id_chronicles_id_fk" FOREIGN KEY ("chronicle_id") REFERENCES "public"."chronicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_cover_asset_id_assets_id_fk" FOREIGN KEY ("cover_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_orders_book_idx" ON "book_orders" USING btree ("book_id");--> statement-breakpoint
CREATE UNIQUE INDEX "book_stories_uq" ON "book_stories" USING btree ("book_id","story_id");--> statement-breakpoint
CREATE INDEX "book_stories_book_idx" ON "book_stories" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "books_chronicle_idx" ON "books" USING btree ("chronicle_id");