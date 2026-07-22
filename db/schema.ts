import { sql } from 'drizzle-orm';
import {
  pgEnum,
  pgTable,
  text,
  boolean,
  timestamp,
  uuid,
  integer,
  doublePrecision,
  jsonb,
  index,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/* ──────────────────────────────────────────────────────────────────────────
 * Auth tables (managed by better-auth's Drizzle adapter)
 * Column/table names follow better-auth defaults — keep them in sync.
 * ────────────────────────────────────────────────────────────────────────── */

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

/* ──────────────────────────────────────────────────────────────────────────
 * Domain enums
 * ────────────────────────────────────────────────────────────────────────── */

/** Per-chronicle access level (authz). */
export const accessRole = pgEnum('access_role', ['owner', 'contributor', 'viewer']);
/**
 * Per-chronicle story read-access mode. `open` = every member reads every story
 * (legacy behavior). `family` = reads are gated by the kinship graph — see
 * docs/STORY_ACCESS_PLAN.md and lib/story-access.ts.
 */
export const storyAccessMode = pgEnum('story_access_mode', ['open', 'family']);
/** Global kinship edge types between people. */
export const relationshipType = pgEnum('relationship_type', ['parent', 'spouse']);
export const inputType = pgEnum('input_type', ['text', 'voice', 'chat']);
export const storyStatus = pgEnum('story_status', ['draft', 'processing', 'ready', 'failed']);
export const datePrecision = pgEnum('date_precision', ['day', 'month', 'year', 'circa']);
export const gender = pgEnum('gender', ['male', 'female']);
export const assetKind = pgEnum('asset_kind', ['audio', 'photo']);
export const messageRole = pgEnum('message_role', ['user', 'assistant', 'system', 'tool']);

/* ──────────────────────────────────────────────────────────────────────────
 * Genealogy layer (global, chronicle-agnostic): people + kinship edges
 * ────────────────────────────────────────────────────────────────────────── */

/** A person — a node in the kinship graph. May or may not have an app account. */
export const people = pgTable(
  'people',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** First name(s) only — the surname lives in familyName. Display = firstName + familyName. */
    firstName: text('first_name').notNull(),
    /** Surname — the source of derived family tags (see lib/family-tags.ts). */
    familyName: text('family_name'),
    /** Surname at birth, when it differs from familyName (e.g. name taken at marriage). */
    birthFamilyName: text('birth_family_name'),
    /** Optional link to an app account (most people never log in). */
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    gender: gender('gender'),
    bornOn: timestamp('born_on'),
    bornPrecision: datePrecision('born_precision'),
    diedOn: timestamp('died_on'),
    diedPrecision: datePrecision('died_precision'),
    avatarS3Key: text('avatar_s3_key'),
    notes: text('notes'),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('people_user_uq').on(t.userId)],
);

/** Global kinship edge. `parent`: from = parent, to = child. `spouse`: symmetric. */
export const relationships = pgTable(
  'relationships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    type: relationshipType('type').notNull(),
    personFromId: uuid('person_from_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    personToId: uuid('person_to_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('relationships_uq').on(t.type, t.personFromId, t.personToId),
    index('relationships_from_idx').on(t.personFromId),
    index('relationships_to_idx').on(t.personToId),
  ],
);

/* ──────────────────────────────────────────────────────────────────────────
 * Chronicle layer: the private space a group of relatives shares
 * ────────────────────────────────────────────────────────────────────────── */

