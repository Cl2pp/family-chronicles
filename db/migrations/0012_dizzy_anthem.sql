ALTER TABLE "books" ADD COLUMN "layout_plan" jsonb;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "layout_source" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "layout_stale" boolean DEFAULT false NOT NULL;