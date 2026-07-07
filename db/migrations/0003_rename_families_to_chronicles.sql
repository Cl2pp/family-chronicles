-- Families become "chronicles" (the private story space). "Family" is now a derived
-- tag computed from people.family_name + kinship edges — nothing stored for it.
-- Pure renames: no data is touched.
ALTER TABLE "families" RENAME TO "chronicles";--> statement-breakpoint
ALTER TABLE "family_members" RENAME TO "chronicle_members";--> statement-breakpoint
ALTER TABLE "story_families" RENAME TO "story_chronicles";--> statement-breakpoint
ALTER TABLE "memberships" RENAME COLUMN "family_id" TO "chronicle_id";--> statement-breakpoint
ALTER TABLE "chronicle_members" RENAME COLUMN "family_id" TO "chronicle_id";--> statement-breakpoint
ALTER TABLE "invitations" RENAME COLUMN "family_id" TO "chronicle_id";--> statement-breakpoint
ALTER TABLE "conversations" RENAME COLUMN "family_id" TO "chronicle_id";--> statement-breakpoint
ALTER TABLE "story_chronicles" RENAME COLUMN "family_id" TO "chronicle_id";--> statement-breakpoint
ALTER TABLE "chronicles" RENAME CONSTRAINT "families_pkey" TO "chronicles_pkey";--> statement-breakpoint
ALTER TABLE "chronicle_members" RENAME CONSTRAINT "family_members_pkey" TO "chronicle_members_pkey";--> statement-breakpoint
ALTER TABLE "story_chronicles" RENAME CONSTRAINT "story_families_pkey" TO "story_chronicles_pkey";--> statement-breakpoint
ALTER TABLE "chronicles" RENAME CONSTRAINT "families_created_by_user_id_fk" TO "chronicles_created_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "chronicle_members" RENAME CONSTRAINT "family_members_family_id_families_id_fk" TO "chronicle_members_chronicle_id_chronicles_id_fk";--> statement-breakpoint
ALTER TABLE "chronicle_members" RENAME CONSTRAINT "family_members_person_id_people_id_fk" TO "chronicle_members_person_id_people_id_fk";--> statement-breakpoint
ALTER TABLE "memberships" RENAME CONSTRAINT "memberships_family_id_families_id_fk" TO "memberships_chronicle_id_chronicles_id_fk";--> statement-breakpoint
ALTER TABLE "invitations" RENAME CONSTRAINT "invitations_family_id_families_id_fk" TO "invitations_chronicle_id_chronicles_id_fk";--> statement-breakpoint
ALTER TABLE "conversations" RENAME CONSTRAINT "conversations_family_id_families_id_fk" TO "conversations_chronicle_id_chronicles_id_fk";--> statement-breakpoint
ALTER TABLE "story_chronicles" RENAME CONSTRAINT "story_families_story_id_stories_id_fk" TO "story_chronicles_story_id_stories_id_fk";--> statement-breakpoint
ALTER TABLE "story_chronicles" RENAME CONSTRAINT "story_families_family_id_families_id_fk" TO "story_chronicles_chronicle_id_chronicles_id_fk";--> statement-breakpoint
ALTER TABLE "story_chronicles" RENAME CONSTRAINT "story_families_shared_by_user_id_fk" TO "story_chronicles_shared_by_user_id_fk";--> statement-breakpoint
ALTER INDEX "memberships_family_user_uq" RENAME TO "memberships_chronicle_user_uq";--> statement-breakpoint
ALTER INDEX "family_members_uq" RENAME TO "chronicle_members_uq";--> statement-breakpoint
ALTER INDEX "family_members_family_idx" RENAME TO "chronicle_members_chronicle_idx";--> statement-breakpoint
ALTER INDEX "invitations_family_idx" RENAME TO "invitations_chronicle_idx";--> statement-breakpoint
ALTER INDEX "story_families_uq" RENAME TO "story_chronicles_uq";--> statement-breakpoint
ALTER INDEX "story_families_family_idx" RENAME TO "story_chronicles_chronicle_idx";
