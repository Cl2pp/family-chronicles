CREATE TYPE "public"."book_cover_type" AS ENUM('hardcover', 'softcover');--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "cover_type" "book_cover_type" DEFAULT 'hardcover' NOT NULL;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "generated_at" timestamp;