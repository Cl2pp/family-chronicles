-- Chronicle hard-isolation: a person, a kinship edge, a story and a chat now belong to
-- exactly ONE chronicle. Until now a person could sit in several chronicles at once
-- (via `chronicle_members`) and a story could be shared into several (via
-- `story_chronicles`); both join tables are retired here in favour of a plain
-- `chronicle_id` column on `people` / `relationships` / `stories`, plus making the
-- already-existing `conversations.chronicle_id` mandatory.
--
-- Verified production shape before this migration (6 chronicles, 82-person tree being
-- the only large one): 0 stories live in 2+ chronicles, 0 kinship edges cross a
-- chronicle boundary, but 2 people (each logged-in accounts reused by
-- `ensurePersonForUser`) sit in 2 chronicles at once. Collapsing a multi-chronicle
-- person to one row would silently misplace them, so instead each EXTRA chronicle gets
-- its own copy of that person, and every row that pointed at the original is re-pointed
-- to whichever copy lives in ITS OWN chronicle (not necessarily the original/anchor) —
-- this is the part that must not be gotten wrong, because it's the only thing standing
-- between a real pending invitation and a corrupted one.
--
-- Structure:
--   0. Add the three new `chronicle_id` columns NULLABLE (never add NOT NULL with no
--      default to a populated table), and drop the old global `people_user_uq` early —
--      the per-chronicle person copies inserted below would violate it otherwise.
--   1. Backfill `people.chronicle_id` and build a scratch map
--      (original_person_id, chronicle_id) -> effective_person_id, inserting a copy for
--      every EXTRA chronicle a person belongs to.
--   2. Backfill `stories.chronicle_id` from `story_chronicles`.
--   3. Backfill the (2, both story-less) NULL `conversations.chronicle_id` rows.
--   4. Re-point every row that references a (possibly duplicated) person, using the
--      map from step 1: `relationships`, `story_people`, `invitations`.
--   5. SET NOT NULL on all four columns, add the FKs/indexes, swap `conversations`'
--      chronicle FK from ON DELETE SET NULL to CASCADE.
--   6. Assert the two invariants a botched backfill could otherwise violate silently.
--   7. Drop `story_chronicles` and `chronicle_members` — nothing reads them anymore.
--
-- Runs as one transaction: any surprise (an edge case beyond the ones defended against
-- below) aborts the whole migration instead of half-isolating the data.

-- ── Step 0: nullable columns first, and clear the way for per-chronicle duplicates ──

ALTER TABLE "people" ADD COLUMN "chronicle_id" uuid;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "chronicle_id" uuid;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "chronicle_id" uuid;--> statement-breakpoint
-- The OLD constraint is "one person per account, globally". Step 1 below inserts a
-- second person row for an account that belongs to two chronicles (its copy in the
-- other chronicle) — that insert would violate this index if it were still active, so
-- it has to go before the backfill, not after.
DROP INDEX "people_user_uq";--> statement-breakpoint

-- ── Step 1: backfill people.chronicle_id + build the person-copy map ──

-- Every user's earliest chronicle membership — the fallback "home" chronicle for the
-- defensive branches below (an orphan person, a story with no story_chronicles row, a
-- NULL conversation). None of these are hit by current production data.
CREATE TEMP TABLE "_user_first_chronicle" AS
SELECT DISTINCT ON ("user_id") "user_id", "chronicle_id"
FROM "memberships"
ORDER BY "user_id", "created_at" ASC;--> statement-breakpoint

-- Rank each person's chronicle_members rows by join order. rn = 1 is always "the
-- chronicle this person's original row ends up in" — the only option when they belong
-- to just one chronicle, and the earliest (anchor) one when they belong to several.
-- rn > 1 rows are the EXTRA chronicles that get a copy in step 1's second half.
CREATE TEMP TABLE "_ranked_membership" AS
SELECT "person_id", "chronicle_id", "created_at",
       ROW_NUMBER() OVER (PARTITION BY "person_id" ORDER BY "created_at" ASC, "chronicle_id" ASC) AS "rn"
FROM "chronicle_members";--> statement-breakpoint

UPDATE "people" p
SET "chronicle_id" = rm."chronicle_id"
FROM "_ranked_membership" rm
WHERE rm."person_id" = p."id" AND rm."rn" = 1;--> statement-breakpoint

-- Defensive (0 in prod): a person with no chronicle_members row at all falls back to
-- their creator's earliest chronicle.
UPDATE "people" p
SET "chronicle_id" = ufc."chronicle_id"
FROM "_user_first_chronicle" ufc
WHERE p."chronicle_id" IS NULL AND ufc."user_id" = p."created_by";--> statement-breakpoint

