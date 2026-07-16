CREATE TYPE "public"."story_access_mode" AS ENUM('open', 'family');--> statement-breakpoint
ALTER TABLE "chronicles" ADD COLUMN "story_access" "story_access_mode" DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "person_id" uuid;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;