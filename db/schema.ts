import {
  pgEnum,
  pgTable,
  text,
  boolean,
  timestamp,
  uuid,
  integer,
  jsonb,
  index,
  uniqueIndex,
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
    displayName: text('display_name').notNull(),
    givenName: text('given_name'),
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
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.id, { onDelete: 'cascade' }),
    /** The contribution this asset arrived with, for the source-material timeline. */
    contributionId: uuid('contribution_id').references(() => contributions.id, {
      onDelete: 'set null',
    }),
    kind: assetKind('kind').notNull(),
    s3Key: text('s3_key').notNull(),
    /** Downscaled WebP for grids/banners, written by the worker's `thumbnail` job. */
    thumbS3Key: text('thumb_s3_key'),
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
    // One story never holds the same object twice — an accepted draft re-run must
    // not duplicate the photos it already carried over.
    uniqueIndex('assets_story_key_uq').on(t.storyId, t.s3Key),
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

/** Trim sizes offered in the UI; each maps to a Gelato product UID (lib/gelato.ts). */
export const bookFormat = pgEnum('book_format', ['hardcover-21x28', 'hardcover-20x20']);

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
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    dedication: text('dedication'),
    /** Cover photo — one of the included stories' photo assets. */
    coverAssetId: uuid('cover_asset_id').references(() => assets.id, { onDelete: 'set null' }),
    format: bookFormat('format').notNull().default('hardcover-21x28'),
    status: bookStatus('status').notNull().default('draft'),
    errorMessage: text('error_message'),
    /** Set by the renderer: final padded page count of the print PDF. */
    pageCount: integer('page_count'),
    previewS3Key: text('preview_s3_key'),
    printS3Key: text('print_s3_key'),
    /** Layout plan (lib/book-layout-plan.ts) — what goes where; the renderer's input. */
    layoutPlan: jsonb('layout_plan'),
    /** Who last wrote layoutPlan: the heuristic auto-layouter, an AI pass, or a manual edit. */
    layoutSource: text('layout_source').notNull().default('auto'),
    /** Content changed since layoutPlan was made (paragraph counts/photos may no longer match). */
    layoutStale: boolean('layout_stale').notNull().default(false),
    /** Set when an AI design job is enqueued, cleared by the worker on completion (success
     *  or fallback) — lets the builder show a working state without hijacking `status`,
     *  which still tracks the print-proof PDF render lifecycle. */
    designRequestedAt: timestamp('design_requested_at'),
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