-- Defensive (0 in prod): if even the creator has no chronicle, the person is an orphan
-- with nowhere to live — delete it. Existing FKs cascade/null out its dependents
-- (relationships, story_people cascade; invitations.person_id sets null).
DELETE FROM "people" WHERE "chronicle_id" IS NULL;--> statement-breakpoint

CREATE TEMP TABLE "_person_chronicle_map" (
  "original_person_id" uuid NOT NULL,
  "chronicle_id" uuid NOT NULL,
  "effective_person_id" uuid NOT NULL,
  PRIMARY KEY ("original_person_id", "chronicle_id")
);--> statement-breakpoint

-- Every person now carrying its own chronicle_id maps to itself for that chronicle.
INSERT INTO "_person_chronicle_map" ("original_person_id", "chronicle_id", "effective_person_id")
SELECT "id", "chronicle_id", "id" FROM "people";--> statement-breakpoint

-- One copy per EXTRA chronicle (verified: only Clemens and Christoph, 1 extra each).
-- Same identity fields as the original; a fresh id and the extra chronicle_id.
CREATE TEMP TABLE "_person_copies" AS
SELECT gen_random_uuid() AS "new_person_id", rm."person_id" AS "original_person_id", rm."chronicle_id"
FROM "_ranked_membership" rm
WHERE rm."rn" > 1;--> statement-breakpoint

INSERT INTO "people" (
  "id", "chronicle_id", "first_name", "family_name", "birth_family_name", "user_id",
  "gender", "born_on", "born_precision", "died_on", "died_precision", "avatar_s3_key",
  "notes", "created_by", "created_at", "updated_at"
)
SELECT pc."new_person_id", pc."chronicle_id", p."first_name", p."family_name", p."birth_family_name",
       p."user_id", p."gender", p."born_on", p."born_precision", p."died_on", p."died_precision",
       p."avatar_s3_key", p."notes", p."created_by", p."created_at", p."updated_at"
FROM "_person_copies" pc
JOIN "people" p ON p."id" = pc."original_person_id";--> statement-breakpoint

INSERT INTO "_person_chronicle_map" ("original_person_id", "chronicle_id", "effective_person_id")
SELECT "original_person_id", "chronicle_id", "new_person_id" FROM "_person_copies";--> statement-breakpoint

-- ── Step 2: backfill stories.chronicle_id from story_chronicles ──

-- The common case (verified: every story in prod): exactly one story_chronicles row.
WITH "story_chronicle_counts" AS (
  SELECT "story_id", COUNT(*) AS "n" FROM "story_chronicles" GROUP BY "story_id"
)
UPDATE "stories" s
SET "chronicle_id" = sc."chronicle_id"
FROM "story_chronicles" sc
JOIN "story_chronicle_counts" c ON c."story_id" = sc."story_id" AND c."n" = 1
WHERE sc."story_id" = s."id";--> statement-breakpoint

-- Defensive (0 in prod): a story shared into 2+ chronicles keeps only the earliest
-- (by shared_at) — it now lives in exactly one chronicle, so the rest are discarded
-- along with the table itself in step 7. Logged, not silent.
WITH "ranked_story_chronicle" AS (
  SELECT "story_id", "chronicle_id", "shared_at",
         ROW_NUMBER() OVER (PARTITION BY "story_id" ORDER BY "shared_at" ASC, "chronicle_id" ASC) AS "rn",
         COUNT(*) OVER (PARTITION BY "story_id") AS "n"
  FROM "story_chronicles"
)
UPDATE "stories" s
SET "chronicle_id" = rsc."chronicle_id"
FROM "ranked_story_chronicle" rsc
WHERE rsc."story_id" = s."id" AND rsc."rn" = 1 AND rsc."n" > 1;--> statement-breakpoint

DO $$
DECLARE
  "dropped_count" integer;
BEGIN
  SELECT COUNT(*) INTO "dropped_count"
  FROM (
    SELECT "story_id",
           ROW_NUMBER() OVER (PARTITION BY "story_id" ORDER BY "shared_at" ASC, "chronicle_id" ASC) AS "rn"
    FROM "story_chronicles"
  ) "ranked"
  WHERE "ranked"."rn" > 1;
  IF "dropped_count" > 0 THEN
    RAISE NOTICE 'chronicle isolation backfill: % extra story_chronicles row(s) discarded for multi-chronicle stories (kept earliest shared_at)', "dropped_count";
  END IF;
END $$;--> statement-breakpoint

-- Defensive (0 in prod): a story with no story_chronicles row at all falls back to its
-- submitter's earliest chronicle, or is deleted if the submitter has none either.
UPDATE "stories" s
SET "chronicle_id" = ufc."chronicle_id"
FROM "_user_first_chronicle" ufc
WHERE s."chronicle_id" IS NULL AND ufc."user_id" = s."submitted_by";--> statement-breakpoint