/** A chronicle = a private story space (name is a label, NOT unique). */
export const chronicles = pgTable('chronicles', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  /** Free-text writing-style guide, injected into the styling prompt. */
  styleGuide: text('style_guide'),
  /** Language stories are retold in ('en' | 'de'); null = keep the submission's language. */
  storyLanguage: text('story_language'),
  /**
   * Story read-access mode; `family` ("close family") gates reads by kinship
   * (docs/STORY_ACCESS_PLAN.md). New chronicles default to `family`; rows that
   * existed before migration 0015 keep `open` until their owner flips them.
   */
  storyAccess: storyAccessMode('story_access').notNull().default('family'),
  createdBy: text('created_by')
    .notNull()
    .references(() => user.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

/** USER access to a chronicle (authz) — separate from being a tree node. */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    chronicleId: uuid('chronicle_id')
      .notNull()
      .references(() => chronicles.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessRole: accessRole('access_role').notNull().default('contributor'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('memberships_chronicle_user_uq').on(t.chronicleId, t.userId)],
);

/** Which PEOPLE are nodes in a chronicle's tree (person↔chronicle, many-to-many). */
export const chronicleMembers = pgTable(
  'chronicle_members',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    chronicleId: uuid('chronicle_id')
      .notNull()
      .references(() => chronicles.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    /** Optional display override; role is normally derived from the tree. */
    roleLabel: text('role_label'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chronicle_members_uq').on(t.chronicleId, t.personId),
    index('chronicle_members_chronicle_idx').on(t.chronicleId),
  ],
);

/** Pending email invitations to join a chronicle (grants a membership). */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    chronicleId: uuid('chronicle_id')
      .notNull()
      .references(() => chronicles.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    accessRole: accessRole('access_role').notNull().default('contributor'),
    /**
     * The tree node the invitee IS. Accepting the invite sets `people.user_id`
     * on this person, which anchors kinship-based story access for their account.
     */
    personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
    token: text('token').notNull().unique(),
    invitedBy: text('invited_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at').notNull(),
    acceptedAt: timestamp('accepted_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('invitations_chronicle_idx').on(t.chronicleId)],
);

/* ──────────────────────────────────────────────────────────────────────────
 * Stories — standalone, shareable across many chronicles
 * ────────────────────────────────────────────────────────────────────────── */

export const conversations = pgTable('conversations', {
  id: uuid('id').defaultRandom().primaryKey(),
  /** Chronicle context the chat was started in (nullable = "all"). */
  chronicleId: uuid('chronicle_id').references(() => chronicles.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  title: text('title'),
  /** Set when the user starts a new chat — a closed conversation is kept as history but never resumed. */
  closedAt: timestamp('closed_at'),
  /**
   * Claim marker while an agent reply is being generated. A recovery sync (mobile tab
   * kill) may only regenerate a missing reply when no live request holds this claim.
   */
  replyPendingSince: timestamp('reply_pending_since'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: messageRole('role').notNull(),
    content: text('content').notNull(),
    /** Structured extras for rendering (e.g. applied-action receipts). */
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId)],
);

/** A single story. No longer bound to one chronicle — see story_chronicles. */
export const stories = pgTable(
  'stories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    submittedBy: text('submitted_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    /** Short "what it's about" abstract. */
    summary: text('summary'),
    /** Raw text or the verbatim transcript. */
    bodyOriginal: text('body_original'),
    /** AI-styled, third-person memoir version. */
    bodyStyled: text('body_styled'),
    inputType: inputType('input_type').notNull(),
    status: storyStatus('status').notNull().default('draft'),
    errorMessage: text('error_message'),
    eventDate: timestamp('event_date'),
    eventDatePrecision: datePrecision('event_date_precision'),
    /** The chat this story came from, if any. */
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [index('stories_event_date_idx').on(t.eventDate)],
);

/** A story is shared into every chronicle linked here (≥1). */
export const storyChronicles = pgTable(
  'story_chronicles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.id, { onDelete: 'cascade' }),
    chronicleId: uuid('chronicle_id')
      .notNull()
      .references(() => chronicles.id, { onDelete: 'cascade' }),
    sharedBy: text('shared_by').references(() => user.id, { onDelete: 'set null' }),
    sharedAt: timestamp('shared_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('story_chronicles_uq').on(t.storyId, t.chronicleId),
    index('story_chronicles_chronicle_idx').on(t.chronicleId),
  ],
);

/** Who/what a story is about. */
export const storyPeople = pgTable(
  'story_people',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('story_people_uq').on(t.storyId, t.personId)],
);

/**
 * One act of contributing source material to a story: a story save, a chat revision
 * that carried new first-hand material, or photos added on the story page. The story
 * page renders these as the "source material" timeline — who added what, when.
 * `stories.body_original` stays the concatenated feed the styling job reads.
 */
export const contributions = pgTable(
  'contributions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.id, { onDelete: 'cascade' }),
    /** Who contributed it; null once that account is deleted. */
    contributedBy: text('contributed_by').references(() => user.id, { onDelete: 'set null' }),
    /** The contributor's words, verbatim (typed text or a voice transcript). Null for photo-only additions. */
    text: text('text'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('contributions_story_idx').on(t.storyId)],
);

/** Raw inputs kept for traceability: original voice messages and photos. */
export const assets = pgTable(
  'assets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** Nullable: a photo-book upload belongs to a book, not a story — see `bookId` below
     *  and the `assets_story_or_book_ck` CHECK constraint (exactly one owner). */
    storyId: uuid('story_id').references(() => stories.id, { onDelete: 'cascade' }),
    /** Owning photo book, for uploads that don't belong to a story (see `storyId`).
     *  Return-typed to break the assets↔books circular reference (books.coverAssetId
     *  points back at assets.id). */
    bookId: uuid('book_id').references((): AnyPgColumn => books.id, { onDelete: 'cascade' }),
    /** The contribution this asset arrived with, for the source-material timeline. */
    contributionId: uuid('contribution_id').references(() => contributions.id, {
      onDelete: 'set null',
    }),
    kind: assetKind('kind').notNull(),
    s3Key: text('s3_key').notNull(),
    /** Downscaled WebP for grids/banners, written by the worker's `thumbnail` job. */
    thumbS3Key: text('thumb_s3_key'),
    /** ~1600px-longest-edge WebP, written by the worker's `thumbnail` job for BOOK-owned
     *  photos only (`book_id` set) — 640px thumbnails read as visibly soft on a
     *  full-bleed photo-book page (docs/PHOTO_BOOK_PLAN.md §8). Story photos never get
     *  one; their thumbnail is enough for the text-column figures they render into. */
    displayS3Key: text('display_s3_key'),
    mimeType: text('mime_type').notNull(),
    bytes: integer('bytes'),
    caption: text('caption'),
    width: integer('width'),
    height: integer('height'),
    durationSec: integer('duration_sec'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('assets_story_idx').on(t.storyId),
    index('assets_book_idx').on(t.bookId),
    // One story never holds the same object twice — an accepted draft re-run must
    // not duplicate the photos it already carried over. NULLs (book-owned assets)
    // are treated as distinct by Postgres, so this never blocks book photos.
    uniqueIndex('assets_story_key_uq').on(t.storyId, t.s3Key),
    // Every asset belongs to exactly one owner — a story or a book, never neither.
    check('assets_story_or_book_ck', sql`${t.storyId} is not null or ${t.bookId} is not null`),
  ],
);

/** In-chat uploads (voice/photos) before a story is accepted. */
export const messageAttachments = pgTable(
  'message_attachments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    kind: assetKind('kind').notNull(),
    s3Key: text('s3_key').notNull(),
    mimeType: text('mime_type').notNull(),
    bytes: integer('bytes'),
    width: integer('width'),
    height: integer('height'),
    durationSec: integer('duration_sec'),
    /**
     * The story that claimed this upload, once a draft card was accepted. A chat can
     * produce several stories; each takes only the uploads not yet claimed, so photo
     * #3 doesn't end up attached to the story that was saved before it was sent.
     * Nulled (not deleted) if that story is deleted — the row still renders in chat.
     */
    storyId: uuid('story_id').references(() => stories.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('message_attachments_message_idx').on(t.messageId)],
);

/* ──────────────────────────────────────────────────────────────────────────
 * Books — a chronicle's stories typeset into a printable book
 * ────────────────────────────────────────────────────────────────────────── */

export const bookStatus = pgEnum('book_status', [
  'draft', // being assembled; no preview matches the current content
  'rendering', // a render job is queued or running
  'preview_ready', // preview + print PDFs in S3 match the current content
  'render_failed',
  'ordered', // order placed; the book is locked read-only
]);

/** Trim sizes offered in the UI; each maps to a Gelato product UID (lib/gelato.ts).
 *  NOTE: despite the "hardcover-" prefix, these values name the SIZE/trim only (21×28 vs
 *  20×20) — a historical naming artifact from when every book was a hardcover. The actual
 *  hardcover-vs-softcover binding choice lives in `bookCoverType`/`books.coverType` below;
 *  `lib/gelato.ts`'s Gelato product-UID resolution combines the two. Don't read "hardcover"
 *  in a `bookFormat` value as a binding claim. */
export const bookFormat = pgEnum('book_format', ['hardcover-21x28', 'hardcover-20x20']);

/** Hardcover vs softcover binding — orthogonal to `bookFormat` (trim size, see its own
 *  comment on the naming overlap). Defaults to 'hardcover' so every existing book (and
 *  every story book, which has no UI for this yet) is unaffected. Currently a stored
 *  preference + a Gelato quote input for photo books (docs/PHOTO_BOOK_PLAN.md builder
 *  Step 2 config panel) — real ordering is parked, so this doesn't change print PDF
 *  content yet. */
export const bookCoverType = pgEnum('book_cover_type', ['hardcover', 'softcover']);

/** `story`: the existing chapters-from-stories book. `photo`: a photo-only book built
 *  from bulk-uploaded photos (docs/PHOTO_BOOK_PLAN.md) — `book_stories` stays empty. */
export const bookKind = pgEnum('book_kind', ['story', 'photo']);

export const books = pgTable(
  'books',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    chronicleId: uuid('chronicle_id')
      .notNull()
      .references(() => chronicles.id, { onDelete: 'cascade' }),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    kind: bookKind('kind').notNull().default('story'),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    dedication: text('dedication'),
    /** Cover photo — one of the included stories' photo assets. */
    coverAssetId: uuid('cover_asset_id').references(() => assets.id, { onDelete: 'set null' }),
    format: bookFormat('format').notNull().default('hardcover-21x28'),
    /** Hardcover vs softcover binding — see `bookCoverType`'s own comment. */
    coverType: bookCoverType('cover_type').notNull().default('hardcover'),
    status: bookStatus('status').notNull().default('draft'),
    errorMessage: text('error_message'),
    /** Set by the renderer: final padded page count of the print PDF. */
    pageCount: integer('page_count'),
    previewS3Key: text('preview_s3_key'),
    printS3Key: text('print_s3_key'),
    /** Layout plan (lib/book-layout-plan.ts) — what goes where; the renderer's input. */
    layoutPlan: jsonb('layout_plan'),
    /** Photo books only: how the user asked for the book to be organised — one of
     *  `PHOTO_BOOK_GROUPINGS` (`lib/photo-book-grouping.ts`). Chosen in the builder's
     *  config panel before generating, and read by BOTH producers (the AI design pass and
     *  the deterministic auto-layouter) to decide what makes a section. Untyped text like
     *  `layoutSource`; null (every book predating this) means chronological. */
    photoGrouping: text('photo_grouping'),
    /** Who last wrote layoutPlan: the heuristic auto-layouter, an AI pass, or a manual edit. */
    layoutSource: text('layout_source').notNull().default('auto'),
    /** Content changed since layoutPlan was made (paragraph counts/photos may no longer match). */
    layoutStale: boolean('layout_stale').notNull().default(false),
    /** Set when an AI design job is enqueued, cleared by the worker on completion (success
     *  or fallback) — lets the builder show a working state without hijacking `status`,
     *  which still tracks the print-proof PDF render lifecycle. */
    designRequestedAt: timestamp('design_requested_at'),
    /** How far the in-flight photo-book design pass has got — one of
     *  `PHOTO_BOOK_DESIGN_STAGES` (`lib/photo-book-design-stage.ts`), written by the worker
     *  as it moves between stages and read by the builder's status poll. A design pass
     *  takes minutes (two vision calls with a Chromium render between them), and a bare
     *  spinner for that long reads as "stuck", so Step 2 shows a live checklist instead.
     *  Untyped text like `layoutSource`/`excludedReason`; `parseDesignStage` narrows it,
     *  and an unknown/stale value degrades to "no stage reported". Cleared alongside
     *  `designRequestedAt` when the job ends. */
    designStage: text('design_stage'),
    /** Stamped when a photo-book design job (`design-photo-book`, worker/index.ts)
     *  completes — success OR the silent auto-layout fallback, either counts as "this
     *  book has been generated at least once". This is the photo-book builder's Step 2
     *  gate: null means show the config-only "not generated yet" view; non-null means
     *  show the live book (still editable/regeneratable). Distinct from
     *  `designRequestedAt`, which only tracks whether a pass is CURRENTLY in flight —
     *  `generatedAt` is never cleared by a later regeneration, it just gets bumped again.
     *  Always null for story books (no such gate exists for them). */
    generatedAt: timestamp('generated_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [index('books_chronicle_idx').on(t.chronicleId)],
);

/** The ordered story selection of a book. */
export const bookStories = pgTable(
  'book_stories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    includePhotos: boolean('include_photos').notNull().default(true),
    /** Whether this story's TEXT is part of the book (unified-book plan, PR A) — the
     *  counterpart of `includePhotos`. The pair gives each attached story four states:
     *  full chapter / text-only / photos-only (both off = detach it instead). Default
     *  true preserves every existing story book unchanged. Read by the unified layout
     *  pipeline from PR C onward; stored (and preserved across `setBookStories`
     *  replaces) from PR A. */
    includeText: boolean('include_text').notNull().default(true),
  },
  (t) => [
    uniqueIndex('book_stories_uq').on(t.bookId, t.storyId),
    index('book_stories_book_idx').on(t.bookId),
  ],
);

/**
 * One row per "Order at price" confirmation. v1 stops here: the admin is emailed
 * and handles payment/shipping personally. Stripe + Gelato submission come later.
 */
export const bookOrders = pgTable(
  'book_orders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'restrict' }),
    orderedBy: text('ordered_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /** Quote snapshot at order time — see BookQuote in lib/gelato.ts. */
    quote: jsonb('quote').notNull(),
    status: text('status').notNull().default('requested'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('book_orders_book_idx').on(t.bookId)],
);

/* ──────────────────────────────────────────────────────────────────────────
 * Photo books — per-photo state + analysis (docs/PHOTO_BOOK_PLAN.md §2/§4)
 * ────────────────────────────────────────────────────────────────────────── */

/** Vision-analysis lifecycle for one photo. PR1 leaves this at `pending` for every
 *  photo EXCEPT one interim case: `markPhotoMetaFailed` (`lib/photo-meta.ts`) sets it
 *  to `'failed'` when the deterministic `photo-meta` pass exhausts its retries on a
 *  genuinely undecodable photo, purely so the builder's analysis-progress poll can
 *  terminate instead of spinning forever. The `photo-vision` job that otherwise owns
 *  this column end-to-end is a later PR (PR3), which must treat that interim
 *  `'failed'` as "meta gave up", not as a vision result. */
export const photoAnalysisStatus = pgEnum('photo_analysis_status', [
  'pending',
  'analyzing',
  'done',
  'failed',
]);

/** One row per photo in a photo book: upload order, exclusion, and everything the
 *  `photo-meta`/`photo-vision` jobs discover about it. Hot fields the layouter/dedup
 *  need to query directly are real columns; the model's judgment (a later PR) lives in
 *  `analysis`. */
export const bookPhotos = pgTable(
  'book_photos',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    /** Provenance (unified-book plan, PR A): set when this row MIRRORS a photo of an
     *  attached story (`book_stories`), so every photo — uploaded or story-sourced —
     *  flows through the one analysis + layout pipeline. `null` = uploaded directly
     *  into the book. Mirror rows are inserted/removed by `syncStoryPhotoMirrors`
     *  (`lib/books.ts`) as stories are attached/detached; the
     *  cascade is belt-and-braces (deleting a story already cascades its assets, which
     *  cascades these rows via `asset_id`). */
    storyId: uuid('story_id').references(() => stories.id, { onDelete: 'cascade' }),
    /** Upload order — the fallback sort when EXIF has no capture time. */
    position: integer('position').notNull(),
    /** Excluded from the layout (auto: duplicate/blurry/eyes-closed, or user says so).
     *  Excluded ≠ deleted: the builder's tray shows them and they can be re-included. */
    excluded: boolean('excluded').notNull().default(false),
    /** 'duplicate' | 'blurry' | 'eyes-closed' | 'low-quality' | 'user' */
    excludedReason: text('excluded_reason'),
    /** The USER's own explicit choice, independent of `excluded`/`excludedReason` above —
     *  'include' | 'exclude' | null (null = no explicit choice, auto-culling decides).
     *  This is what makes a manual re-include stick: without it, `excluded` alone can't
     *  tell "the user asked for this photo back" apart from "never touched", so the next
     *  auto-layout rebuild (`buildAndPersistPhotoAutoPlan`) would re-cull a re-included
     *  duplicate/blurry photo right back to `excluded = true`. `'include'` makes a photo
     *  immune to auto-culling (duplicate/blurry/eyes-closed/low-quality) even if it would
     *  otherwise be culled; `'exclude'` keeps a photo out permanently, same as today.
     *  Written by `setPhotoExcluded` and the chat agent's `exclude_photo`/`include_photo`
     *  ops (`updatePhotoBookLayout`) — never by the auto-layouter or the AI design pass,
     *  which only ever READ it. */
    userDecision: text('user_decision'),
    /** EXIF capture metadata, extracted server-side (authoritative) by `photo-meta`. */
    takenAt: timestamp('taken_at'),
    gpsLat: doublePrecision('gps_lat'),
    gpsLng: doublePrecision('gps_lng'),
    /** Perceptual hash (dHash, hex) for near-duplicate clustering — pure code, no AI. */
    phash: text('phash'),
    /** Variance-of-Laplacian sharpness score — pure code, no AI; lower = blurrier. */
    blurScore: doublePrecision('blur_score'),
    analysisStatus: photoAnalysisStatus('analysis_status').notNull().default('pending'),
    /** AI vision result (later PR) — see PhotoAnalysis in lib/photo-analysis.ts. */
    analysis: jsonb('analysis'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('book_photos_book_asset_uq').on(t.bookId, t.assetId),
    index('book_photos_book_idx').on(t.bookId),
    index('book_photos_book_story_idx').on(t.bookId, t.storyId),
    /** By ASSET: the analysis passes write metadata/scores to every row of an asset,
     *  the thumbnail job probes "is this asset in any book", the mirror insert looks for
     *  an analysis donor, and the `stories` FK cascade deletes by story — none of which
     *  the book-leading indexes above can serve. */
    index('book_photos_asset_idx').on(t.assetId),
  ],
);
