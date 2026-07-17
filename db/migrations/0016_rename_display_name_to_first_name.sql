ALTER TABLE "people" RENAME COLUMN "display_name" TO "first_name";--> statement-breakpoint
ALTER TABLE "people" DROP COLUMN "given_name";--> statement-breakpoint
-- Data cleanup: legacy rows stored a full name in the old display_name column.
-- Now that the field means "first name(s) only", strip a trailing surname from
-- first_name when that exact surname is already stored in family_name. Guarded so
-- something always remains before the space, and only touches an exact-suffix match.
UPDATE "people"
SET "first_name" = btrim(left("first_name", length("first_name") - length("family_name") - 1))
WHERE "family_name" IS NOT NULL
  AND "family_name" <> ''
  AND length("first_name") > length("family_name") + 1
  AND lower(right("first_name", length("family_name") + 1)) = ' ' || lower("family_name");