DELETE FROM "stories" WHERE "chronicle_id" IS NULL;--> statement-breakpoint

-- ── Step 3: backfill the NULL conversations.chronicle_id rows ──

-- Both current NULL rows have no stories attached, so nothing else depends on which
-- chronicle they land in; fall back to the owning user's earliest chronicle.
UPDATE "conversations" c
SET "chronicle_id" = ufc."chronicle_id"
FROM "_user_first_chronicle" ufc
WHERE c."chronicle_id" IS NULL AND ufc."user_id" = c."user_id";--> statement-breakpoint

-- ── Step 4: re-point rows that reference a (possibly duplicated) person ──

-- Each kinship edge's two endpoints share at least one chronicle (verified: none
-- cross). Resolve that shared chronicle per edge, then re-point BOTH endpoints to the
-- copy living there and stamp the edge with it — all in one UPDATE, so the edge's
-- three columns can never end up inconsistent with each other.
-- Carries person_from_id/person_to_id along so the UPDATE below never needs to
-- reference the target table "r" from inside a FROM-clause join condition — Postgres
-- rejects that (only the top-level WHERE may tie the FROM-list back to the target row).
CREATE TEMP TABLE "_relationship_target_chronicle" AS
SELECT r."id" AS "relationship_id", r."person_from_id", r."person_to_id",
       (
         SELECT cm_from."chronicle_id"
         FROM "chronicle_members" cm_from
         JOIN "chronicle_members" cm_to
           ON cm_to."chronicle_id" = cm_from."chronicle_id"
          AND cm_to."person_id" = r."person_to_id"
         WHERE cm_from."person_id" = r."person_from_id"
         ORDER BY cm_from."chronicle_id"
         LIMIT 1
       ) AS "chronicle_id"
FROM "relationships" r;--> statement-breakpoint

-- An edge whose two endpoints share MORE than one chronicle has no single correct home,
-- and the `LIMIT 1` above would pick one arbitrarily — stranding the edge in a tree it
-- may not belong to, silently. Production has none of these (audited: exactly 2 people
-- sit in a second chronicle, and neither carries kinship edges there), so treat it as
-- unreachable and abort rather than guess. Deliberately checked BEFORE the re-point, so
-- the failure names the real cause instead of surfacing later as a NOT NULL violation.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM "relationships" r
    JOIN "chronicle_members" cm_from ON cm_from."person_id" = r."person_from_id"
    JOIN "chronicle_members" cm_to
      ON cm_to."chronicle_id" = cm_from."chronicle_id"
     AND cm_to."person_id" = r."person_to_id"
    GROUP BY r."id"
    HAVING count(DISTINCT cm_from."chronicle_id") > 1
  ) THEN
    RAISE EXCEPTION 'kinship edge whose endpoints share several chronicles — no deterministic home';
  END IF;
END $$;--> statement-breakpoint

UPDATE "relationships" r
SET "chronicle_id" = t."chronicle_id",
    "person_from_id" = mf."effective_person_id",
    "person_to_id" = mt."effective_person_id"
FROM "_relationship_target_chronicle" t
JOIN "_person_chronicle_map" mf ON mf."original_person_id" = t."person_from_id" AND mf."chronicle_id" = t."chronicle_id"
JOIN "_person_chronicle_map" mt ON mt."original_person_id" = t."person_to_id" AND mt."chronicle_id" = t."chronicle_id"
WHERE r."id" = t."relationship_id";--> statement-breakpoint

-- story_people: re-point to the copy living in the STORY's own chronicle (not the
-- tagged person's anchor chronicle — those can differ). Snapshot the pre-update state
-- first so the fallback delete below can't be confused by rows this same step already
-- rewrote.
CREATE TEMP TABLE "_story_people_before" AS
SELECT sp."id" AS "story_people_id", sp."person_id" AS "original_person_id", s."chronicle_id" AS "story_chronicle_id"
FROM "story_people" sp
JOIN "stories" s ON s."id" = sp."story_id";--> statement-breakpoint

UPDATE "story_people" sp
SET "person_id" = m."effective_person_id"
FROM "_story_people_before" b
JOIN "_person_chronicle_map" m ON m."original_person_id" = b."original_person_id" AND m."chronicle_id" = b."story_chronicle_id"
WHERE sp."id" = b."story_people_id";--> statement-breakpoint

-- Defensive (0 in prod): the old model allowed tagging someone outside the story's own
-- chronicle. Under hard isolation that tag no longer resolves to anyone — drop it
-- rather than leave it dangling or point it at the wrong person.
DELETE FROM "story_people" sp
USING "_story_people_before" b
WHERE sp."id" = b."story_people_id"
  AND NOT EXISTS (
    SELECT 1 FROM "_person_chronicle_map" m
    WHERE m."original_person_id" = b."original_person_id" AND m."chronicle_id" = b."story_chronicle_id"
  );--> statement-breakpoint

-- invitations: re-point to the copy living in the INVITATION's own chronicle_id — this
-- is the case that bites in prod (Christoph: 1 invitation, duplicated across two
-- chronicles). Anchoring to the wrong copy here would let an acceptance link an
-- account to a person in the wrong tree, so snapshot first for the same reason as
-- story_people above.
CREATE TEMP TABLE "_invitation_person_before" AS
SELECT "id" AS "invitation_id", "person_id" AS "original_person_id", "chronicle_id"
FROM "invitations"
WHERE "person_id" IS NOT NULL;--> statement-breakpoint

UPDATE "invitations" i
SET "person_id" = m."effective_person_id"
FROM "_invitation_person_before" b
JOIN "_person_chronicle_map" m ON m."original_person_id" = b."original_person_id" AND m."chronicle_id" = b."chronicle_id"
WHERE i."id" = b."invitation_id";--> statement-breakpoint

-- Defensive (0 in prod): an invitation whose target person has no copy in the
-- invitation's own chronicle can't be resolved safely — clear the link instead of
-- pointing it at the wrong tree.
UPDATE "invitations" i
SET "person_id" = NULL
FROM "_invitation_person_before" b
WHERE i."id" = b."invitation_id"
  AND NOT EXISTS (
    SELECT 1 FROM "_person_chronicle_map" m
    WHERE m."original_person_id" = b."original_person_id" AND m."chronicle_id" = b."chronicle_id"
  );--> statement-breakpoint

-- ── Step 5: NOT NULL + indexes + FKs ──
-- Any row the backfill above couldn't resolve is still NULL here, so these SET NOT
-- NULL statements double as a final, fail-loudly check on top of step 6's assertions.

ALTER TABLE "people" ALTER COLUMN "chronicle_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "relationships" ALTER COLUMN "chronicle_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ALTER COLUMN "chronicle_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "chronicle_id" SET NOT NULL;--> statement-breakpoint

CREATE UNIQUE INDEX "people_chronicle_user_uq" ON "people" USING btree ("chronicle_id","user_id");--> statement-breakpoint
CREATE INDEX "people_chronicle_idx" ON "people" USING btree ("chronicle_id");--> statement-breakpoint
CREATE INDEX "relationships_chronicle_idx" ON "relationships" USING btree ("chronicle_id");--> statement-breakpoint
CREATE INDEX "stories_chronicle_idx" ON "stories" USING btree ("chronicle_id");--> statement-breakpoint

ALTER TABLE "people" ADD CONSTRAINT "people_chronicle_id_chronicles_id_fk" FOREIGN KEY ("chronicle_id") REFERENCES "public"."chronicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_chronicle_id_chronicles_id_fk" FOREIGN KEY ("chronicle_id") REFERENCES "public"."chronicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_chronicle_id_chronicles_id_fk" FOREIGN KEY ("chronicle_id") REFERENCES "public"."chronicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- conversations.chronicle_id was nullable with ON DELETE SET NULL; now it's mandatory,
-- so a deleted chronicle must take its conversations with it instead of orphaning them.
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_chronicle_id_chronicles_id_fk";--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_chronicle_id_chronicles_id_fk" FOREIGN KEY ("chronicle_id") REFERENCES "public"."chronicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ── Step 6: invariants — abort the deploy's migration rather than half-isolate ──

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "relationships" r
    JOIN "people" a ON a."id" = r."person_from_id"
    JOIN "people" b ON b."id" = r."person_to_id"
    WHERE a."chronicle_id" <> b."chronicle_id"
  ) THEN RAISE EXCEPTION 'cross-chronicle kinship edge survived the backfill'; END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "story_people" sp
    JOIN "stories" s ON s."id" = sp."story_id"
    JOIN "people" p ON p."id" = sp."person_id"
    WHERE p."chronicle_id" <> s."chronicle_id"
  ) THEN RAISE EXCEPTION 'story tags a person outside its chronicle'; END IF;
END $$;--> statement-breakpoint

-- ── Step 7: drop the retired join tables, last ──

ALTER TABLE "chronicle_members" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "story_chronicles" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "chronicle_members" CASCADE;--> statement-breakpoint
DROP TABLE "story_chronicles" CASCADE;--> statement-breakpoint

-- Scratch tables only — Postgres would drop these at session end regardless, this is
-- just hygiene.
DROP TABLE "_user_first_chronicle", "_ranked_membership", "_person_copies",
  "_person_chronicle_map", "_relationship_target_chronicle", "_story_people_before",
  "_invitation_person_before";
